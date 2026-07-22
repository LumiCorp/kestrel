import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

export async function createWorkspaceBackup(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  actorUserId: string;
  reason: "checkpoint" | "daily" | "pre_destructive" | "pre_promotion";
  idempotencyKey?: string;
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
  });
  if (prepared.available) return prepared.available;
  const { operationId, backupId } = prepared;
  try {
    const route = await resolveEnvironmentExecutionRoute({
      organizationId: input.organizationId,
      threadId: binding.threadId,
      actorUserId: input.actorUserId,
    });
    const archive = await fetchBackupArchive(route.baseUrl, route.authToken);
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
    const provider = await createFlyProviderClient(input.organizationId);
    const snapshot = await createAuxiliaryVolumeSnapshot({
      appName: environment.flyAppName,
      volumeId: workspace.flyVolumeId,
      createSnapshot: (snapshotInput) =>
        provider.createVolumeSnapshot(snapshotInput),
    });
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
            status: "running",
            stage: "workspace.backup.exporting",
            errorCode: null,
            errorMessage: null,
            completedAt: null,
            startedAt: input.now,
            updatedAt: input.now,
          })
          .where(eq(schema.environmentOperations.id, existingOperation.id));
        await transaction
          .update(schema.workspaceBackups)
          .set({
            status: "creating",
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
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.insert(schema.environmentOperations).values({
      id: operationId,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      requestedByUserId: input.actorUserId,
      type: "workspace.backup",
      status: "running",
      stage: "workspace.backup.exporting",
      idempotencyKey: requestedKey ?? `workspace.backup:${backupId}`,
      startedAt: input.now,
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
      status: "creating",
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
  if (!(backup?.objectKey && backup.checksumSha256)) {
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
  const runtimeImage = environment.runtimeImage;
  const oldMachineId = workspace.flyMachineId;
  const oldVolumeId = workspace.flyVolumeId;
  await createWorkspaceBackup({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    reason: "pre_destructive",
  });
  const encrypted = await getStorageAdapter().getObjectBuffer(backup.objectKey);
  const archive = decryptWorkspaceBackup(encrypted, backupKey());
  const checksum = createHash("sha256").update(archive).digest("hex");
  if (checksum !== backup.checksumSha256) {
    throw new Error("Workspace backup checksum verification failed.");
  }
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
    input: { backupId: input.backupId },
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  const provider = await createFlyProviderClient(input.organizationId);
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
        timeoutSeconds: 90,
      });
    }
    await provider.waitForMachineHealth({
      appName: flyAppName,
      machineId: replacementMachine.id,
      checkName: "workspace",
      timeoutSeconds: 90,
    });
    const replacementRoute = () =>
      createEnvironmentMachineRoute({
        organizationId: input.organizationId,
        environmentId: environment.id,
        workspaceId: workspace.id,
        threadId: binding.threadId,
        actorId: input.actorUserId,
        flyAppName,
        flyMachineId: replacementMachine.id,
        routerUrl,
        capabilities: ["workspace.backups.restore", "workspace.apps.read"],
      });
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
      timeoutSeconds: 90,
    });
    await provider.waitForMachineHealth({
      appName: flyAppName,
      machineId: replacementMachine.id,
      checkName: "workspace",
      timeoutSeconds: 90,
    });
    await waitForWorkspaceService(replacementRoute);
    const completedAt = new Date();
    const reboundRows = await knowledgeDb.transaction(async (transaction) => {
      const rows = await transaction
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
        .returning({ id: schema.environmentWorkspaces.id });
      if (rows.length !== 1) return rows;
      await transaction
        .update(schema.environmentOperations)
        .set({
          status: "completed",
          stage: "workspace.restore.rebound",
          result: {
            backupId: backup.id,
            oldMachineId,
            oldVolumeId,
            replacementMachineId: replacementMachine.id,
            replacementVolumeId: replacementVolume.id,
          },
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(schema.environmentOperations.id, operationId));
      return rows;
    });
    if (reboundRows.length !== 1) {
      throw new Error(
        "Workspace changed while replacement restore was running."
      );
    }
    rebound = true;
    const cleanup = await Promise.allSettled([
      provider.deleteMachine({
        appName: flyAppName,
        machineId: oldMachineId,
      }),
      provider.deleteVolume({
        appName: flyAppName,
        volumeId: oldVolumeId,
      }),
    ]);
    const cleanupPending = cleanup.some(
      (result) => result.status === "rejected"
    );
    if (cleanupPending) {
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          stage: "workspace.restore.rebound_cleanup_pending",
          result: {
            backupId: backup.id,
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

async function fetchBackupArchive(baseUrl: string, token: string) {
  const response = await fetch(new URL("/v1/backups/export", baseUrl), {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!(response.ok && response.body)) {
    throw new Error("Workspace backup export failed.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
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
