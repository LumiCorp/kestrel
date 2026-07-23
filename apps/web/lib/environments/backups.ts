import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  KestrelClient,
  KestrelSdkError,
  type KestrelRequestContext,
} from "@kestrel-agents/sdk/runner";
import { WORKSPACE_READINESS_TIMEOUT_SECONDS } from "@lumi/kestrel-environment-auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getStorageAdapter } from "@/lib/storage";
import {
  decryptWorkspaceBackup,
  encryptWorkspaceBackup,
} from "./backup-crypto";
import { createAuxiliaryVolumeSnapshot } from "./backup-snapshot";
import {
  uploadBackupArchive,
  waitForWorkspaceService,
} from "./backup-transfer";
import { WORKSPACE_BACKUP_RETENTION_DAYS } from "./contracts";
import {
  createEnvironmentMachineRoute,
  resolveEnvironmentExecutionRoute,
} from "./execution-route";
import { createFlyProviderClient } from "./fly-connection";
import {
  createEnvironmentServiceToken,
  hashEnvironmentServiceToken,
} from "./service-tokens";
import {
  performGuardedWorkspaceRestoreCutover,
  resolveWorkspaceBackupRecoverySource,
  resolveWorkspaceBackupSnapshotSourceVolumeId,
  WORKSPACE_RESTORE_ROUTE_CAPABILITIES,
} from "./restore-cutover";

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const BACKUP_EXECUTION_OWNERSHIP_KEY = "backupExecutionOwnership";
const DEFAULT_WORKSPACE_PROFILE_ID = "kestrel-one";
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
  parentLifecycleOperationId?: string | undefined;
  preDestructiveSnapshot?: { id: string; state: string } | undefined;
}) {
  const [environment, workspace, binding] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.environmentId),
          eq(table.organizationId, input.organizationId)
        ),
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.workspaceId),
          eq(table.environmentId, input.environmentId),
          eq(table.organizationId, input.organizationId)
        ),
    }),
    knowledgeDb.query.threadExecutionBindings.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.workspaceId, input.workspaceId),
          eq(table.organizationId, input.organizationId)
        ),
    }),
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
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + WORKSPACE_BACKUP_RETENTION_DAYS * 86_400_000
  );
  const prepared = await prepareWorkspaceBackup({
    ...input,
    now,
    expiresAt,
    executionOwnership: input.executionOwnership ?? "parent_operation",
  });
  if (prepared.available) return prepared.available;
  const { operationId, backupId } = prepared;
  try {
    input.signal?.throwIfAborted();
    const route = await resolveEnvironmentExecutionRoute({
      organizationId: input.organizationId,
      threadId: binding.threadId,
      actorUserId: input.actorUserId,
      owningLifecycleOperationIds: [
        operationId,
        ...(input.parentLifecycleOperationId
          ? [input.parentLifecycleOperationId]
          : []),
      ],
    });
    const archive = await fetchBackupArchive(
      route.baseUrl,
      route.authToken,
      input.signal,
    );
    input.signal?.throwIfAborted();
    const checksumSha256 = createHash("sha256").update(archive).digest("hex");
    const encrypted = encryptWorkspaceBackup(archive, backupKey());
    const storage = getStorageAdapter();
    const objectKey = storage.buildObjectKey(
      "workspace-backups",
      input.organizationId,
      input.workspaceId,
      `${backupId}.tar.gz.enc`
    );
    await storage.putObject({
      key: objectKey,
      body: encrypted,
      contentType: "application/octet-stream",
      metadata: {
        workspaceId: input.workspaceId,
        checksumSha256,
        encryptionKeyId: backupKeyId(),
      },
    });
    input.signal?.throwIfAborted();
    const provider = await createFlyProviderClient(input.organizationId);
    const snapshot = await createAuxiliaryVolumeSnapshot({
      appName: environment.flyAppName,
      volumeId: workspace.flyVolumeId,
      createSnapshot: (snapshotInput) =>
        provider.createVolumeSnapshot(snapshotInput),
    });
    input.signal?.throwIfAborted();
    const completedAt = new Date();
    await knowledgeDb.transaction(async (transaction) => {
      await transaction
        .update(schema.workspaceBackups)
        .set({
          status: "available",
          objectKey,
          encryptionKeyId: backupKeyId(),
          checksumSha256,
          sizeBytes: archive.length,
          manifest: {
            flySnapshotId: snapshot.id,
            flySnapshotState: snapshot.state,
            flySnapshotSourceVolumeId: workspace.flyVolumeId,
            ...(input.preDestructiveSnapshot
              ? {
                  preDestructiveFlySnapshotId:
                    input.preDestructiveSnapshot.id,
                  preDestructiveFlySnapshotState:
                    input.preDestructiveSnapshot.state,
                }
              : {}),
            ...(snapshot.errorMessage
              ? { flySnapshotError: snapshot.errorMessage }
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
            flySnapshotState: snapshot.state,
          },
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(schema.environmentOperations.id, operationId));
    });
    return {
      backupId,
      objectKey,
      snapshotId: snapshot.id,
      snapshotState: snapshot.state,
      expiresAt,
    };
  } catch (error) {
    if (input.signal?.aborted) {
      await failInterruptedWorkspaceBackup(operationId);
      throw error;
    }
    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Workspace backup failed.";
    const failedAt = new Date();
    await knowledgeDb.transaction(async (transaction) => {
      await transaction
        .update(schema.workspaceBackups)
        .set({ status: "failed", updatedAt: failedAt })
        .where(eq(schema.workspaceBackups.id, backupId));
      await transaction
        .update(schema.environmentOperations)
        .set({
          status: "failed",
          stage: "workspace.backup.failed",
          errorCode: "WORKSPACE_BACKUP_FAILED",
          errorMessage: message,
          completedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(eq(schema.environmentOperations.id, operationId));
    });
    throw error;
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
    now,
    expiresAt,
    initialStatus: "queued",
    executionOwnership: "queue",
  });
  if (prepared.available) {
    return { ...prepared.available, status: "available" as const };
  }
  const { enqueueEnvironmentOperation } = await import("@/lib/knowledge/queue");
  await enqueueEnvironmentOperation(prepared.operationId);
  return {
    backupId: prepared.backupId,
    operationId: prepared.operationId,
    status: "queued" as const,
    expiresAt,
  };
}

export async function processQueuedWorkspaceBackup(input: {
  operationId: string;
  signal?: AbortSignal | undefined;
}) {
  const operation = await knowledgeDb.query.environmentOperations.findFirst({
    where: (table, { eq }) => eq(table.id, input.operationId),
  });
  if (!operation || operation.type !== "workspace.backup") {
    return "not_claimed" as const;
  }
  const backup = await knowledgeDb.query.workspaceBackups.findFirst({
    where: (table, { eq }) => eq(table.operationId, operation.id),
  });
  if (!backup) {
    throw new Error("Queued Workspace backup is missing its backup record.");
  }
  if (operation.status === "running") {
    await failInterruptedWorkspaceBackup(operation.id);
    return "interrupted" as const;
  }
  if (operation.status !== "queued") return "not_claimed" as const;
  if (!operation.requestedByUserId) {
    await failInterruptedWorkspaceBackup(operation.id);
    return "interrupted" as const;
  }
  await createWorkspaceBackup({
    organizationId: operation.organizationId,
    environmentId: operation.environmentId,
    workspaceId: backup.workspaceId,
    actorUserId: operation.requestedByUserId,
    reason: backup.reason,
    idempotencyKey: operation.idempotencyKey,
    signal: input.signal,
    executionOwnership: "queue",
  });
  return "processed" as const;
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

export function isParentOwnedWorkspaceBackup(value: unknown) {
  return asRecord(value)?.[BACKUP_EXECUTION_OWNERSHIP_KEY] === "parent_operation";
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
  const terminalOperations = await knowledgeDb.query.environmentOperations.findMany({
    where: (table, { and, inArray }) =>
      and(
        inArray(table.id, operationIds),
        inArray(table.status, ["failed", "cancelled"]),
      ),
    columns: { id: true },
  });
  const terminalIds = new Set(terminalOperations.map((operation) => operation.id));
  const backupIds = activeBackups
    .filter((backup) => backup.operationId && terminalIds.has(backup.operationId))
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
  | { available: null; operationId: string; backupId: string };

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
}): Promise<PreparedWorkspaceBackup> {
  const requestedKey = input.idempotencyKey?.trim();
  if (requestedKey) {
    const existingOperation =
      await knowledgeDb.query.environmentOperations.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.idempotencyKey, requestedKey)
          ),
      });
    if (existingOperation) {
      const existingBackup = await knowledgeDb.query.workspaceBackups.findFirst(
        {
          where: (table, { eq }) => eq(table.operationId, existingOperation.id),
        }
      );
      if (!existingBackup) {
        throw new Error(
          "Idempotent Workspace backup operation is missing its backup record."
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
      await knowledgeDb.transaction(async (transaction) => {
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
        operationId: existingOperation.id,
        backupId: existingBackup.id,
      };
    }
  }
  const operationId = crypto.randomUUID();
  const backupId = crypto.randomUUID();
  const initialStatus = input.initialStatus ?? "running";
  await knowledgeDb.transaction(async (transaction) => {
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
      },
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
  return { available: null, operationId, backupId };
}

export async function listWorkspaceBackups(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
}) {
  return knowledgeDb.query.workspaceBackups.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        eq(table.workspaceId, input.workspaceId)
      ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
}

export async function restoreWorkspaceBackup(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  backupId: string;
  actorUserId: string;
  validationThreadId?: string | undefined;
}) {
  const [backup, environment, workspace, binding] = await Promise.all([
    knowledgeDb.query.workspaceBackups.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.backupId),
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          eq(table.workspaceId, input.workspaceId),
          eq(table.status, "available")
        ),
    }),
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.environmentId),
          eq(table.organizationId, input.organizationId)
        ),
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.workspaceId),
          eq(table.environmentId, input.environmentId),
          eq(table.organizationId, input.organizationId)
        ),
    }),
    knowledgeDb.query.threadExecutionBindings.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.workspaceId, input.workspaceId),
          eq(table.organizationId, input.organizationId)
        ),
    }),
  ]);
  if (!backup) {
    throw new Error("Workspace backup is unavailable.");
  }
  if (
    !(
      environment?.flyAppName &&
      environment.runtimeImage &&
      environment.routerUrl &&
      workspace?.flyMachineId &&
      workspace.flyVolumeId &&
      binding
    )
  ) {
    throw new Error("Workspace replacement target is unavailable.");
  }
  const flyAppName = environment.flyAppName;
  const routerUrl = environment.routerUrl;
  const oldMachineId = workspace.flyMachineId;
  const oldVolumeId = workspace.flyVolumeId;
  const snapshotSourceVolumeId =
    resolveWorkspaceBackupSnapshotSourceVolumeId({
      manifest: backup.manifest,
      currentVolumeId: oldVolumeId,
    });
  const provider = await createFlyProviderClient(input.organizationId);
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
    ? requireImmutableWorkspaceRuntimeImage()
    : environment.runtimeImage;
  let archive: Buffer | null = null;
  let checksum: string | null = null;
  if (recoverySource.kind === "archive") {
    await createWorkspaceBackup({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      reason: "pre_destructive",
    });
    const encrypted = await getStorageAdapter().getObjectBuffer(
      recoverySource.objectKey
    );
    archive = decryptWorkspaceBackup(encrypted, backupKey());
    checksum = createHash("sha256").update(archive).digest("hex");
    if (checksum !== recoverySource.checksumSha256) {
      throw new Error("Workspace backup checksum verification failed.");
    }
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
            : [])
        ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
  if (input.validationThreadId && !validationExecution) {
    throw new Error(
      "The requested pre-snapshot validation thread has no completed execution in this Workspace."
    );
  }
  const validationThreadId = validationExecution?.threadId ?? binding.threadId;
  const operationId = crypto.randomUUID();
  const startedAt = new Date();
  await knowledgeDb.insert(schema.environmentOperations).values({
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
  let replacementVolumeId: string | null = null;
  let replacementMachineId: string | null = null;
  let rebound = false;
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
      }
    );
    replacementMachineId = replacementMachine.id;
    await knowledgeDb
      .update(schema.environmentOperations)
      .set({
        stage: "workspace.restore.importing",
        result: {
          backupId: backup.id,
          ...(snapshotId
            ? { snapshotId, snapshotSourceVolumeId }
            : {}),
          replacementMachineId: replacementMachine.id,
          replacementVolumeId: replacementVolume.id,
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
      await uploadBackupArchive({
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
            "Replacement Workspace did not contain the required persisted session."
          );
        }
        return description;
      },
      casRebind: async () => {
        const rows = await knowledgeDb.transaction(async (transaction) =>
          transaction
            .update(schema.environmentWorkspaces)
            .set({
              flyVolumeId: replacementVolume.id,
              flyMachineId: replacementMachine.id,
              runtimeImage,
              serviceTokenHash: hashEnvironmentServiceToken(
                workspaceServiceToken
              ),
              status: "ready",
              lastHealthAt: completedAt,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.environmentWorkspaces.id, workspace.id),
                eq(schema.environmentWorkspaces.flyMachineId, oldMachineId),
                eq(schema.environmentWorkspaces.flyVolumeId, oldVolumeId)
              )
            )
            .returning({ id: schema.environmentWorkspaces.id })
        );
        return rows.length === 1;
      },
      onRebound: () => {
        rebound = true;
      },
      validateBoundRoute: async () => {
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
              ...(snapshotId
                ? { snapshotId, snapshotSourceVolumeId }
                : {}),
              validationThreadId,
              restoredSessionVersion: description.version,
              oldMachineId,
              oldVolumeId,
              replacementMachineId: replacementMachine.id,
              replacementVolumeId: replacementVolume.id,
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
            ...(snapshotId
              ? { snapshotId, snapshotSourceVolumeId }
              : {}),
            validationThreadId,
            restoredSessionVersion: validation.version,
            oldMachineId,
            oldVolumeId,
            replacementMachineId: replacementMachine.id,
            replacementVolumeId: replacementVolume.id,
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
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          status: "failed",
          stage: "workspace.restore.failed",
          errorCode: "WORKSPACE_RESTORE_FAILED",
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Workspace restore failed.",
          completedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(eq(schema.environmentOperations.id, operationId));
    }
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
      context
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
      `Replacement Workspace store validation failed (${status}${code}).`
    );
  } finally {
    await client.close();
  }
}

function requireImmutableWorkspaceRuntimeImage() {
  const image = process.env.KESTREL_WORKSPACE_RUNTIME_IMAGE?.trim() ?? "";
  if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error(
      "KESTREL_WORKSPACE_RUNTIME_IMAGE must identify an immutable image digest for snapshot recovery."
    );
  }
  return image;
}

async function fetchBackupArchive(
  baseUrl: string,
  token: string,
  signal?: AbortSignal | undefined,
) {
  const response = await fetch(new URL("/v1/backups/export", baseUrl), {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (!(response.ok && response.body)) {
    throw new Error("Workspace backup export failed.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    signal?.throwIfAborted();
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BACKUP_BYTES) {
      await reader.cancel();
      throw new Error("Workspace backup exceeds 256 MiB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
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
    knowledgeDb.query.threadExecutionBindings.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.workspaceId, input.workspaceId),
          eq(table.organizationId, input.organizationId),
        ),
    }),
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

function backupKey() {
  const encoded = process.env.KESTREL_WORKSPACE_BACKUP_KEY?.trim() ?? "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error(
      "KESTREL_WORKSPACE_BACKUP_KEY must be a base64-encoded 32-byte key."
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
