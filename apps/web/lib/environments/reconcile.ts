import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { WORKSPACE_READINESS_TIMEOUT_SECONDS } from "@lumi/kestrel-environment-auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getStorageAdapter } from "@/lib/storage";
import { completeDurableThreadTurn } from "@/lib/turns/store";
import { queueWorkspaceBackup } from "./backups";
import { createFlyProviderClient } from "./fly-connection";
import {
  PROVISIONER_OPERATION_TYPES,
  RESOURCE_MUTATING_OPERATION_TYPES,
} from "./operation-routing";
import { processEnvironmentOperation } from "./process-runtime";
import {
  EnvironmentProviderError,
  type EnvironmentProviderInventory,
} from "./providers/contracts";
import {
  type FlyMachinesClient,
  workspaceVolumeName,
} from "./providers/fly-machines";
import {
  assessWorkspaceMachineReadiness,
  assessWorkspaceVolumeBinding,
  retainedFailedRestoreResourceIds,
  selectOrphanVolumeIds,
} from "./reconcile-contract";
import { selectDueDailyBackupCandidate } from "./reconcile-selection";
import { hashEnvironmentServiceToken } from "./service-tokens";
import { refreshEnvironmentGateway } from "./gateway-refresh";
import {
  findActiveWorkspaceLifecycleOperation,
  hasActiveWorkspaceLifecycleOperation,
} from "./lifecycle-operations";
import { workspaceLifecycleLockKey } from "./lifecycle-lock";
import { recordWorkspaceReconciliationStatus } from "./reconciliation-status";

export async function reconcileHostedEnvironments() {
  const now = new Date();
  const repairedExecutionCount = await reconcileTerminalTurnExecutions();
  const recoverableOperations =
    await knowledgeDb.query.environmentOperations.findMany({
      where: (table, { and, inArray }) =>
        and(
          inArray(table.status, ["queued", "running"]),
          inArray(table.type, PROVISIONER_OPERATION_TYPES),
        ),
      columns: { id: true },
      limit: 100,
    });
  let operationFailureCount = 0;
  for (const operation of recoverableOperations) {
    try {
      await processEnvironmentOperation(operation.id);
    } catch (error) {
      operationFailureCount += 1;
      console.error("Hosted Environment operation reconciliation failed.", {
        operationId: operation.id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  let environmentGatewayCount = 0;
  let workspaceCount = 0;
  let adoptedVolumeCount = 0;
  let degradedWorkspaceCount = 0;
  const organizations = await knowledgeDb
    .selectDistinct({ organizationId: schema.environments.organizationId })
    .from(schema.environments)
    .where(isNull(schema.environments.archivedAt));
  for (const organization of organizations) {
    let result;
    try {
      result = await reconcileOrganizationEnvironments({
        provider: await createFlyProviderClient(organization.organizationId),
        organizationId: organization.organizationId,
        now,
      });
    } catch (error) {
      console.error("Organization Environment reconciliation failed.", {
        organizationId: organization.organizationId,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      continue;
    }
    environmentGatewayCount += result.environmentGatewayCount;
    workspaceCount += result.workspaceCount;
    adoptedVolumeCount += result.adoptedVolumeCount;
    degradedWorkspaceCount += result.degradedWorkspaceCount;
  }
  const finalizedPreviewCount = await reconcileClosingWorkspacePreviews(now);
  await expireWorkspaceBackups(now);
  await createDueDailyBackup(now);
  return {
    operationCount: recoverableOperations.length,
    operationFailureCount,
    repairedExecutionCount,
    environmentGatewayCount,
    workspaceCount,
    adoptedVolumeCount,
    degradedWorkspaceCount,
    finalizedPreviewCount,
  };
}

export async function reconcileTerminalTurnExecutions() {
  const turns = await knowledgeDb
    .select({
      id: schema.threadTurns.id,
      status: schema.threadTurns.status,
    })
    .from(schema.threadTurns)
    .innerJoin(
      schema.environmentRunExecutions,
      eq(
        schema.environmentRunExecutions.id,
        schema.threadTurns.environmentExecutionId,
      ),
    )
    .where(
      and(
        inArray(schema.threadTurns.status, [
          "completed",
          "failed",
          "cancelled",
        ]),
        inArray(schema.environmentRunExecutions.status, ["routed", "running"]),
      ),
    )
    .limit(100);
  for (const turn of turns) {
    await completeDurableThreadTurn({
      turnId: turn.id,
      status: turn.status as "completed" | "failed" | "cancelled",
    });
  }
  return turns.length;
}

async function reconcileOrganizationEnvironments(input: {
  provider: FlyMachinesClient;
  organizationId: string;
  now: Date;
}) {
  const { provider, organizationId, now } = input;
  const environmentGatewayCount = await reconcileEnvironmentGateways(
    provider,
    organizationId,
    now,
  );
  const workspaces = await knowledgeDb
    .select({
      workspace: schema.environmentWorkspaces,
      environment: schema.environments,
    })
    .from(schema.environmentWorkspaces)
    .innerJoin(
      schema.environments,
      eq(schema.environments.id, schema.environmentWorkspaces.environmentId),
    )
    .where(
      and(
        eq(schema.environmentWorkspaces.organizationId, organizationId),
        isNull(schema.environmentWorkspaces.deletedAt),
        inArray(schema.environmentWorkspaces.status, [
          "ready",
          "starting",
          "stopping",
          "stopped",
          "degraded",
        ]),
      ),
    );
  const inventoryByAppName = new Map<
    string,
    Promise<EnvironmentProviderInventory>
  >();
  let adoptedVolumeCount = 0;
  let degradedWorkspaceCount = 0;
  for (const { workspace, environment } of workspaces) {
    if (!(workspace.flyMachineId && environment.flyAppName)) continue;
    if (
      await hasActiveWorkspaceLifecycleOperation({
        organizationId,
        environmentId: environment.id,
        workspaceId: workspace.id,
      })
    ) {
      continue;
    }
    try {
      const machine = await provider.getMachine({
        appName: environment.flyAppName,
        machineId: workspace.flyMachineId,
      });
      if (!machine) {
        const degraded = await markWorkspaceDegraded(
          workspace,
          now,
          "ENVIRONMENT_WORKSPACE_MACHINE_MISSING",
          "Workspace Machine is missing during reconciliation.",
        );
        if (degraded) degradedWorkspaceCount += 1;
        continue;
      }
      let inventoryPromise = inventoryByAppName.get(environment.flyAppName);
      if (!inventoryPromise) {
        inventoryPromise = provider.listEnvironmentResources({
          appName: environment.flyAppName,
        });
        inventoryByAppName.set(environment.flyAppName, inventoryPromise);
      }
      const assessment = assessWorkspaceVolumeBinding({
        workspaceId: workspace.id,
        environmentRegion: environment.region,
        expectedVolumeName: workspaceVolumeName(workspace.id),
        recordedVolumeId: workspace.flyVolumeId,
        machine,
        inventory: await inventoryPromise,
      });
      if (assessment.status === "degraded") {
        const degraded = await markWorkspaceDegraded(
          workspace,
          now,
          "ENVIRONMENT_WORKSPACE_VOLUME_RECONCILE_FAILED",
          assessment.reason,
        );
        if (degraded) degradedWorkspaceCount += 1;
        continue;
      }
      if (assessment.status === "adopt") {
        const adopted = await adoptWorkspaceVolumeBinding({
          workspace,
          machineId: machine.id,
          oldVolumeId: assessment.oldVolumeId,
          newVolumeId: assessment.newVolumeId,
          reconciledAt: now,
        });
        if (!adopted) continue;
        adoptedVolumeCount += 1;
      }
      const appName = environment.flyAppName;
      const machineId = workspace.flyMachineId;
      const readiness = await assessWorkspaceMachineReadiness({
        machineState: machine.state,
        checkHealth: () =>
          provider.waitForMachineHealth({
            appName,
            machineId,
            checkName: "workspace",
            timeoutSeconds: WORKSPACE_READINESS_TIMEOUT_SECONDS,
          }),
      });
      if (readiness.status === "degraded") {
        const error = readiness.error;
        const code =
          error instanceof EnvironmentProviderError
            ? error.code
            : "ENVIRONMENT_WORKSPACE_RECONCILE_FAILED";
        const message =
          error instanceof Error
            ? error.message
            : "Workspace health reconciliation failed.";
        const degraded = await markWorkspaceDegraded(
          workspace,
          now,
          code,
          message,
        );
        if (degraded) degradedWorkspaceCount += 1;
        continue;
      }
      if (readiness.status === "ready") {
        await recordWorkspaceReconciliationStatus({
          organizationId: workspace.organizationId,
          environmentId: workspace.environmentId,
          workspaceId: workspace.id,
          status: "ready",
          reconciledAt: now,
        });
        continue;
      }
      if (readiness.status === "stopped") {
        await recordWorkspaceReconciliationStatus({
          organizationId: workspace.organizationId,
          environmentId: workspace.environmentId,
          workspaceId: workspace.id,
          status: "stopped",
          reconciledAt: now,
        });
      }
    } catch (error) {
      const degraded = await markWorkspaceDegraded(
        workspace,
        now,
        "ENVIRONMENT_WORKSPACE_RECONCILE_FAILED",
        error instanceof Error
          ? error.message
          : "Workspace reconciliation failed.",
      );
      if (degraded) degradedWorkspaceCount += 1;
    }
  }
  await cleanupReplacedWorkspaceResources(provider, organizationId);
  await cleanupOrphanedEnvironmentResources(provider, organizationId);
  return {
    environmentGatewayCount,
    workspaceCount: workspaces.length,
    adoptedVolumeCount,
    degradedWorkspaceCount,
  };
}

export async function reconcileClosingWorkspacePreviews(now = new Date()) {
  const environments = await knowledgeDb
    .selectDistinct({
      organizationId: schema.workspacePreviewLeases.organizationId,
      environmentId: schema.workspacePreviewLeases.environmentId,
    })
    .from(schema.workspacePreviewLeases)
    .where(eq(schema.workspacePreviewLeases.status, "closing"));
  let finalized = 0;
  for (const environment of environments) {
    try {
      await refreshEnvironmentGateway(environment);
      const closed = await knowledgeDb
        .update(schema.workspacePreviewLeases)
        .set({ status: "closed", closedAt: now, updatedAt: now })
        .where(
          and(
            eq(
              schema.workspacePreviewLeases.environmentId,
              environment.environmentId,
            ),
            eq(schema.workspacePreviewLeases.status, "closing"),
          ),
        )
        .returning({ id: schema.workspacePreviewLeases.id });
      finalized += closed.length;
    } catch {}
  }
  return finalized;
}

async function markWorkspaceDegraded(
  workspace: typeof schema.environmentWorkspaces.$inferSelect,
  now: Date,
  failureCode: string,
  failureMessage: string,
) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(workspace.id)}, 0))`,
    );
    const active = await findActiveWorkspaceLifecycleOperation(transaction, {
      organizationId: workspace.organizationId,
      environmentId: workspace.environmentId,
      workspaceId: workspace.id,
    });
    if (active) return false;
    const [updated] = await transaction
      .update(schema.environmentWorkspaces)
      .set({
        status: "degraded",
        failureCode,
        failureMessage,
        updatedAt: now,
      })
      .where(eq(schema.environmentWorkspaces.id, workspace.id))
      .returning({ id: schema.environmentWorkspaces.id });
    return Boolean(updated);
  });
}

async function adoptWorkspaceVolumeBinding(input: {
  workspace: typeof schema.environmentWorkspaces.$inferSelect;
  machineId: string;
  oldVolumeId: string | null;
  newVolumeId: string;
  reconciledAt: Date;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(input.workspace.id)}, 0))`,
    );
    const active = await findActiveWorkspaceLifecycleOperation(tx, {
      organizationId: input.workspace.organizationId,
      environmentId: input.workspace.environmentId,
      workspaceId: input.workspace.id,
    });
    if (active) return false;
    const oldVolumeCondition = input.oldVolumeId
      ? eq(schema.environmentWorkspaces.flyVolumeId, input.oldVolumeId)
      : isNull(schema.environmentWorkspaces.flyVolumeId);
    const updated = await tx
      .update(schema.environmentWorkspaces)
      .set({
        flyVolumeId: input.newVolumeId,
        updatedAt: input.reconciledAt,
      })
      .where(
        and(
          eq(schema.environmentWorkspaces.id, input.workspace.id),
          eq(schema.environmentWorkspaces.flyMachineId, input.machineId),
          oldVolumeCondition,
          isNull(schema.environmentWorkspaces.deletedAt),
        ),
      )
      .returning({ id: schema.environmentWorkspaces.id });
    if (!updated[0]) return false;
    await tx.insert(schema.environmentOperations).values({
      id: crypto.randomUUID(),
      organizationId: input.workspace.organizationId,
      environmentId: input.workspace.environmentId,
      workspaceId: input.workspace.id,
      type: "workspace.reconcile",
      status: "completed",
      stage: "workspace.reconcile.volume_binding_adopted",
      idempotencyKey:
        `workspace.reconcile:${input.workspace.id}:` +
        `${input.oldVolumeId ?? "missing"}:${input.newVolumeId}`,
      result: {
        oldVolumeId: input.oldVolumeId,
        newVolumeId: input.newVolumeId,
        machineId: input.machineId,
        workspaceId: input.workspace.id,
        reconciledAt: input.reconciledAt.toISOString(),
      },
      startedAt: input.reconciledAt,
      completedAt: input.reconciledAt,
      createdAt: input.reconciledAt,
      updatedAt: input.reconciledAt,
    });
    return true;
  });
}

async function reconcileEnvironmentGateways(
  provider: FlyMachinesClient,
  organizationId: string,
  now: Date,
) {
  const activeUpdates = await knowledgeDb.query.environmentOperations.findMany({
    where: (table, { and, eq, inArray }) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.type, "environment.update"),
        inArray(table.status, ["queued", "running"]),
      ),
    columns: { environmentId: true },
  });
  const updatingEnvironmentIds = new Set(
    activeUpdates.map((operation) => operation.environmentId),
  );
  const environments = await knowledgeDb.query.environments.findMany({
    where: (table, { and, inArray, isNotNull, isNull }) =>
      and(
        eq(table.organizationId, organizationId),
        inArray(table.status, ["ready", "degraded"]),
        isNotNull(table.flyAppName),
        isNotNull(table.routerImage),
        isNull(table.archivedAt),
      ),
  });
  const ticketPublicKey =
    process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "";
  for (const environment of environments) {
    if (!(environment.flyAppName && environment.routerImage)) continue;
    if (updatingEnvironmentIds.has(environment.id)) continue;
    try {
      const gateway = await provider.ensureEnvironmentGateway({
        appName: environment.flyAppName,
        environmentId: environment.id,
        region: environment.region,
        runtimeImage: environment.routerImage,
        ticketPublicKey,
        controlPlaneUrl: process.env.KESTREL_ONE_APP_URL ?? "",
      });
      const gatewayServiceTokenHash = hashEnvironmentServiceToken(
        gateway.serviceToken,
      );
      if (environment.gatewayServiceTokenHash !== gatewayServiceTokenHash) {
        await knowledgeDb
          .update(schema.environments)
          .set({ gatewayServiceTokenHash, updatedAt: new Date() })
          .where(eq(schema.environments.id, environment.id));
      }
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
  provider: FlyMachinesClient,
  organizationId: string,
) {
  const environments = await knowledgeDb.query.environments.findMany({
    where: (table, { and, isNotNull, isNull }) =>
      and(
        eq(table.organizationId, organizationId),
        isNotNull(table.flyAppName),
        isNull(table.archivedAt),
      ),
  });
  for (const environment of environments) {
    if (!environment.flyAppName) continue;
    const activeOperation =
      await knowledgeDb.query.environmentOperations.findFirst({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.environmentId, environment.id),
            inArray(table.status, ["queued", "running"]),
            inArray(table.type, RESOURCE_MUTATING_OPERATION_TYPES),
          ),
        columns: { id: true },
      });
    if (activeOperation) continue;
    const workspaces = await knowledgeDb.query.environmentWorkspaces.findMany({
      where: (table, { and, eq, isNull }) =>
        and(eq(table.environmentId, environment.id), isNull(table.deletedAt)),
      columns: { flyMachineId: true, flyVolumeId: true },
    });
    const retainedRestores =
      await knowledgeDb.query.environmentOperations.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.environmentId, environment.id),
            eq(table.type, "workspace.restore"),
            eq(table.status, "failed"),
            eq(
              table.stage,
              "workspace.restore.post_cutover_validation_failed",
            ),
          ),
        columns: { result: true },
      });
    const retainedResources = retainedFailedRestoreResourceIds(
      retainedRestores.map((operation) => operation.result),
    );
    const activeMachineIds = new Set([
      ...(environment.flyGatewayMachineId
        ? [environment.flyGatewayMachineId]
        : []),
      ...retainedResources.machineIds,
      ...workspaces.flatMap((workspace) =>
        workspace.flyMachineId ? [workspace.flyMachineId] : [],
      ),
    ]);
    const activeVolumeIds = new Set(
      [
        ...retainedResources.volumeIds,
        ...workspaces.flatMap((workspace) =>
          workspace.flyVolumeId ? [workspace.flyVolumeId] : [],
        ),
      ],
    );
    const inventory = await provider.listEnvironmentResources({
      appName: environment.flyAppName,
    });
    const orphanMachineIds = inventory.machines
      .filter((machine) => !activeMachineIds.has(machine.id))
      .map((machine) => machine.id)
      .sort();
    const orphanVolumeIds = selectOrphanVolumeIds({
      inventory,
      activeVolumeIds,
    });
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

async function cleanupReplacedWorkspaceResources(
  provider: FlyMachinesClient,
  organizationId: string,
) {
  const operations = await knowledgeDb.query.environmentOperations.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.type, "workspace.restore"),
        eq(table.status, "completed"),
        eq(table.stage, "workspace.restore.rebound_cleanup_pending"),
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
  const [recent, active] = await Promise.all([
    knowledgeDb.query.workspaceBackups.findMany({
      where: (table, { and, eq, gt, inArray }) =>
        and(
          inArray(
            table.workspaceId,
            candidates.map((candidate) => candidate.id),
          ),
          eq(table.reason, "daily"),
          inArray(table.status, ["creating", "available"]),
          gt(table.createdAt, cutoff),
        ),
      columns: { workspaceId: true },
    }),
    knowledgeDb.query.workspaceBackups.findMany({
      where: (table, { and, inArray }) =>
        and(
          inArray(
            table.workspaceId,
            candidates.map((candidate) => candidate.id),
          ),
          inArray(table.status, ["queued", "creating"]),
        ),
      columns: { workspaceId: true },
    }),
  ]);
  const candidate = selectDueDailyBackupCandidate(
    candidates,
    [...recent, ...active].map((backup) => backup.workspaceId),
  );
  if (!candidate) return;
  await queueWorkspaceBackup({
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
