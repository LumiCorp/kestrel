import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getStorageAdapter } from "@/lib/storage";
import { createWorkspaceBackup } from "./backups";
import { processEnvironmentOperation } from "./process-runtime";
import { FlyMachinesClient } from "./providers/fly-machines";
import { selectDueDailyBackupCandidate } from "./reconcile-selection";

export async function reconcileHostedEnvironments() {
  const now = new Date();
  const provider = new FlyMachinesClient({
    token: process.env.FLY_API_TOKEN ?? "",
    organizationSlug: process.env.KESTREL_FLY_ORGANIZATION_SLUG ?? "",
  });
  const queuedOperations =
    await knowledgeDb.query.environmentOperations.findMany({
      where: (table, { eq }) => eq(table.status, "queued"),
      columns: { id: true },
      limit: 100,
    });
  for (const operation of queuedOperations) {
    try {
      await processEnvironmentOperation(operation.id);
    } catch {}
  }
  const environmentGatewayCount = await reconcileEnvironmentGateways(
    provider,
    now
  );
  const workspaces = await knowledgeDb
    .select({
      workspace: schema.environmentWorkspaces,
      environment: schema.environments,
    })
    .from(schema.environmentWorkspaces)
    .innerJoin(
      schema.environments,
      eq(schema.environments.id, schema.environmentWorkspaces.environmentId)
    )
    .where(
      and(
        isNull(schema.environmentWorkspaces.deletedAt),
        inArray(schema.environmentWorkspaces.status, [
          "ready",
          "starting",
          "stopping",
          "stopped",
          "degraded",
        ])
      )
    );
  for (const { workspace, environment } of workspaces) {
    if (!(workspace.flyMachineId && environment.flyAppName)) continue;
    try {
      const machine = await provider.getMachine({
        appName: environment.flyAppName,
        machineId: workspace.flyMachineId,
      });
      const status = machine?.state === "started" ? "ready" : "stopped";
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({
          status,
          lastHealthAt: now,
          failureCode: null,
          failureMessage: null,
          updatedAt: now,
        })
        .where(eq(schema.environmentWorkspaces.id, workspace.id));
    } catch {
      await knowledgeDb
        .update(schema.environmentWorkspaces)
        .set({ status: "degraded", updatedAt: now })
        .where(eq(schema.environmentWorkspaces.id, workspace.id));
    }
  }
  await cleanupReplacedWorkspaceResources(provider);
  await cleanupOrphanedEnvironmentResources(provider);
  await expireWorkspaceBackups(now);
  await createDueDailyBackup(now);
  return {
    queuedOperationCount: queuedOperations.length,
    environmentGatewayCount,
    workspaceCount: workspaces.length,
  };
}

async function reconcileEnvironmentGateways(
  provider: FlyMachinesClient,
  now: Date
) {
  const environments = await knowledgeDb.query.environments.findMany({
    where: (table, { and, inArray, isNotNull, isNull }) =>
      and(
        inArray(table.status, ["ready", "degraded"]),
        isNotNull(table.flyAppName),
        isNotNull(table.routerImage),
        isNull(table.archivedAt)
      ),
  });
  const ticketPublicKey =
    process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "";
  for (const environment of environments) {
    if (!(environment.flyAppName && environment.routerImage)) continue;
    try {
      const gateway = await provider.ensureEnvironmentGateway({
        appName: environment.flyAppName,
        environmentId: environment.id,
        region: environment.region,
        runtimeImage: environment.routerImage,
        ticketPublicKey,
      });
      if (gateway.state !== "started") {
        await provider.startMachine({
          appName: environment.flyAppName,
          machineId: gateway.machineId,
        });
        await provider.waitForMachine({
          appName: environment.flyAppName,
          machineId: gateway.machineId,
          state: "started",
          timeoutSeconds: 60,
        });
      }
      await provider.waitForMachineHealth({
        appName: environment.flyAppName,
        machineId: gateway.machineId,
        checkName: "gateway",
        timeoutSeconds: 60,
      });
      await knowledgeDb
        .update(schema.environments)
        .set({
          status: "ready",
          flyGatewayMachineId: gateway.machineId,
          routerUrl: gateway.routerUrl,
          lastHealthAt: now,
          failureCode: null,
          failureMessage: null,
          updatedAt: now,
        })
        .where(eq(schema.environments.id, environment.id));
    } catch {
      await knowledgeDb
        .update(schema.environments)
        .set({
          status: "degraded",
          failureCode: "ENVIRONMENT_GATEWAY_RECONCILE_FAILED",
          failureMessage: "Environment gateway reconciliation failed.",
          updatedAt: now,
        })
        .where(eq(schema.environments.id, environment.id));
    }
  }
  return environments.length;
}

async function cleanupOrphanedEnvironmentResources(
  provider: FlyMachinesClient
) {
  const environments = await knowledgeDb.query.environments.findMany({
    where: (table, { and, isNotNull, isNull }) =>
      and(isNotNull(table.flyAppName), isNull(table.archivedAt)),
  });
  for (const environment of environments) {
    if (!environment.flyAppName) continue;
    const activeOperation =
      await knowledgeDb.query.environmentOperations.findFirst({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.environmentId, environment.id),
            inArray(table.status, ["queued", "running"])
          ),
        columns: { id: true },
      });
    if (activeOperation) continue;
    const workspaces = await knowledgeDb.query.environmentWorkspaces.findMany({
      where: (table, { and, eq, isNull }) =>
        and(eq(table.environmentId, environment.id), isNull(table.deletedAt)),
      columns: { flyMachineId: true, flyVolumeId: true },
    });
    const activeMachineIds = new Set([
      ...(environment.flyGatewayMachineId
        ? [environment.flyGatewayMachineId]
        : []),
      ...workspaces.flatMap((workspace) =>
        workspace.flyMachineId ? [workspace.flyMachineId] : []
      ),
    ]);
    const activeVolumeIds = new Set(
      workspaces.flatMap((workspace) =>
        workspace.flyVolumeId ? [workspace.flyVolumeId] : []
      )
    );
    const inventory = await provider.listEnvironmentResources({
      appName: environment.flyAppName,
    });
    const orphanMachineIds = inventory.machines
      .filter((machine) => !activeMachineIds.has(machine.id))
      .map((machine) => machine.id)
      .sort();
    const orphanVolumeIds = inventory.volumes
      .filter((volume) => !activeVolumeIds.has(volume.id))
      .map((volume) => volume.id)
      .sort();
    if (orphanMachineIds.length === 0 && orphanVolumeIds.length === 0) {
      continue;
    }
    for (const machineId of orphanMachineIds) {
      await provider.deleteMachine({
        appName: environment.flyAppName,
        machineId,
      });
    }
    for (const volumeId of orphanVolumeIds) {
      await provider.deleteVolume({
        appName: environment.flyAppName,
        volumeId,
      });
    }
    const fingerprint = createHash("sha256")
      .update([...orphanMachineIds, ...orphanVolumeIds].join("\0"))
      .digest("hex");
    const now = new Date();
    await knowledgeDb
      .insert(schema.environmentOperations)
      .values({
        id: crypto.randomUUID(),
        organizationId: environment.organizationId,
        environmentId: environment.id,
        type: "workspace.reconcile",
        status: "completed",
        stage: "environment.reconcile.orphans_deleted",
        idempotencyKey: `environment.reconcile:${environment.id}:${fingerprint}`,
        result: { orphanMachineIds, orphanVolumeIds },
        startedAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

async function cleanupReplacedWorkspaceResources(provider: FlyMachinesClient) {
  const operations = await knowledgeDb.query.environmentOperations.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.type, "workspace.restore"),
        eq(table.status, "completed"),
        eq(table.stage, "workspace.restore.rebound_cleanup_pending")
      ),
    limit: 100,
  });
  for (const operation of operations) {
    const environment = await knowledgeDb.query.environments.findFirst({
      where: (table, { eq }) => eq(table.id, operation.environmentId),
      columns: { flyAppName: true },
    });
    const result = asRecord(operation.result);
    const oldMachineId = readString(result?.oldMachineId);
    const oldVolumeId = readString(result?.oldVolumeId);
    if (!(environment?.flyAppName && oldMachineId && oldVolumeId)) continue;
    try {
      await provider.deleteMachine({
        appName: environment.flyAppName,
        machineId: oldMachineId,
      });
      await provider.deleteVolume({
        appName: environment.flyAppName,
        volumeId: oldVolumeId,
      });
      await knowledgeDb
        .update(schema.environmentOperations)
        .set({
          stage: "workspace.restore.rebound_cleanup_completed",
          result: { ...result, cleanupPending: false },
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentOperations.id, operation.id));
    } catch {}
  }
}

async function expireWorkspaceBackups(now: Date) {
  const expired = await knowledgeDb.query.workspaceBackups.findMany({
    where: (table, { and, eq, lt }) =>
      and(eq(table.status, "available"), lt(table.expiresAt, now)),
  });
  const storage = getStorageAdapter();
  for (const backup of expired) {
    if (backup.objectKey)
      await storage.deleteObject(backup.objectKey).catch(() => {});
    await knowledgeDb
      .update(schema.workspaceBackups)
      .set({ status: "expired", updatedAt: now })
      .where(eq(schema.workspaceBackups.id, backup.id));
  }
}

async function createDueDailyBackup(now: Date) {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  const candidates = await knowledgeDb.query.environmentWorkspaces.findMany({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.status, "ready"), isNull(table.deletedAt)),
    orderBy: (table, { asc }) => [asc(table.lastActivityAt), asc(table.id)],
  });
  if (candidates.length === 0) return;
  const recent = await knowledgeDb.query.workspaceBackups.findMany({
    where: (table, { and, eq, gt, inArray }) =>
      and(
        inArray(
          table.workspaceId,
          candidates.map((candidate) => candidate.id)
        ),
        eq(table.reason, "daily"),
        inArray(table.status, ["creating", "available"]),
        gt(table.createdAt, cutoff)
      ),
    columns: { workspaceId: true },
  });
  const candidate = selectDueDailyBackupCandidate(
    candidates,
    recent.map((backup) => backup.workspaceId)
  );
  if (!candidate) return;
  await createWorkspaceBackup({
    organizationId: candidate.organizationId,
    environmentId: candidate.environmentId,
    workspaceId: candidate.id,
    actorUserId: candidate.createdByUserId,
    reason: "daily",
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
