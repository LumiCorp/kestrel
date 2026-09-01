import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getStorageAdapter } from "@/lib/storage";
import { completeDurableThreadTurn } from "@/lib/turns/store";
import { queueWorkspaceBackup } from "./backups";
import {
  workspaceDailyBackupDayStart,
  workspaceDailyBackupIdempotencyKey,
} from "./daily-backup-contract";
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
  describeEnvironmentGatewayReconcileFailure,
  retainedFailedRestoreResourceIds,
  selectOrphanMachineIds,
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
import { reconcileHostedBrowserSessionsForEnvironment } from "@/lib/browser/reconciliation";
import { HostedBrowserStore } from "@/lib/browser/store";

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
  let volumeBackupPolicyFailureCount = 0;
  let browserSessionCount = 0;
  let healthyBrowserSessionCount = 0;
  let expiredBrowserSessionCount = 0;
  let lostBrowserSessionCount = 0;
  let cleanedBrowserSessionCount = 0;
  let orphanBrowserMachineCount = 0;
  let browserReconciliationFailureCount = 0;
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
    volumeBackupPolicyFailureCount += result.volumeBackupPolicyFailureCount;
    browserSessionCount += result.browser.scannedSessions;
    healthyBrowserSessionCount += result.browser.healthySessions;
    expiredBrowserSessionCount += result.browser.expiredSessions;
    lostBrowserSessionCount += result.browser.lostSessions;
    cleanedBrowserSessionCount += result.browser.cleanedSessions;
    orphanBrowserMachineCount += result.browser.orphanMachinesDeleted;
    browserReconciliationFailureCount += result.browser.failureCount;
  }
  const finalizedPreviewCount = await reconcileClosingWorkspacePreviews(now);
  const backupLifecycle = await expireWorkspaceBackups(now);
  await createDueDailyBackup(now);
  return {
    operationCount: recoverableOperations.length,
    operationFailureCount,
    repairedExecutionCount,
    environmentGatewayCount,
    workspaceCount,
    adoptedVolumeCount,
    degradedWorkspaceCount,
    volumeBackupPolicyFailureCount,
    browserSessionCount,
    healthyBrowserSessionCount,
    expiredBrowserSessionCount,
    lostBrowserSessionCount,
    cleanedBrowserSessionCount,
    orphanBrowserMachineCount,
    browserReconciliationFailureCount,
    finalizedPreviewCount,
    backupLifecycle,
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
  const browser = {
    scannedSessions: 0,
    healthySessions: 0,
    expiredSessions: 0,
    lostSessions: 0,
    cleanedSessions: 0,
    orphanMachinesDeleted: 0,
    failureCount: 0,
  };
  const browserEnvironments = await knowledgeDb.query.environments.findMany({
    where: (table, { and: all, eq: equals, isNotNull, isNull: isNullValue }) =>
      all(
        equals(table.organizationId, organizationId),
        equals(table.provider, "fly"),
        isNotNull(table.flyAppName),
        isNullValue(table.archivedAt),
      ),
    columns: { id: true, flyAppName: true, region: true },
  });
  const browserStore = new HostedBrowserStore();
  for (const environment of browserEnvironments) {
    if (!environment.flyAppName) continue;
    try {
      const result = await reconcileHostedBrowserSessionsForEnvironment({
        organizationId,
        environmentId: environment.id,
        appName: environment.flyAppName,
        region: environment.region,
        workerImageDigest:
          process.env.KESTREL_BROWSER_WORKER_IMAGE?.trim() ?? "",
        store: browserStore,
        machines: provider,
        now,
        onFailure(error, metadata) {
          console.error("Hosted Browser reconciliation item failed.", {
            ...metadata,
            message: error instanceof Error ? error.message : "Unknown error",
          });
        },
      });
      browser.scannedSessions += result.scannedSessions;
      browser.healthySessions += result.healthySessions;
      browser.expiredSessions += result.expiredSessions;
      browser.lostSessions += result.lostSessions;
      browser.cleanedSessions += result.cleanedSessions;
      browser.orphanMachinesDeleted += result.orphanMachinesDeleted;
      browser.failureCount += result.failureCount;
    } catch (error) {
      browser.failureCount += 1;
      console.error("Hosted Browser Environment reconciliation failed.", {
        organizationId,
        environmentId: environment.id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
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
  let volumeBackupPolicyFailureCount = 0;
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
      const policyVolumeId =
        assessment.status === "adopt"
          ? assessment.newVolumeId
          : workspace.flyVolumeId;
      if (policyVolumeId && provider.reconcileWorkspaceVolumeBackupPolicy) {
        try {
          await provider.reconcileWorkspaceVolumeBackupPolicy({
            appName: environment.flyAppName,
            volumeId: policyVolumeId,
          });
        } catch (error) {
          volumeBackupPolicyFailureCount += 1;
          console.error(
            "Workspace Volume backup policy reconciliation failed.",
            {
              workspaceId: workspace.id,
              volumeId: policyVolumeId,
              message: error instanceof Error ? error.message : "Unknown error",
            },
          );
        }
      }
      const readiness = await assessWorkspaceMachineReadiness({
        machineState: machine.state,
        checks: machine.checks,
        checkName: "workspace",
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
    volumeBackupPolicyFailureCount,
    browser,
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
    } catch (error) {
      const failure = describeEnvironmentGatewayReconcileFailure(error);
      console.error("Environment gateway reconciliation failed.", {
        environmentId: environment.id,
        code: failure.code,
        status: failure.status,
      });
      await knowledgeDb
        .update(schema.environments)
        .set({
          status: "degraded",
          failureCode: failure.code,
          failureMessage: failure.message,
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
    const activeBackup =
      await knowledgeDb.query.environmentOperations.findFirst({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.environmentId, environment.id),
            eq(table.type, "workspace.backup"),
            inArray(table.status, ["queued", "running"]),
          ),
        columns: { id: true },
      });
    if (activeBackup) continue;
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
            eq(table.stage, "workspace.restore.post_cutover_validation_failed"),
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
    const browserMachines = await provider.listBrowserMachines({
      appName: environment.flyAppName,
    });
    for (const machine of browserMachines) activeMachineIds.add(machine.id);
    const activeVolumeIds = new Set([
      ...retainedResources.volumeIds,
      ...workspaces.flatMap((workspace) =>
        workspace.flyVolumeId ? [workspace.flyVolumeId] : [],
      ),
    ]);
    const inventory = await provider.listEnvironmentResources({
      appName: environment.flyAppName,
    });
    const orphanMachineIds = selectOrphanMachineIds({
      inventory,
      activeMachineIds,
    });
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

export async function expireWorkspaceBackups(now: Date, limit = 100) {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const counters = {
    inspected: 0,
    unchanged: 0,
    created: 0,
    reused: 0,
    expired: 0,
    deletionFailed: 0,
    oversized: 0,
  };
  const expiredProtectionRows =
    await knowledgeDb.query.workspaceBackupProtections.findMany({
      where: (table, { lt }) => lt(table.expiresAt, now),
      columns: { id: true },
      orderBy: (table, { asc }) => [asc(table.expiresAt), asc(table.id)],
      limit: boundedLimit,
    });
  counters.inspected += expiredProtectionRows.length;
  if (expiredProtectionRows.length > 0) {
    await knowledgeDb.delete(schema.workspaceBackupProtections).where(
      inArray(
        schema.workspaceBackupProtections.id,
        expiredProtectionRows.map((row) => row.id),
      ),
    );
  }
  const artifactLimit = remainingBackupLifecycleBatchBudget(
    boundedLimit,
    counters.inspected,
  );
  const expired =
    artifactLimit === 0
      ? []
      : await knowledgeDb
          .select({ backup: schema.workspaceBackups })
          .from(schema.workspaceBackups)
          .leftJoin(
            schema.workspaceBackupProtections,
            and(
              eq(
                schema.workspaceBackupProtections.backupId,
                schema.workspaceBackups.id,
              ),
              gt(schema.workspaceBackupProtections.expiresAt, now),
            ),
          )
          .where(
            and(
              inArray(schema.workspaceBackups.status, [
                "available",
                "deleting",
                "delete_failed",
              ]),
              isNull(schema.workspaceBackupProtections.id),
            ),
          )
          .orderBy(schema.workspaceBackups.expiresAt, schema.workspaceBackups.id)
          .limit(artifactLimit);
  counters.inspected += expired.length;
  const storage = getStorageAdapter();
  for (const { backup } of expired) {
    await knowledgeDb
      .update(schema.workspaceBackups)
      .set({ status: "deleting", updatedAt: now })
      .where(eq(schema.workspaceBackups.id, backup.id));
    try {
      if (backup.objectKey) await storage.deleteObject(backup.objectKey);
      await knowledgeDb
        .update(schema.workspaceBackups)
        .set({ status: "expired", updatedAt: now })
        .where(eq(schema.workspaceBackups.id, backup.id));
      counters.expired += 1;
    } catch {
      await knowledgeDb
        .update(schema.workspaceBackups)
        .set({ status: "delete_failed", updatedAt: now })
        .where(eq(schema.workspaceBackups.id, backup.id));
      counters.deletionFailed += 1;
    }
  }
  const tombstoneCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const tombstoneLimit = remainingBackupLifecycleBatchBudget(
    boundedLimit,
    counters.inspected,
  );
  const tombstones =
    tombstoneLimit === 0
      ? []
      : await knowledgeDb.query.workspaceBackups.findMany({
          where: (table, { and, inArray, lt }) =>
            and(
              inArray(table.status, ["failed", "expired"]),
              lt(table.updatedAt, tombstoneCutoff),
            ),
          columns: { id: true, objectKey: true },
          orderBy: (table, { asc }) => [asc(table.updatedAt), asc(table.id)],
          limit: tombstoneLimit,
        });
  counters.inspected += tombstones.length;
  for (const tombstone of tombstones) {
    try {
      if (tombstone.objectKey) {
        await storage.deleteObject(tombstone.objectKey);
      }
      await knowledgeDb
        .delete(schema.workspaceBackups)
        .where(eq(schema.workspaceBackups.id, tombstone.id));
    } catch {
      await knowledgeDb
        .update(schema.workspaceBackups)
        .set({ status: "delete_failed", updatedAt: now })
        .where(eq(schema.workspaceBackups.id, tombstone.id));
      counters.deletionFailed += 1;
    }
  }
  console.info("Workspace backup lifecycle reconciliation completed.", {
    batchLimit: boundedLimit,
    ...counters,
  });
  return counters;
}

export function remainingBackupLifecycleBatchBudget(
  batchLimit: number,
  inspected: number,
) {
  return Math.max(0, Math.min(100, batchLimit) - inspected);
}

async function createDueDailyBackup(now: Date) {
  const dayStart = workspaceDailyBackupDayStart(now);
  const candidates = await knowledgeDb.query.environmentWorkspaces.findMany({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.status, "ready"), isNull(table.deletedAt)),
    orderBy: (table, { asc }) => [asc(table.lastActivityAt), asc(table.id)],
  });
  if (candidates.length === 0) return;
  const [scheduledToday, activeBackups, activeExecutions] = await Promise.all([
    knowledgeDb.query.workspaceBackups.findMany({
      where: (table, { and, eq, gte, inArray }) =>
        and(
          inArray(
            table.workspaceId,
            candidates.map((candidate) => candidate.id),
          ),
          eq(table.reason, "daily"),
          gte(table.createdAt, dayStart),
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
    knowledgeDb.query.environmentRunExecutions.findMany({
      where: (table, { and, inArray }) =>
        and(
          inArray(
            table.workspaceId,
            candidates.map((candidate) => candidate.id),
          ),
          inArray(table.status, ["routed", "running"]),
        ),
      columns: { workspaceId: true },
    }),
  ]);
  const candidate = selectDueDailyBackupCandidate(
    candidates,
    [...scheduledToday, ...activeBackups, ...activeExecutions].map(
      (record) => record.workspaceId,
    ),
  );
  if (!candidate) return;
  await queueWorkspaceBackup({
    organizationId: candidate.organizationId,
    environmentId: candidate.environmentId,
    workspaceId: candidate.id,
    actorUserId: candidate.createdByUserId,
    reason: "daily",
    idempotencyKey: workspaceDailyBackupIdempotencyKey(candidate.id, now),
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
