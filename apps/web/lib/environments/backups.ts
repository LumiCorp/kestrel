import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  KestrelClient,
  KestrelSdkError,
  type KestrelRequestContext,
} from "@kestrel-agents/sdk/runner";
import { WORKSPACE_READINESS_TIMEOUT_SECONDS } from "@lumi/kestrel-environment-auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getStorageAdapter } from "@/lib/storage";
import { requireCurrentEnvironmentRuntime } from "./runtime-channel";
import {
  createWorkspaceBackupDecryptionStream,
  createWorkspaceBackupEncryptionStream,
} from "./backup-crypto";
import { selectWorkspaceBackupRetention } from "./backup-retention";
import {
  uploadBackupArchiveStream,
  waitForWorkspaceService,
} from "./backup-transfer";
import { WORKSPACE_BACKUP_RETENTION_DAYS } from "./contracts";
import {
  createEnvironmentMachineRoute,
  resolveEnvironmentExecutionRoute,
} from "./execution-route";
import { getHostedRoutingContractMode } from "./config";
import { refreshEnvironmentGateway } from "./gateway-refresh";
import { resolveFlyProviderClient } from "./provider-registry";
import {
  promoteEnvironmentProviderReplacementInTransaction,
  upsertEnvironmentProviderResource,
  upsertEnvironmentProviderResourceInTransaction,
} from "./provider-persistence";
import { resolveHostedRouteGeneration } from "./routing-authority";
import {
  createEnvironmentServiceToken,
  hashEnvironmentServiceToken,
} from "./service-tokens";
import { workspaceLifecycleLockKey } from "./lifecycle-lock";
import {
  performGuardedWorkspaceRestoreCutover,
  resolveWorkspaceBackupRecoverySource,
  resolveWorkspaceBackupSnapshotSourceVolumeId,
  selectPromotedWorkspaceRestoreReplay,
  WORKSPACE_RESTORE_ROUTE_CAPABILITIES,
  WorkspaceRestoreCasConflictError,
  workspaceRestoreResourceIdentities,
} from "./restore-cutover";
import {
  describeEnvironmentWorkerFailure,
  type EnvironmentWorkerAttempt,
} from "./worker-failure";
import {
  DAILY_BACKUP_MAX_ATTEMPTS,
  DAILY_BACKUP_RETRY_LIMIT,
  shouldPreserveTerminalDailyBackup,
  workspaceBackupRetryDelaySeconds,
  workspaceDailyBackupDay,
  workspaceDailyBackupIdempotencyKey,
} from "./daily-backup-contract";

const BACKUP_EXECUTION_OWNERSHIP_KEY = "backupExecutionOwnership";
const AUTOMATIC_BACKUP_RETENTION_DAYS = 14;
const CHECKPOINT_BACKUP_RETENTION_DAYS = 30;
const DEFAULT_WORKSPACE_PROFILE_ID = "kestrel";
type BackupExecutionOwnership = "parent_operation" | "queue";

export async function createWorkspaceBackup(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  actorUserId: string;
  reason: "checkpoint" | "daily" | "pre_destructive" | "pre_promotion";
  idempotencyKey?: string;
  signal?: AbortSignal | undefined;
  executionOwnership?: BackupExecutionOwnership | undefined;
  workerAttempt?: EnvironmentWorkerAttempt | undefined;
  parentLifecycleOperationId?: string | undefined;
  preDestructiveSnapshot?: { id: string; state: string } | undefined;
}) {
  const [environment, workspace, binding] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.environmentId),
          eq(table.organizationId, input.organizationId),
        ),
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.workspaceId),
          eq(table.environmentId, input.environmentId),
          eq(table.organizationId, input.organizationId),
        ),
    }),
    findActiveWorkspaceExecutionBinding(input),
  ]);
  if (
    !(
      environment?.flyAppName &&
      environment.region &&
      environment.providerConnectionId &&
      environment.routerUrl &&
      workspace?.flyVolumeId &&
      workspace.flyMachineId &&
      workspace.runtimeImage &&
      binding
    )
  ) {
    throw new Error("Workspace is not ready for backup.");
  }
  if (workspace.sourceType === "desktop") {
    throw new Error("Desktop Workspaces use Desktop-owned backup recovery.");
  }
  const providerConnectionId = environment.providerConnectionId;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + WORKSPACE_BACKUP_RETENTION_DAYS * 86_400_000,
  );
  const prepared = await prepareWorkspaceBackup({
    ...input,
    idempotencyKey:
      input.reason === "daily"
        ? (input.idempotencyKey ??
          workspaceDailyBackupIdempotencyKey(input.workspaceId, now))
        : input.idempotencyKey,
    now,
    expiresAt,
    executionOwnership: input.executionOwnership ?? "parent_operation",
  });
  if (prepared.available) return prepared.available;
  if (prepared.deferred) {
    return {
      backupId: prepared.backupId,
      operationId: prepared.operationId,
      status: "deferred" as const,
    };
  }
  const { operationId, backupId } = prepared;
  const provider = await resolveFlyProviderClient({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  let exportMachineId: string | null = null;
  let exportVolumeId: string | null = null;
  try {
    input.signal?.throwIfAborted();
    const snapshot = await provider.createVolumeSnapshot({
      appName: environment.flyAppName,
      volumeId: workspace.flyVolumeId,
    });
    await waitForWorkspaceSnapshot({
      snapshotId: snapshot.id,
      sourceVolumeId: workspace.flyVolumeId,
      appName: environment.flyAppName,
      isUsable: (snapshotInput) =>
        provider.isWorkspaceSnapshotUsable(snapshotInput),
      signal: input.signal,
    });
    const exportReplacementId = crypto.randomUUID();
    const exportVolume = await provider.createReplacementWorkspaceVolume({
      appName: environment.flyAppName,
      workspaceId: workspace.id,
      region: environment.region,
      replacementId: exportReplacementId,
      snapshotId: snapshot.id,
      sourceVolumeId: workspace.flyVolumeId,
    });
    exportVolumeId = exportVolume.id;
    const workspaceServiceToken = createEnvironmentServiceToken();
    const exportMachine = await provider.createReplacementWorkspaceMachine({
      appName: environment.flyAppName,
      environmentId: environment.id,
      organizationId: input.organizationId,
      workspaceId: workspace.id,
      volumeId: exportVolume.id,
      region: environment.region,
      runtimeImage: workspace.runtimeImage,
      ticketPublicKey:
        process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
      controlPlaneUrl: process.env.KESTREL_ONE_APP_URL ?? "",
      serviceToken: workspaceServiceToken,
      source: {
        type: workspace.sourceType,
        ...(workspace.sourceRepository
          ? { repository: workspace.sourceRepository }
          : {}),
        ...(workspace.sourceDefaultBranch
          ? { defaultBranch: workspace.sourceDefaultBranch }
          : {}),
      },
      idleTimeoutMinutes: environment.idleTimeoutMinutes,
      replacementId: exportReplacementId,
    });
    exportMachineId = exportMachine.id;
    if (exportMachine.state !== "started") {
      await provider.waitForMachine({
        appName: environment.flyAppName,
        machineId: exportMachine.id,
        state: "started",
        timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
      });
    }
    await provider.waitForMachineHealth({
      appName: environment.flyAppName,
      machineId: exportMachine.id,
      checkName: "workspace",
      timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
    });
    const route = createEnvironmentMachineRoute({
      organizationId: input.organizationId,
      environmentId: environment.id,
      workspaceId: workspace.id,
      threadId: binding.threadId,
      actorId: input.actorUserId,
      flyAppName: environment.flyAppName,
      flyMachineId: exportMachine.id,
      routerUrl: environment.routerUrl,
      capabilities: ["workspace.backups.export"],
    });
    const preparation = await prepareBackupExport(
      route.baseUrl,
      route.authToken,
      input.signal,
    );
    if (preparation) {
      const reusable = await findReusableWorkspaceBackup({
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        sourceRevision: preparation.sourceRevision,
        organizationId: input.organizationId,
        flyAppName: environment.flyAppName,
        flyVolumeId: workspace.flyVolumeId,
      });
      if (reusable) {
        const retainedUntil = await protectWorkspaceBackup({
          backupId: reusable.id,
          workspaceId: input.workspaceId,
          reason: input.reason,
          now,
        });
        await completeUnchangedWorkspaceBackup({
          operationId,
          duplicateBackupId: backupId,
          reusableBackupId: reusable.id,
          sourceRevision: preparation.sourceRevision,
          retainedUntil,
          reusableManifest: reusable.manifest,
          snapshotId: snapshot.id,
          snapshotSourceVolumeId: workspace.flyVolumeId,
        });
        return {
          backupId: reusable.id,
          objectKey: reusable.objectKey,
          snapshotId: snapshot.id,
          snapshotState: "created",
          expiresAt: retainedUntil,
          status: "unchanged" as const,
        };
      }
      const claimed = await claimWorkspaceBackupRevision({
        backupId,
        sourceRevision: preparation.sourceRevision,
      });
      if (!claimed) {
        const concurrent = await waitForReusableWorkspaceBackup({
          environmentId: input.environmentId,
          workspaceId: input.workspaceId,
          sourceRevision: preparation.sourceRevision,
          organizationId: input.organizationId,
          flyAppName: environment.flyAppName,
          flyVolumeId: workspace.flyVolumeId,
          signal: input.signal,
        });
        if (!concurrent) {
          throw Object.assign(
            new Error(
              "A concurrent backup of this Workspace revision has not completed yet.",
            ),
            { code: "WORKSPACE_BACKUP_REVISION_IN_PROGRESS" },
          );
        }
        const retainedUntil = await protectWorkspaceBackup({
          backupId: concurrent.id,
          workspaceId: input.workspaceId,
          reason: input.reason,
          now,
        });
        await completeUnchangedWorkspaceBackup({
          operationId,
          duplicateBackupId: backupId,
          reusableBackupId: concurrent.id,
          sourceRevision: preparation.sourceRevision,
          retainedUntil,
          reusableManifest: concurrent.manifest,
          snapshotId: snapshot.id,
          snapshotSourceVolumeId: workspace.flyVolumeId,
        });
        return {
          backupId: concurrent.id,
          objectKey: concurrent.objectKey,
          snapshotId: snapshot.id,
          snapshotState: "created",
          expiresAt: retainedUntil,
          status: "unchanged" as const,
        };
      }
    }
    const archive = await fetchPreparedBackupArchive(
      route.baseUrl,
      route.authToken,
      preparation?.preparationId,
      input.signal,
    );
    input.signal?.throwIfAborted();
    const archiveHash = createHash("sha256");
    let archiveBytes = 0;
    const checksumStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        archiveHash.update(chunk);
        archiveBytes += chunk.length;
        callback(null, chunk);
      },
    });
    const storage = getStorageAdapter();
    const objectKey = storage.buildObjectKey(
      "workspace-backups",
      input.organizationId,
      input.workspaceId,
      `${backupId}.kwb2`,
    );
    await storage.putObjectStream({
      key: objectKey,
      body: archive
        .pipe(checksumStream)
        .pipe(createWorkspaceBackupEncryptionStream(backupKey())),
      contentType: "application/octet-stream",
      metadata: {
        workspaceId: input.workspaceId,
        encryptionKeyId: backupKeyId(),
        format: "KWB2",
      },
    });
    const checksumSha256 = archiveHash.digest("hex");
    input.signal?.throwIfAborted();
    const completedAt = new Date();
    await knowledgeDb.transaction(async (transaction) => {
      await upsertEnvironmentProviderResourceInTransaction(transaction, {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        providerConnectionId,
        provider: "fly",
        resourceRole: "snapshot",
        externalId: snapshot.id,
        providerUid: null,
        desiredRevision: backupId,
        observedGeneration: snapshot.id,
        state: "created",
        providerMetadata: {
          contract: "provider-resource-metadata-v1",
          source: "provider_observation",
        },
      });
      await transaction
        .update(schema.workspaceBackups)
        .set({
          status: "available",
          objectKey,
          encryptionKeyId: backupKeyId(),
          checksumSha256,
          sizeBytes: preparation?.logicalBytes ?? archiveBytes,
          sourceRevision: preparation?.sourceRevision ?? null,
          manifest: {
            backupFormat: "KWB2",
            archiveBytes,
            logicalBytes: preparation?.logicalBytes ?? null,
            entryCount: preparation?.entryCount ?? null,
            flySnapshotId: snapshot.id,
            flySnapshotState: "created",
            flySnapshotSourceVolumeId: workspace.flyVolumeId,
            ...(input.preDestructiveSnapshot
              ? {
                  preDestructiveFlySnapshotId: input.preDestructiveSnapshot.id,
                  preDestructiveFlySnapshotState:
                    input.preDestructiveSnapshot.state,
                }
              : {}),
          },
          updatedAt: completedAt,
        })
        .where(eq(schema.workspaceBackups.id, backupId));
      await transaction
        .update(schema.environmentOperations)
        .set({
          status: "completed",
          stage: "workspace.backup.available",
          result: {
            backupId,
            objectKey,
            flySnapshotId: snapshot.id,
            flySnapshotState: "created",
          },
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(schema.environmentOperations.id, operationId));
      await upsertBackupProtection(transaction, {
        backupId,
        reason: input.reason,
        expiresAt: protectionExpiry(input.reason, completedAt),
        now: completedAt,
      });
    });
    const retainedUntil = await enforceWorkspaceBackupRetention({
      workspaceId: input.workspaceId,
      currentBackupId: backupId,
      now: completedAt,
      supersedeAutomatic: input.reason !== "checkpoint",
    });
    return {
      backupId,
      objectKey,
      snapshotId: snapshot.id,
      snapshotState: "created",
      expiresAt: retainedUntil,
    };
  } catch (error) {
    const interrupted = input.signal?.aborted === true;
    const failure = describeEnvironmentWorkerFailure({
      error,
      fallbackCode: interrupted
        ? "WORKSPACE_BACKUP_WORKER_INTERRUPTED"
        : "WORKSPACE_BACKUP_FAILED",
      fallbackMessage: interrupted
        ? "The Workspace backup worker stopped before the export completed."
        : "Workspace backup failed.",
    });
    await persistWorkspaceBackupAttemptFailure({
      operationId,
      backupId,
      attempt: input.workerAttempt,
      maxAttempts: DAILY_BACKUP_MAX_ATTEMPTS,
      retryable: !isDeterministicBackupFailure(failure.code),
      code: failure.code,
      message: failure.message,
    });
    throw error;
  } finally {
    if (exportMachineId) {
      await provider
        .deleteMachine({
          appName: environment.flyAppName,
          machineId: exportMachineId,
        })
        .catch(() => {});
    }
    if (exportVolumeId) {
      await provider
        .deleteVolume({
          appName: environment.flyAppName,
          volumeId: exportVolumeId,
        })
        .catch(() => {});
    }
  }
}

export async function queueWorkspaceBackup(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  actorUserId: string;
  reason: "checkpoint" | "daily" | "pre_destructive" | "pre_promotion";
  idempotencyKey?: string | undefined;
}) {
  await assertWorkspaceBackupReady(input);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + WORKSPACE_BACKUP_RETENTION_DAYS * 86_400_000,
  );
  const prepared = await prepareWorkspaceBackup({
    ...input,
    idempotencyKey:
      input.reason === "daily"
        ? (input.idempotencyKey ??
          workspaceDailyBackupIdempotencyKey(input.workspaceId, now))
        : input.idempotencyKey,
    now,
    expiresAt,
    initialStatus: "queued",
    executionOwnership: "queue",
  });
  if (prepared.available) {
    return { ...prepared.available, status: "available" as const };
  }
  if (prepared.failed) {
    return {
      backupId: prepared.backupId,
      operationId: prepared.operationId,
      status: "failed" as const,
      expiresAt,
    };
  }
  const { enqueueEnvironmentOperation } = await import("@/lib/knowledge/queue");
  await enqueueEnvironmentOperation(prepared.operationId, {
    retryLimit: DAILY_BACKUP_RETRY_LIMIT,
  });
  return {
    backupId: prepared.backupId,
    operationId: prepared.operationId,
    status: "queued" as const,
    expiresAt,
  };
}

export async function retryFailedDailyWorkspaceBackup(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  backupId: string;
}) {
  const [backup] = await knowledgeDb
    .select({
      backup: schema.workspaceBackups,
      operation: schema.environmentOperations,
    })
    .from(schema.workspaceBackups)
    .innerJoin(
      schema.environmentOperations,
      eq(schema.environmentOperations.id, schema.workspaceBackups.operationId),
    )
    .where(
      and(
        eq(schema.workspaceBackups.id, input.backupId),
        eq(schema.workspaceBackups.organizationId, input.organizationId),
        eq(schema.workspaceBackups.environmentId, input.environmentId),
        eq(schema.workspaceBackups.workspaceId, input.workspaceId),
        eq(schema.workspaceBackups.reason, "daily"),
        eq(schema.workspaceBackups.status, "failed"),
        eq(schema.environmentOperations.status, "failed"),
      ),
    )
    .limit(1);
  if (!backup) throw new Error("Failed daily Workspace backup was not found.");
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .update(schema.environmentOperations)
      .set({
        status: "queued",
        stage: "workspace.backup.queued",
        attempt: 0,
        result: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        input: {
          ...asRecord(backup.operation.input),
          manualRetry: {
            count:
              Number(
                asRecord(asRecord(backup.operation.input)?.manualRetry)
                  ?.count ?? 0,
              ) + 1,
            requestedAt: now.toISOString(),
          },
        },
        updatedAt: now,
      })
      .where(eq(schema.environmentOperations.id, backup.operation.id));
    await transaction
      .update(schema.workspaceBackups)
      .set({ status: "queued", updatedAt: now })
      .where(eq(schema.workspaceBackups.id, backup.backup.id));
  });
  const { enqueueEnvironmentOperation } = await import("@/lib/knowledge/queue");
  await enqueueEnvironmentOperation(backup.operation.id, {
    retryLimit: DAILY_BACKUP_RETRY_LIMIT,
  });
  return {
    backupId: backup.backup.id,
    operationId: backup.operation.id,
    status: "queued" as const,
  };
}

export async function processQueuedWorkspaceBackup(input: {
  operationId: string;
  signal?: AbortSignal | undefined;
  workerAttempt: EnvironmentWorkerAttempt;
}) {
  const operation = await knowledgeDb.query.environmentOperations.findFirst({
    where: (table, { eq }) => eq(table.id, input.operationId),
  });
  if (!operation || operation.type !== "workspace.backup") {
    return "not_claimed" as const;
  }
  if (
    operation.status === "completed" ||
    operation.status === "cancelled" ||
    (operation.status === "failed" && !input.workerAttempt.canRetry)
  ) {
    return "not_claimed" as const;
  }
  const backup = await knowledgeDb.query.workspaceBackups.findFirst({
    where: (table, { eq }) => eq(table.operationId, operation.id),
  });
  if (!backup) {
    await failWorkspaceBackupWorkerBoundary({
      operationId: operation.id,
      code: "WORKSPACE_BACKUP_RECORD_MISSING",
      message: "Queued Workspace backup is missing its backup record.",
    });
    throw Object.assign(
      new Error("Queued Workspace backup is missing its backup record."),
      { code: "WORKSPACE_BACKUP_RECORD_MISSING" },
    );
  }
  if (!operation.requestedByUserId) {
    await failWorkspaceBackupWorkerBoundary({
      operationId: operation.id,
      backupId: backup.id,
      code: "WORKSPACE_BACKUP_ACTOR_MISSING",
      message: "Queued Workspace backup is missing its requesting actor.",
    });
    return "interrupted" as const;
  }
  try {
    const result = await createWorkspaceBackup({
      organizationId: operation.organizationId,
      environmentId: operation.environmentId,
      workspaceId: backup.workspaceId,
      actorUserId: operation.requestedByUserId,
      reason: backup.reason,
      idempotencyKey: operation.idempotencyKey,
      signal: input.signal,
      executionOwnership: "queue",
      workerAttempt: input.workerAttempt,
    });
    if ("status" in result && result.status === "deferred") {
      return "deferred" as const;
    }
    console.info("Workspace backup lifecycle outcome.", {
      operationId: operation.id,
      workspaceId: backup.workspaceId,
      ...workspaceBackupOutcomeCounters(
        "status" in result && result.status === "unchanged"
          ? "reused"
          : "created",
      ),
    });
    return "processed" as const;
  } catch (error) {
    const code = asErrorCode(error);
    if (code === "WORKSPACE_BACKUP_TOO_LARGE") {
      console.info("Workspace backup lifecycle outcome.", {
        operationId: operation.id,
        workspaceId: backup.workspaceId,
        ...workspaceBackupOutcomeCounters("oversized"),
      });
    }
    const deferred = await knowledgeDb.query.environmentOperations.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.id, operation.id), eq(table.status, "queued")),
      columns: { id: true },
    });
    if (deferred) return "deferred" as const;
    if (code && isDeterministicBackupFailure(code)) {
      return "processed" as const;
    }
    throw error;
  }
}

export function workspaceBackupOutcomeCounters(
  outcome: "created" | "reused" | "oversized",
) {
  return {
    inspected: 1,
    unchanged: outcome === "reused" ? 1 : 0,
    created: outcome === "created" ? 1 : 0,
    reused: outcome === "reused" ? 1 : 0,
    expired: 0,
    deletionFailed: 0,
    oversized: outcome === "oversized" ? 1 : 0,
  };
}

export async function failInterruptedWorkspaceBackup(operationId: string) {
  const failedAt = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    const operation = await transaction.query.environmentOperations.findFirst({
      where: (table, { eq }) => eq(table.id, operationId),
      columns: { input: true },
    });
    if (isParentOwnedWorkspaceBackup(operation?.input)) return;
    const [failedOperation] = await transaction
      .update(schema.environmentOperations)
      .set({
        status: "failed",
        stage: "workspace.backup.interrupted",
        errorCode: "WORKSPACE_BACKUP_WORKER_INTERRUPTED",
        errorMessage:
          "The Workspace backup worker stopped before the export completed. Start a new backup.",
        completedAt: failedAt,
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(schema.environmentOperations.id, operationId),
          eq(schema.environmentOperations.status, "running"),
        ),
      )
      .returning({ id: schema.environmentOperations.id });
    if (!failedOperation) return;
    await transaction
      .update(schema.workspaceBackups)
      .set({ status: "failed", updatedAt: failedAt })
      .where(eq(schema.workspaceBackups.operationId, operationId));
  });
}

export async function failExhaustedWorkspaceBackup(operationId: string) {
  await failWorkspaceBackupWorkerBoundary({
    operationId,
    code: "WORKSPACE_BACKUP_RETRIES_EXHAUSTED",
    message:
      "The Workspace backup worker exhausted its queue retries before the operation completed.",
  });
}

export function isParentOwnedWorkspaceBackup(value: unknown) {
  return (
    asRecord(value)?.[BACKUP_EXECUTION_OWNERSHIP_KEY] === "parent_operation"
  );
}

export async function reconcileTerminalWorkspaceBackupRecords() {
  const activeBackups = await knowledgeDb.query.workspaceBackups.findMany({
    where: (table, { and, inArray, isNotNull }) =>
      and(
        inArray(table.status, ["queued", "creating"]),
        isNotNull(table.operationId),
      ),
    columns: { id: true, operationId: true },
    limit: 100,
  });
  const operationIds = activeBackups.flatMap((backup) =>
    backup.operationId ? [backup.operationId] : [],
  );
  if (operationIds.length === 0) return 0;
  const terminalOperations =
    await knowledgeDb.query.environmentOperations.findMany({
      where: (table, { and, inArray }) =>
        and(
          inArray(table.id, operationIds),
          inArray(table.status, ["failed", "cancelled"]),
        ),
      columns: { id: true },
    });
  const terminalIds = new Set(
    terminalOperations.map((operation) => operation.id),
  );
  const backupIds = activeBackups
    .filter(
      (backup) => backup.operationId && terminalIds.has(backup.operationId),
    )
    .map((backup) => backup.id);
  if (backupIds.length === 0) return 0;
  const repairedAt = new Date();
  const repaired = await knowledgeDb
    .update(schema.workspaceBackups)
    .set({ status: "failed", updatedAt: repairedAt })
    .where(
      and(
        inArray(schema.workspaceBackups.id, backupIds),
        inArray(schema.workspaceBackups.status, ["queued", "creating"]),
      ),
    )
    .returning({ id: schema.workspaceBackups.id });
  return repaired.length;
}

type PreparedWorkspaceBackup =
  | {
      available: {
        backupId: string;
        objectKey: string;
        snapshotId: string | null;
        snapshotState: string;
        expiresAt: Date;
      };
    }
  | {
      available: null;
      failed: false;
      deferred: boolean;
      operationId: string;
      backupId: string;
    }
  | {
      available: null;
      failed: true;
      deferred: false;
      operationId: string;
      backupId: string;
    };

type WorkspaceBackupTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

function protectionExpiry(
  reason: "checkpoint" | "daily" | "pre_destructive" | "pre_promotion",
  now: Date,
) {
  const days =
    reason === "checkpoint"
      ? CHECKPOINT_BACKUP_RETENTION_DAYS
      : AUTOMATIC_BACKUP_RETENTION_DAYS;
  return new Date(now.getTime() + days * 86_400_000);
}

async function upsertBackupProtection(
  transaction: WorkspaceBackupTransaction,
  input: {
    backupId: string;
    reason: "checkpoint" | "daily" | "pre_destructive" | "pre_promotion";
    expiresAt: Date;
    now: Date;
  },
) {
  await transaction
    .insert(schema.workspaceBackupProtections)
    .values({
      id: crypto.randomUUID(),
      backupId: input.backupId,
      kind: input.reason,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.workspaceBackupProtections.backupId,
        schema.workspaceBackupProtections.kind,
      ],
      set: { createdAt: input.now, expiresAt: input.expiresAt },
    });
}

async function protectWorkspaceBackup(input: {
  backupId: string;
  workspaceId: string;
  reason: "checkpoint" | "daily" | "pre_destructive" | "pre_promotion";
  now: Date;
}) {
  await knowledgeDb.transaction(async (transaction) => {
    await upsertBackupProtection(transaction, {
      backupId: input.backupId,
      reason: input.reason,
      expiresAt: protectionExpiry(input.reason, input.now),
      now: input.now,
    });
  });
  return enforceWorkspaceBackupRetention({
    workspaceId: input.workspaceId,
    currentBackupId: input.backupId,
    now: input.now,
    supersedeAutomatic: false,
  });
}

async function enforceWorkspaceBackupRetention(input: {
  workspaceId: string;
  currentBackupId: string;
  now: Date;
  supersedeAutomatic: boolean;
}) {
  const protections = await knowledgeDb
    .select({
      id: schema.workspaceBackupProtections.id,
      backupId: schema.workspaceBackupProtections.backupId,
      kind: schema.workspaceBackupProtections.kind,
      expiresAt: schema.workspaceBackupProtections.expiresAt,
      protectionCreatedAt: schema.workspaceBackupProtections.createdAt,
    })
    .from(schema.workspaceBackupProtections)
    .innerJoin(
      schema.workspaceBackups,
      eq(
        schema.workspaceBackupProtections.backupId,
        schema.workspaceBackups.id,
      ),
    )
    .where(eq(schema.workspaceBackups.workspaceId, input.workspaceId))
    .orderBy(desc(schema.workspaceBackupProtections.createdAt));
  const {
    supersededAutomaticProtectionIds,
    expiredProtectionIds,
    retainedUntil,
  } = selectWorkspaceBackupRetention({
    protectionsNewestFirst: protections,
    currentBackupId: input.currentBackupId,
    now: input.now,
    supersedeAutomatic: input.supersedeAutomatic,
  });
  if (supersededAutomaticProtectionIds.length > 0) {
    await knowledgeDb
      .update(schema.workspaceBackupProtections)
      .set({
        expiresAt: new Date(
          input.now.getTime() + AUTOMATIC_BACKUP_RETENTION_DAYS * 86_400_000,
        ),
      })
      .where(
        inArray(
          schema.workspaceBackupProtections.id,
          supersededAutomaticProtectionIds,
        ),
      );
  }
  if (expiredProtectionIds.length > 0) {
    await knowledgeDb
      .delete(schema.workspaceBackupProtections)
      .where(
        inArray(schema.workspaceBackupProtections.id, expiredProtectionIds),
      );
  }
  await knowledgeDb
    .update(schema.workspaceBackups)
    .set({ expiresAt: retainedUntil, updatedAt: input.now })
    .where(eq(schema.workspaceBackups.id, input.currentBackupId));
  return retainedUntil;
}

async function findReusableWorkspaceBackup(input: {
  environmentId: string;
  workspaceId: string;
  sourceRevision: string;
  organizationId: string;
  flyAppName: string;
  flyVolumeId: string;
}) {
  const backup = await knowledgeDb.query.workspaceBackups.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.workspaceId, input.workspaceId),
        eq(table.sourceRevision, input.sourceRevision),
        eq(table.status, "available"),
      ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
  if (!backup) return null;
  if (
    backup.objectKey &&
    (await getStorageAdapter().objectExists(backup.objectKey))
  ) {
    return backup;
  }
  const snapshotId = readString(asRecord(backup.manifest)?.flySnapshotId);
  if (!snapshotId) return null;
  const provider = await resolveFlyProviderClient({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  const usable = await provider.isWorkspaceSnapshotUsable({
    appName: input.flyAppName,
    sourceVolumeId:
      readString(asRecord(backup.manifest)?.flySnapshotSourceVolumeId) ??
      input.flyVolumeId,
    snapshotId,
  });
  return usable ? backup : null;
}

async function claimWorkspaceBackupRevision(input: {
  backupId: string;
  sourceRevision: string;
}) {
  try {
    const [claimed] = await knowledgeDb
      .update(schema.workspaceBackups)
      .set({ sourceRevision: input.sourceRevision, updatedAt: new Date() })
      .where(eq(schema.workspaceBackups.id, input.backupId))
      .returning({ id: schema.workspaceBackups.id });
    return Boolean(claimed);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
}

async function waitForReusableWorkspaceBackup(
  input: Parameters<typeof findReusableWorkspaceBackup>[0] & {
    signal?: AbortSignal | undefined;
  },
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    const backup = await findReusableWorkspaceBackup(input);
    if (backup) return backup;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function completeUnchangedWorkspaceBackup(input: {
  operationId: string;
  duplicateBackupId: string;
  reusableBackupId: string;
  sourceRevision: string;
  retainedUntil: Date;
  reusableManifest: unknown;
  snapshotId: string;
  snapshotSourceVolumeId: string;
}) {
  const completedAt = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .update(schema.environmentOperations)
      .set({
        status: "completed",
        stage: "workspace.backup.unchanged",
        result: {
          backupId: input.reusableBackupId,
          sourceRevision: input.sourceRevision,
          unchanged: true,
          retainedUntil: input.retainedUntil.toISOString(),
        },
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(schema.environmentOperations.id, input.operationId));
    await transaction
      .update(schema.workspaceBackups)
      .set({
        manifest: {
          ...asRecord(input.reusableManifest),
          flySnapshotId: input.snapshotId,
          flySnapshotState: "created",
          flySnapshotSourceVolumeId: input.snapshotSourceVolumeId,
        },
        updatedAt: completedAt,
      })
      .where(eq(schema.workspaceBackups.id, input.reusableBackupId));
    await transaction
      .update(schema.workspaceBackups)
      .set({
        status: "expired",
        sourceRevision: null,
        expiresAt: completedAt,
        manifest: {
          unchanged: true,
          reusedBackupId: input.reusableBackupId,
          sourceRevision: input.sourceRevision,
        },
        updatedAt: completedAt,
      })
      .where(eq(schema.workspaceBackups.id, input.duplicateBackupId));
  });
}

async function prepareWorkspaceBackup(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  actorUserId: string;
  reason: "checkpoint" | "daily" | "pre_destructive" | "pre_promotion";
  idempotencyKey?: string;
  now: Date;
  expiresAt: Date;
  initialStatus?: "queued" | "running" | undefined;
  executionOwnership: BackupExecutionOwnership;
  workerAttempt?: EnvironmentWorkerAttempt | undefined;
}): Promise<PreparedWorkspaceBackup> {
  const requestedKey = input.idempotencyKey?.trim();
  if (requestedKey) {
    const existingOperation =
      await knowledgeDb.query.environmentOperations.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.idempotencyKey, requestedKey),
          ),
      });
    if (existingOperation) {
      const existingBackup = await knowledgeDb.query.workspaceBackups.findFirst(
        {
          where: (table, { eq }) => eq(table.operationId, existingOperation.id),
        },
      );
      if (!existingBackup) {
        throw new Error(
          "Idempotent Workspace backup operation is missing its backup record.",
        );
      }
      if (
        existingOperation.status === "completed" &&
        existingBackup.status === "available" &&
        existingBackup.objectKey
      ) {
        const manifest = asRecord(existingBackup.manifest);
        return {
          available: {
            backupId: existingBackup.id,
            objectKey: existingBackup.objectKey,
            snapshotId: readString(manifest?.flySnapshotId),
            snapshotState:
              readString(manifest?.flySnapshotState) ?? "not_requested",
            expiresAt: existingBackup.expiresAt,
          },
        };
      }
      if (
        shouldPreserveTerminalDailyBackup({
          reason: input.reason,
          operationStatus: existingOperation.status,
        })
      ) {
        return {
          available: null,
          failed: true,
          deferred: false,
          operationId: existingOperation.id,
          backupId: existingBackup.id,
        };
      }
      await knowledgeDb.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(input.workspaceId)}, 0))`,
        );
        await transaction
          .update(schema.environmentOperations)
          .set({
            status: input.initialStatus ?? "running",
            stage:
              input.initialStatus === "queued"
                ? "workspace.backup.queued"
                : "workspace.backup.exporting",
            errorCode: null,
            errorMessage: null,
            completedAt: null,
            startedAt: input.initialStatus === "queued" ? null : input.now,
            ...(input.workerAttempt
              ? {
                  attempt: sql`${schema.environmentOperations.attempt} + 1`,
                }
              : {}),
            input: {
              ...asRecord(existingOperation.input),
              [BACKUP_EXECUTION_OWNERSHIP_KEY]: input.executionOwnership,
            },
            updatedAt: input.now,
          })
          .where(eq(schema.environmentOperations.id, existingOperation.id));
        await transaction
          .update(schema.workspaceBackups)
          .set({
            status: input.initialStatus === "queued" ? "queued" : "creating",
            objectKey: null,
            encryptionKeyId: null,
            checksumSha256: null,
            sizeBytes: null,
            manifest: null,
            expiresAt: input.expiresAt,
            updatedAt: input.now,
          })
          .where(eq(schema.workspaceBackups.id, existingBackup.id));
      });
      return {
        available: null,
        failed: false,
        deferred: false,
        operationId: existingOperation.id,
        backupId: existingBackup.id,
      };
    }
  }
  const operationId = crypto.randomUUID();
  const backupId = crypto.randomUUID();
  const initialStatus = input.initialStatus ?? "running";
  let racedExistingOperation = false;
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(input.workspaceId)}, 0))`,
    );
    if (requestedKey) {
      const existing = await transaction.query.environmentOperations.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.idempotencyKey, requestedKey),
          ),
        columns: { id: true },
      });
      if (existing) {
        racedExistingOperation = true;
        return;
      }
    }
    await transaction.insert(schema.environmentOperations).values({
      id: operationId,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      requestedByUserId: input.actorUserId,
      type: "workspace.backup",
      status: initialStatus,
      stage:
        initialStatus === "queued"
          ? "workspace.backup.queued"
          : "workspace.backup.exporting",
      idempotencyKey: requestedKey ?? `workspace.backup:${backupId}`,
      input: {
        [BACKUP_EXECUTION_OWNERSHIP_KEY]: input.executionOwnership,
        ...(input.reason === "daily"
          ? {
              dailyBackup: {
                utcDay: workspaceDailyBackupDay(input.now),
                maxAttempts: DAILY_BACKUP_MAX_ATTEMPTS,
                retryOwnership: "queue",
              },
            }
          : {}),
      },
      attempt: input.workerAttempt?.attempt ?? 0,
      startedAt: initialStatus === "running" ? input.now : null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await transaction.insert(schema.workspaceBackups).values({
      id: backupId,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      operationId,
      reason: input.reason,
      status: initialStatus === "queued" ? "queued" : "creating",
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    });
  });
  if (racedExistingOperation) {
    return prepareWorkspaceBackup(input);
  }
  return {
    available: null,
    failed: false,
    deferred: false,
    operationId,
    backupId,
  };
}

async function persistWorkspaceBackupAttemptFailure(input: {
  operationId: string;
  backupId: string;
  attempt?: EnvironmentWorkerAttempt | undefined;
  maxAttempts?: number | undefined;
  code: string;
  message: string;
  retryable: boolean;
}) {
  const failedAt = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    const operation = await transaction.query.environmentOperations.findFirst({
      where: (table, { eq }) => eq(table.id, input.operationId),
      columns: { attempt: true },
    });
    const willRetry =
      input.retryable &&
      (input.maxAttempts
        ? (operation?.attempt ?? 0) < input.maxAttempts
        : input.attempt?.canRetry === true);
    const delaySeconds = workspaceBackupRetryDelaySeconds(
      operation?.attempt ?? 1,
    );
    await transaction
      .update(schema.workspaceBackups)
      .set({
        status: willRetry ? "queued" : "failed",
        updatedAt: failedAt,
      })
      .where(eq(schema.workspaceBackups.id, input.backupId));
    await transaction
      .update(schema.environmentOperations)
      .set({
        status: willRetry ? "queued" : "failed",
        stage: willRetry
          ? "workspace.backup.retrying"
          : "workspace.backup.failed",
        errorCode: input.code,
        errorMessage: input.message,
        result: willRetry
          ? {
              retryState: {
                attempt: operation?.attempt ?? 1,
                nextAttemptAt: new Date(
                  failedAt.getTime() + delaySeconds * 1000,
                ).toISOString(),
                lastError: { code: input.code, message: input.message },
              },
            }
          : undefined,
        completedAt: willRetry ? null : failedAt,
        updatedAt: failedAt,
      })
      .where(eq(schema.environmentOperations.id, input.operationId));
  });
}

export function isDeterministicBackupFailure(code: string) {
  return new Set([
    "WORKSPACE_BACKUP_TOO_LARGE",
    "WORKSPACE_CHANGED_DURING_BACKUP",
    "WORKSPACE_BACKUP_CHECKSUM_MISMATCH",
    "WORKSPACE_BACKUP_PREPARATION_UNAVAILABLE",
    "WORKSPACE_BACKUP_CAPACITY_INVALID",
    "WORKSPACE_BACKUP_PORTABLE_STATE_INVALID",
    "ENVIRONMENT_ROUTE_FORBIDDEN",
    "ENVIRONMENT_ROUTE_UNAUTHORIZED",
  ]).has(code);
}

export async function waitForWorkspaceSnapshot(input: {
  appName: string;
  sourceVolumeId: string;
  snapshotId: string;
  isUsable: (snapshotInput: {
    appName: string;
    sourceVolumeId: string;
    snapshotId: string;
  }) => Promise<boolean>;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
}) {
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  while (true) {
    input.signal?.throwIfAborted();
    if (
      await input.isUsable({
        appName: input.appName,
        sourceVolumeId: input.sourceVolumeId,
        snapshotId: input.snapshotId,
      })
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw Object.assign(
        new Error("Fly Workspace snapshot was not ready for archive export."),
        { code: "WORKSPACE_BACKUP_SNAPSHOT_NOT_READY" },
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, input.pollIntervalMs ?? 500),
    );
  }
}

function asErrorCode(error: unknown) {
  return typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : undefined;
}

async function failWorkspaceBackupWorkerBoundary(input: {
  operationId: string;
  backupId?: string | undefined;
  code: string;
  message: string;
}) {
  const failedAt = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    const [failedOperation] = await transaction
      .update(schema.environmentOperations)
      .set({
        status: "failed",
        stage: "workspace.backup.failed",
        errorCode: input.code,
        errorMessage: input.message,
        completedAt: failedAt,
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(schema.environmentOperations.id, input.operationId),
          inArray(schema.environmentOperations.status, ["queued", "running"]),
        ),
      )
      .returning({ id: schema.environmentOperations.id });
    if (!failedOperation) return;
    await transaction
      .update(schema.workspaceBackups)
      .set({ status: "failed", updatedAt: failedAt })
      .where(
        input.backupId
          ? eq(schema.workspaceBackups.id, input.backupId)
          : eq(schema.workspaceBackups.operationId, input.operationId),
      );
  });
}

export async function listWorkspaceBackups(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
}) {
  const backups = await knowledgeDb.query.workspaceBackups.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        eq(table.workspaceId, input.workspaceId),
      ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
  const visible = backups.filter((backup) =>
    ["available", "failed", "delete_failed"].includes(backup.status),
  );
  const now = new Date();
  const protections = visible.length
    ? await knowledgeDb.query.workspaceBackupProtections.findMany({
        where: (table, { and, gt, inArray }) =>
          and(
            inArray(
              table.backupId,
              visible.map((backup) => backup.id),
            ),
            gt(table.expiresAt, now),
          ),
        orderBy: (table, { desc }) => [desc(table.expiresAt)],
      })
    : [];
  const operationIds = visible.flatMap((backup) =>
    backup.operationId ? [backup.operationId] : [],
  );
  const operations = operationIds.length
    ? await knowledgeDb.query.environmentOperations.findMany({
        where: (table, { inArray }) => inArray(table.id, operationIds),
        columns: { id: true, errorCode: true, errorMessage: true },
      })
    : [];
  const protectedVisible = visible.filter(
    (backup) =>
      backup.status !== "available" ||
      protections.some((protection) => protection.backupId === backup.id),
  );
  const [environment, workspace] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { eq }) => eq(table.id, input.environmentId),
      columns: { flyAppName: true },
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { eq }) => eq(table.id, input.workspaceId),
      columns: { flyVolumeId: true },
    }),
  ]);
  const storage = getStorageAdapter();
  const provider = environment?.flyAppName
    ? await resolveFlyProviderClient({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
      }).catch(() => null)
    : null;
  return Promise.all(protectedVisible.map(async (backup) => {
    const activeProtections = protections.filter(
      (protection) => protection.backupId === backup.id,
    );
    const manifest = asRecord(backup.manifest);
    const snapshotId = readString(manifest?.flySnapshotId);
    const archiveRecoveryAvailable = backup.objectKey
      ? await storage.objectExists(backup.objectKey).catch(() => false)
      : false;
    const snapshotRecoveryAvailable =
      provider &&
      environment?.flyAppName &&
      workspace?.flyVolumeId &&
      snapshotId
        ? await provider
            .isWorkspaceSnapshotUsable({
              appName: environment.flyAppName,
              sourceVolumeId:
                readString(manifest?.flySnapshotSourceVolumeId) ??
                workspace.flyVolumeId,
              snapshotId,
            })
            .catch(() => false)
        : false;
    return {
      ...backup,
      protectionReasons: [
        ...new Set(activeProtections.map((item) => item.kind)),
      ],
      retainedUntil: activeProtections[0]?.expiresAt ?? backup.expiresAt,
      archiveRecoveryAvailable,
      snapshotRecoveryAvailable,
      failure:
        operations.find((operation) => operation.id === backup.operationId) ??
        null,
    };
  }));
}

export async function restoreWorkspaceBackup(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  backupId: string;
  actorUserId: string;
  validationThreadId?: string | undefined;
}) {
  const [backup, environment, workspace, binding, resumableOperations] = await Promise.all([
    knowledgeDb.query.workspaceBackups.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.backupId),
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          eq(table.workspaceId, input.workspaceId),
          eq(table.status, "available"),
        ),
    }),
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.environmentId),
          eq(table.organizationId, input.organizationId),
        ),
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.workspaceId),
          eq(table.environmentId, input.environmentId),
          eq(table.organizationId, input.organizationId),
        ),
    }),
    findActiveWorkspaceExecutionBinding(input),
    knowledgeDb.query.environmentOperations.findMany({
      where: (table, { and, eq, inArray }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          eq(table.workspaceId, input.workspaceId),
          eq(table.type, "workspace.restore"),
          inArray(table.status, ["running", "failed"]),
        ),
      orderBy: (table, { desc }) => [desc(table.updatedAt)],
      limit: 10,
    }),
  ]);
  if (!backup) {
    throw new Error("Workspace backup is unavailable.");
  }
  if (
    !(
      environment?.flyAppName &&
      environment.region &&
      environment.providerConnectionId &&
      environment.runtimeImage &&
      environment.routerUrl &&
      workspace?.flyMachineId &&
      workspace.flyVolumeId &&
      binding
    )
  ) {
    throw new Error("Workspace replacement target is unavailable.");
  }
  if (workspace.sourceType === "desktop") {
    throw new Error(
      "Desktop workspaces are restored on the enrolled Desktop Environment.",
    );
  }
  const flyAppName = environment.flyAppName;
  const providerConnectionId = environment.providerConnectionId;
  const routerUrl = environment.routerUrl;
  const oldMachineId = workspace.flyMachineId;
  const oldVolumeId = workspace.flyVolumeId;
  const snapshotSourceVolumeId = resolveWorkspaceBackupSnapshotSourceVolumeId({
    manifest: backup.manifest,
    currentVolumeId: oldVolumeId,
  });
  const provider = await resolveFlyProviderClient({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  const resumableOperation = selectPromotedWorkspaceRestoreReplay({
    backupId: input.backupId,
    currentMachineId: workspace.flyMachineId,
    currentVolumeId: workspace.flyVolumeId,
    operations: resumableOperations,
  });
  if (resumableOperation) {
    const result = asRecord(resumableOperation.result)!;
    return resumePromotedWorkspaceRestore({
      operationId: resumableOperation.id,
      backupId: backup.id,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      validationThreadId:
        readString(result.validationThreadId) ??
        input.validationThreadId ??
        binding.threadId,
      oldMachineId: readString(result.oldMachineId)!,
      oldVolumeId: readString(result.oldVolumeId)!,
      replacementMachineId: workspace.flyMachineId,
      replacementVolumeId: workspace.flyVolumeId,
      flyAppName,
      provider,
      priorResult: result,
    });
  }
  const recoverySource = await resolveWorkspaceBackupRecoverySource({
    manifest: backup.manifest,
    objectKey: backup.objectKey,
    checksumSha256: backup.checksumSha256,
    isSnapshotUsable: (snapshotId) =>
      provider.isWorkspaceSnapshotUsable({
        appName: flyAppName,
        sourceVolumeId: snapshotSourceVolumeId,
        snapshotId,
      }),
  });
  if (!recoverySource) {
    throw new Error("Workspace backup has no usable recovery source.");
  }
  const snapshotId =
    recoverySource.kind === "snapshot" ? recoverySource.snapshotId : null;
  const runtimeImage = snapshotId
    ? (await requireCurrentEnvironmentRuntime()).runtimeImage
    : environment.runtimeImage;
  let archive: NodeJS.ReadableStream | null = null;
  let checksum: string | null = null;
  if (recoverySource.kind === "archive") {
    await createWorkspaceBackup({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      reason: "pre_destructive",
    });
    const encrypted = await getStorageAdapter().getObjectStream(
      recoverySource.objectKey,
    );
    archive = encrypted.pipe(
      createWorkspaceBackupDecryptionStream(backupKey()),
    );
    checksum = recoverySource.checksumSha256;
  }
  const validationExecution =
    await knowledgeDb.query.environmentRunExecutions.findFirst({
      where: (table, { and, eq, lte }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          eq(table.workspaceId, input.workspaceId),
          eq(table.status, "completed"),
          lte(table.createdAt, backup.createdAt),
          ...(input.validationThreadId
            ? [eq(table.threadId, input.validationThreadId)]
            : []),
        ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
  if (input.validationThreadId && !validationExecution) {
    throw new Error(
      "The requested pre-snapshot validation thread has no completed execution in this Workspace.",
    );
  }
  const validationThreadId = validationExecution?.threadId ?? binding.threadId;
  const operationId = crypto.randomUUID();
  const startedAt = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(input.workspaceId)}, 0))`,
    );
    await transaction.insert(schema.environmentOperations).values({
      id: operationId,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      requestedByUserId: input.actorUserId,
      type: "workspace.restore",
      status: "running",
      stage: "workspace.restore.provisioning_replacement",
      idempotencyKey: `workspace.restore:${input.backupId}:${operationId}`,
      input: {
        backupId: input.backupId,
        ...(input.validationThreadId
          ? { validationThreadId: input.validationThreadId }
          : {}),
      },
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
  });
  let replacementVolumeId: string | null = null;
  let replacementMachineId: string | null = null;
  let rebound = false;
  let expectedRouteGeneration: string | null = null;
  let acknowledgedRouteGeneration: string | null = null;
  let retiredProviderResourceIds: string[] = [];
  try {
    const workspaceServiceToken = createEnvironmentServiceToken();
    const replacementVolume = await provider.createReplacementWorkspaceVolume({
      appName: flyAppName,
      workspaceId: workspace.id,
      region: environment.region,
      replacementId: operationId,
      ...(snapshotId
        ? { snapshotId, sourceVolumeId: snapshotSourceVolumeId }
        : {}),
    });
    replacementVolumeId = replacementVolume.id;
    await knowledgeDb
      .update(schema.environmentOperations)
      .set({
        result: {
          backupId: backup.id,
          ...(snapshotId ? { snapshotId, snapshotSourceVolumeId } : {}),
          validationThreadId,
          ...workspaceRestoreResourceIdentities({
            oldMachineId,
            oldVolumeId,
            replacementVolumeId: replacementVolume.id,
          }),
        },
        updatedAt: new Date(),
      })
      .where(eq(schema.environmentOperations.id, operationId));
    const replacementMachine = await provider.createReplacementWorkspaceMachine(
      {
        appName: flyAppName,
        environmentId: environment.id,
        organizationId: input.organizationId,
        workspaceId: workspace.id,
        volumeId: replacementVolume.id,
        region: environment.region,
        runtimeImage,
        ticketPublicKey:
          process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
        controlPlaneUrl: process.env.KESTREL_ONE_APP_URL ?? "",
        serviceToken: workspaceServiceToken,
        source: {
          type: workspace.sourceType,
          ...(workspace.sourceRepository
            ? { repository: workspace.sourceRepository }
            : {}),
          ...(workspace.sourceDefaultBranch
            ? { defaultBranch: workspace.sourceDefaultBranch }
            : {}),
        },
        idleTimeoutMinutes: environment.idleTimeoutMinutes,
        replacementId: operationId,
      },
    );
    replacementMachineId = replacementMachine.id;
    await Promise.all([
      upsertEnvironmentProviderResource({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        replacementId: operationId,
        providerConnectionId,
        provider: "fly",
        resourceRole: "workspace_storage",
        externalId: replacementVolume.id,
        providerUid: null,
        desiredRevision: runtimeImage,
        observedGeneration: replacementVolume.id,
        state: "ready",
        providerMetadata: {
          contract: "provider-resource-metadata-v1",
          source: "provider_observation",
          detail: "Fly replacement volume created for guarded restore cutover.",
        },
      }),
      upsertEnvironmentProviderResource({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        replacementId: operationId,
        providerConnectionId,
        provider: "fly",
        resourceRole: "workspace_compute",
        externalId: replacementMachine.id,
        providerUid: null,
        desiredRevision: runtimeImage,
        observedGeneration: replacementMachine.id,
        state: "ready",
        providerMetadata: {
          contract: "provider-resource-metadata-v1",
          source: "provider_observation",
          detail: "Fly replacement Machine created for guarded restore cutover.",
        },
      }),
    ]);
    const resourceIdentities = workspaceRestoreResourceIdentities({
      oldMachineId,
      oldVolumeId,
      replacementMachineId: replacementMachine.id,
      replacementVolumeId: replacementVolume.id,
    });
    await knowledgeDb
      .update(schema.environmentOperations)
      .set({
        stage: "workspace.restore.importing",
        result: {
          backupId: backup.id,
          ...(snapshotId ? { snapshotId, snapshotSourceVolumeId } : {}),
          ...resourceIdentities,
        },
        updatedAt: new Date(),
      })
      .where(eq(schema.environmentOperations.id, operationId));
    if (replacementMachine.state !== "started") {
      await provider.waitForMachine({
        appName: flyAppName,
        machineId: replacementMachine.id,
        state: "started",
        timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
      });
    }
    await provider.waitForMachineHealth({
      appName: flyAppName,
      machineId: replacementMachine.id,
      checkName: "workspace",
      timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
    });
    const replacementRoute = () =>
      createEnvironmentMachineRoute({
        organizationId: input.organizationId,
        environmentId: environment.id,
        workspaceId: workspace.id,
        threadId: validationThreadId,
        actorId: input.actorUserId,
        flyAppName,
        flyMachineId: replacementMachine.id,
        routerUrl,
        capabilities: [...WORKSPACE_RESTORE_ROUTE_CAPABILITIES],
      });
    if (archive && checksum) {
      await uploadBackupArchiveStream({
        route: replacementRoute,
        archive,
        checksumSha256: checksum,
      });
      await provider.stopMachine({
        appName: flyAppName,
        machineId: replacementMachine.id,
      });
      await provider.waitForMachine({
        appName: flyAppName,
        machineId: replacementMachine.id,
        state: "stopped",
        timeoutSeconds: 60,
      });
      await provider.startMachine({
        appName: flyAppName,
        machineId: replacementMachine.id,
      });
      await provider.waitForMachine({
        appName: flyAppName,
        machineId: replacementMachine.id,
        state: "started",
        timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
      });
      await provider.waitForMachineHealth({
        appName: flyAppName,
        machineId: replacementMachine.id,
        checkName: "workspace",
        timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
      });
    }
    await waitForWorkspaceService(replacementRoute);
    const completedAt = new Date();
    const cutover = await performGuardedWorkspaceRestoreCutover({
      validateReplacement: async () => {
        const description = await readStoredSessionDescription({
          route: replacementRoute,
          sessionId: validationThreadId,
          actorId: input.actorUserId,
          organizationId: input.organizationId,
        });
        if (
          description.sessionId !== validationThreadId ||
          description.version <= 0
        ) {
          throw new Error(
            "Replacement Workspace did not contain the required persisted session.",
          );
        }
        return description;
      },
      casRebind: async () => {
        return knowledgeDb.transaction(async (transaction) => {
          const promotion = await promoteEnvironmentProviderReplacementInTransaction(
            transaction,
            {
              organizationId: input.organizationId,
              environmentId: input.environmentId,
              workspaceId: input.workspaceId,
              replacementId: operationId,
              expectedReplacementExternalIds: {
                workspace_compute: replacementMachine.id,
                workspace_storage: replacementVolume.id,
              },
              expectedRetiredExternalIds: {
                workspace_compute: oldMachineId,
                workspace_storage: oldVolumeId,
              },
            },
          );
          const updated = await transaction
            .update(schema.environmentWorkspaces)
            .set({
              flyVolumeId: replacementVolume.id,
              flyMachineId: replacementMachine.id,
              runtimeImage,
              serviceTokenHash: hashEnvironmentServiceToken(
                workspaceServiceToken,
              ),
              status: "ready",
              lastHealthAt: completedAt,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.environmentWorkspaces.id, workspace.id),
                eq(schema.environmentWorkspaces.flyMachineId, oldMachineId),
                eq(schema.environmentWorkspaces.flyVolumeId, oldVolumeId),
              ),
            )
            .returning({ id: schema.environmentWorkspaces.id });
          if (updated.length !== 1) {
            throw new WorkspaceRestoreCasConflictError();
          }
          retiredProviderResourceIds = promotion.retired.map((resource) => resource.id);
          return true;
        });
      },
      onRebound: () => {
        rebound = true;
      },
      validateBoundRoute: async () => {
        if (getHostedRoutingContractMode() === "logical-v1") {
          const routeAuthority = await resolveHostedRouteGeneration({
            organizationId: input.organizationId,
            environmentId: input.environmentId,
          });
          expectedRouteGeneration = routeAuthority.routeGeneration;
          const acknowledgement = await refreshEnvironmentGateway({
            organizationId: input.organizationId,
            environmentId: input.environmentId,
            expectedRouteGeneration,
          });
          acknowledgedRouteGeneration = acknowledgement.routeGeneration;
        }
        const boundRoute = await resolveEnvironmentExecutionRoute({
          organizationId: input.organizationId,
          threadId: validationThreadId,
          actorUserId: input.actorUserId,
          owningLifecycleOperationIds: [operationId],
        });
        await waitForWorkspaceService(() => ({
          baseUrl: boundRoute.baseUrl,
          authToken: boundRoute.authToken,
        }));
      },
      completeCutover: async (description) => {
        await knowledgeDb
          .update(schema.environmentOperations)
          .set({
            status: "completed",
            stage: "workspace.restore.rebound",
            result: {
              backupId: backup.id,
              ...(snapshotId ? { snapshotId, snapshotSourceVolumeId } : {}),
              validationThreadId,
              restoredSessionVersion: description.version,
              ...(expectedRouteGeneration
                ? {
                    expectedRouteGeneration,
                    acknowledgedRouteGeneration,
                    retiredProviderResourceIds,
                  }
                : {}),
              ...resourceIdentities,
            },
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(schema.environmentOperations.id, operationId));
      },
      markDegraded: async (error) => {
        const failedAt = new Date();
        const errorMessage =
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Workspace post-cutover validation failed.";
        await knowledgeDb.transaction(async (transaction) => {
          await transaction
            .update(schema.environmentWorkspaces)
            .set({
              status: "degraded",
              failureCode: "WORKSPACE_RESTORE_POST_CUTOVER_FAILED",
              failureMessage: errorMessage,
              updatedAt: failedAt,
            })
            .where(eq(schema.environmentWorkspaces.id, workspace.id));
          await transaction
            .update(schema.environmentOperations)
            .set({
              status: "failed",
              stage: "workspace.restore.post_cutover_validation_failed",
              errorCode: "WORKSPACE_RESTORE_POST_CUTOVER_FAILED",
              errorMessage,
              result: {
                backupId: backup.id,
                ...(snapshotId ? { snapshotId, snapshotSourceVolumeId } : {}),
                validationThreadId,
                ...(expectedRouteGeneration
                  ? {
                      expectedRouteGeneration,
                      acknowledgedRouteGeneration,
                      retiredProviderResourceIds,
                    }
                  : {}),
                ...resourceIdentities,
              },
              completedAt: failedAt,
              updatedAt: failedAt,
            })
            .where(eq(schema.environmentOperations.id, operationId));
        });
      },
      deleteOldMachine: () =>
        provider.deleteMachine({
          appName: flyAppName,
          machineId: oldMachineId,
        }),
      deleteOldVolume: () =>
        provider.deleteVolume({
          appName: flyAppName,
          volumeId: oldVolumeId,
        }),
    });
    const { cleanupPending, validation } = cutover;
    if (cleanupPending) {
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          stage: "workspace.restore.rebound_cleanup_pending",
          result: {
            backupId: backup.id,
            ...(snapshotId ? { snapshotId, snapshotSourceVolumeId } : {}),
            validationThreadId,
            restoredSessionVersion: validation.version,
            ...(expectedRouteGeneration
              ? {
                  expectedRouteGeneration,
                  acknowledgedRouteGeneration,
                  retiredProviderResourceIds,
                }
              : {}),
            ...resourceIdentities,
            cleanupPending: true,
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentOperations.id, operationId));
    }
    return {
      restoredBackupId: backup.id,
      operationId,
      replacementMachineId: replacementMachine.id,
      replacementVolumeId: replacementVolume.id,
      cleanupPending,
      restoredAt: completedAt,
    };
  } catch (error) {
    if (!rebound) {
      if (replacementMachineId) {
        await provider
          .deleteMachine({
            appName: flyAppName,
            machineId: replacementMachineId,
          })
          .catch(() => {});
      }
      if (replacementVolumeId) {
        await provider
          .deleteVolume({
            appName: flyAppName,
            volumeId: replacementVolumeId,
          })
          .catch(() => {});
      }
      const failedAt = new Date();
      await knowledgeDb.transaction(async (transaction) => {
        await transaction
          .update(schema.environmentProviderResources)
          .set({ state: "deleted", deletedAt: failedAt, updatedAt: failedAt })
          .where(
            and(
              eq(schema.environmentProviderResources.organizationId, input.organizationId),
              eq(schema.environmentProviderResources.environmentId, input.environmentId),
              eq(schema.environmentProviderResources.workspaceId, input.workspaceId),
              eq(schema.environmentProviderResources.replacementId, operationId),
              isNull(schema.environmentProviderResources.deletedAt),
            ),
          );
        await transaction.update(schema.environmentOperations).set({
          status: "failed",
          stage: "workspace.restore.failed",
          errorCode: "WORKSPACE_RESTORE_FAILED",
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Workspace restore failed.",
          result: {
            backupId: backup.id,
            ...(snapshotId ? { snapshotId, snapshotSourceVolumeId } : {}),
            validationThreadId,
            ...workspaceRestoreResourceIdentities({
              oldMachineId,
              oldVolumeId,
              replacementMachineId,
              replacementVolumeId,
            }),
          },
          completedAt: failedAt,
          updatedAt: failedAt,
        })
          .where(eq(schema.environmentOperations.id, operationId));
      });
    }
    throw error;
  }
}

async function resumePromotedWorkspaceRestore(input: {
  operationId: string;
  backupId: string;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  actorUserId: string;
  validationThreadId: string;
  oldMachineId: string;
  oldVolumeId: string;
  replacementMachineId: string;
  replacementVolumeId: string;
  flyAppName: string;
  provider: Awaited<ReturnType<typeof resolveFlyProviderClient>>;
  priorResult: Record<string, unknown>;
}) {
  const resumedAt = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(input.workspaceId)}, 0))`,
    );
    const current = await transaction.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.workspaceId),
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
        ),
      columns: { flyMachineId: true, flyVolumeId: true },
    });
    if (
      current?.flyMachineId !== input.replacementMachineId ||
      current.flyVolumeId !== input.replacementVolumeId
    ) {
      throw new WorkspaceRestoreCasConflictError();
    }
    await transaction
      .update(schema.environmentOperations)
      .set({
        status: "running",
        stage: "workspace.restore.post_cutover_validating",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: resumedAt,
      })
      .where(eq(schema.environmentOperations.id, input.operationId));
    await transaction
      .update(schema.environmentWorkspaces)
      .set({
        status: "ready",
        failureCode: null,
        failureMessage: null,
        updatedAt: resumedAt,
      })
      .where(eq(schema.environmentWorkspaces.id, input.workspaceId));
  });

  let expectedRouteGeneration = readString(
    input.priorResult.expectedRouteGeneration,
  );
  let acknowledgedRouteGeneration = readString(
    input.priorResult.acknowledgedRouteGeneration,
  );
  try {
    if (getHostedRoutingContractMode() === "logical-v1") {
      const authority = await resolveHostedRouteGeneration({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
      });
      expectedRouteGeneration = authority.routeGeneration;
      const acknowledgement = await refreshEnvironmentGateway({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        expectedRouteGeneration,
      });
      acknowledgedRouteGeneration = acknowledgement.routeGeneration;
    }
    const route = await resolveEnvironmentExecutionRoute({
      organizationId: input.organizationId,
      expectedEnvironmentId: input.environmentId,
      threadId: input.validationThreadId,
      actorUserId: input.actorUserId,
      owningLifecycleOperationIds: [input.operationId],
    });
    await waitForWorkspaceService(() => ({
      baseUrl: route.baseUrl,
      authToken: route.authToken,
    }));
    const description = await readStoredSessionDescription({
      route: () => ({ baseUrl: route.baseUrl, authToken: route.authToken }),
      sessionId: input.validationThreadId,
      actorId: input.actorUserId,
      organizationId: input.organizationId,
    });
    if (
      description.sessionId !== input.validationThreadId ||
      description.version <= 0
    ) {
      throw new Error(
        "Promoted Workspace did not contain the required persisted session.",
      );
    }
    const completedAt = new Date();
    const result = {
      ...input.priorResult,
      backupId: input.backupId,
      validationThreadId: input.validationThreadId,
      restoredSessionVersion: description.version,
      expectedRouteGeneration,
      acknowledgedRouteGeneration,
    };
    await knowledgeDb
      .update(schema.environmentOperations)
      .set({
        status: "completed",
        stage: "workspace.restore.rebound",
        result,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(schema.environmentOperations.id, input.operationId));

    let cleanupPending = false;
    try {
      await input.provider.deleteMachine({
        appName: input.flyAppName,
        machineId: input.oldMachineId,
      });
      await input.provider.deleteVolume({
        appName: input.flyAppName,
        volumeId: input.oldVolumeId,
      });
    } catch {
      cleanupPending = true;
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          stage: "workspace.restore.rebound_cleanup_pending",
          result: { ...result, cleanupPending: true },
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentOperations.id, input.operationId));
    }
    return {
      restoredBackupId: input.backupId,
      operationId: input.operationId,
      replacementMachineId: input.replacementMachineId,
      replacementVolumeId: input.replacementVolumeId,
      cleanupPending,
      restoredAt: completedAt,
    };
  } catch (error) {
    const failedAt = new Date();
    const errorMessage =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Workspace post-cutover validation failed.";
    await knowledgeDb.transaction(async (transaction) => {
      await transaction
        .update(schema.environmentWorkspaces)
        .set({
          status: "degraded",
          failureCode: "WORKSPACE_RESTORE_POST_CUTOVER_FAILED",
          failureMessage: errorMessage,
          updatedAt: failedAt,
        })
        .where(eq(schema.environmentWorkspaces.id, input.workspaceId));
      await transaction
        .update(schema.environmentOperations)
        .set({
          status: "failed",
          stage: "workspace.restore.post_cutover_validation_failed",
          errorCode: "WORKSPACE_RESTORE_POST_CUTOVER_FAILED",
          errorMessage,
          result: {
            ...input.priorResult,
            expectedRouteGeneration,
            acknowledgedRouteGeneration,
          },
          completedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(eq(schema.environmentOperations.id, input.operationId));
    });
    throw error;
  }
}

async function readStoredSessionDescription(input: {
  route: () => { baseUrl: string; authToken: string };
  sessionId: string;
  actorId: string;
  organizationId: string;
}) {
  const route = input.route();
  const client = new KestrelClient({
    target: {
      kind: "remote",
      baseUrl: route.baseUrl,
      authToken: route.authToken,
    },
  });
  const context: KestrelRequestContext = {
    actor: {
      actorId: input.actorId,
      actorType: "end_user",
      tenantId: input.organizationId,
    },
    tenantId: input.organizationId,
  };
  try {
    const profile = await client.getProfile(
      process.env.KESTREL_ONE_PROFILE_ID?.trim() ||
        DEFAULT_WORKSPACE_PROFILE_ID,
      context,
    );
    return await client.describeSession(input.sessionId, {
      ...context,
      profile,
    });
  } catch (error) {
    const status =
      error instanceof KestrelSdkError && typeof error.status === "number"
        ? `HTTP ${error.status}, `
        : "";
    const code =
      error instanceof KestrelSdkError
        ? error.code
        : "RUNNER_STORE_VALIDATION_FAILED";
    throw new Error(
      `Replacement Workspace store validation failed (${status}${code}).`,
    );
  } finally {
    await client.close();
  }
}

type WorkspaceBackupPreparationResponse = {
  preparationId: string;
  sourceRevision: string;
  logicalBytes: number;
  entryCount: number;
  expiresAt: string;
};

async function prepareBackupExport(
  baseUrl: string,
  token: string,
  signal?: AbortSignal | undefined,
) {
  const response = await fetch(new URL("/v1/backups/prepare", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (response.status === 404) return null;
  const result = (await response.json().catch(() => null)) as
    | WorkspaceBackupPreparationResponse
    | { error?: { code?: string; message?: string } }
    | null;
  const failure = result && "error" in result ? result.error : null;
  if (shouldFallbackToLegacyBackupExport(response.status, failure?.code)) {
    return null;
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(failure?.message ?? "Workspace backup preparation failed."),
      { code: failure?.code ?? "WORKSPACE_BACKUP_PREPARATION_FAILED" },
    );
  }
  if (
    !(
      result &&
      "preparationId" in result &&
      result.preparationId &&
      result.sourceRevision
    )
  ) {
    throw new Error("Workspace backup preparation response is invalid.");
  }
  return result;
}

export function shouldFallbackToLegacyBackupExport(
  status: number,
  code: string | undefined,
) {
  return (
    status === 404 ||
    (status === 403 && code === "ENVIRONMENT_CAPABILITY_DENIED")
  );
}

async function fetchPreparedBackupArchive(
  baseUrl: string,
  token: string,
  preparationId?: string | undefined,
  signal?: AbortSignal | undefined,
) {
  const url = new URL("/v1/backups/export", baseUrl);
  if (preparationId) url.searchParams.set("preparationId", preparationId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (!(response.ok && response.body)) {
    const result = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw Object.assign(
      new Error(result?.error?.message ?? "Workspace backup export failed."),
      { code: result?.error?.code ?? "WORKSPACE_BACKUP_EXPORT_FAILED" },
    );
  }
  return Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream,
  );
}

async function assertWorkspaceBackupReady(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
}) {
  const [environment, workspace, binding] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.environmentId),
          eq(table.organizationId, input.organizationId),
        ),
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.workspaceId),
          eq(table.environmentId, input.environmentId),
          eq(table.organizationId, input.organizationId),
        ),
    }),
    findActiveWorkspaceExecutionBinding(input),
  ]);
  if (
    !(
      environment?.flyAppName &&
      workspace?.flyVolumeId &&
      workspace.flyMachineId &&
      binding
    )
  ) {
    throw new Error("Workspace is not ready for backup.");
  }
}

async function findActiveWorkspaceExecutionBinding(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
}) {
  const [binding] = await knowledgeDb
    .select({ threadId: schema.threadExecutionBindings.threadId })
    .from(schema.threadExecutionBindings)
    .innerJoin(
      schema.threads,
      and(
        eq(schema.threads.id, schema.threadExecutionBindings.threadId),
        isNull(schema.threads.archivedAt),
      ),
    )
    .where(
      and(
        eq(schema.threadExecutionBindings.organizationId, input.organizationId),
        eq(schema.threadExecutionBindings.environmentId, input.environmentId),
        eq(schema.threadExecutionBindings.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(
      desc(schema.threads.updatedAt),
      desc(schema.threadExecutionBindings.updatedAt),
    )
    .limit(1);
  return binding;
}

function backupKey() {
  const encoded = process.env.KESTREL_WORKSPACE_BACKUP_KEY?.trim() ?? "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error(
      "KESTREL_WORKSPACE_BACKUP_KEY must be a base64-encoded 32-byte key.",
    );
  }
  return key;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function backupKeyId() {
  const value = process.env.KESTREL_WORKSPACE_BACKUP_KEY_ID?.trim();
  if (!value)
    throw new Error("KESTREL_WORKSPACE_BACKUP_KEY_ID is not configured.");
  return value;
}
