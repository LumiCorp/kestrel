import { and, eq, inArray, isNull } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import {
  fanoutStatus,
  selectRuntimeDeploymentScope,
  shouldAssignRuntimeTarget,
} from "./policy";

type ReconciliationMode = "observe" | "active";
type EnvironmentRow = typeof schema.environments.$inferSelect;

export async function reconcilePlatformRuntimeDeployments(input: {
  mode?: ReconciliationMode | undefined;
} = {}) {
  const mode =
    input.mode ??
    (process.env.KESTREL_PLATFORM_RUNTIME_RECONCILIATION_MODE === "active"
      ? "active"
      : "observe");
  const settings = await knowledgeDb.query.platformRuntimeSettings.findFirst({
    where: eq(schema.platformRuntimeSettings.id, "platform"),
  });
  if (
    !settings?.desiredRouterImage ||
    !settings.desiredRuntimeImage ||
    !settings.desiredSourceRevision ||
    settings.generation < 1
  ) {
    return { mode, generation: settings?.generation ?? 0, planned: [], queued: 0 };
  }
  if (settings.status === "rejected" || settings.status === "blocked") {
    return { mode, generation: settings.generation, planned: [], queued: 0 };
  }
  const environments = await knowledgeDb.query.environments.findMany({
    where: (table, { and, eq, inArray, isNull }) =>
      and(
        eq(table.provider, "fly"),
        inArray(table.status, ["ready", "degraded"]),
        isNull(table.archivedAt),
      ),
  });
  const scope = selectRuntimeDeploymentScope({
    status: settings.status,
    canaryEnvironmentId: settings.canaryEnvironmentId,
    environments,
  });
  const { canaryOnly } = scope;
  const eligible = scope.environments;
  if (canaryOnly && eligible.length !== 1) {
    if (mode === "active") {
      await markPlatformBlocked(
        settings.generation,
        "PLATFORM_RUNTIME_CANARY_UNAVAILABLE",
        "The persistent canary Environment is unavailable.",
      );
    }
    return {
      mode,
      generation: settings.generation,
      planned: ["canary:unavailable"],
      queued: 0,
    };
  }

  const planned: string[] = [];
  const queuedOperationIds: string[] = [];
  let blockedResourceCount = 0;
  let pinnedResourceCount = 0;
  let convergedEnvironmentCount = 0;
  const now = new Date();
  for (const original of eligible) {
    const shouldAssign = shouldAssignRuntimeTarget({
      status: settings.status,
      targetGeneration: original.targetGeneration,
      generation: settings.generation,
      targetSourceRevision: original.targetSourceRevision,
      desiredSourceRevision: settings.desiredSourceRevision,
      targetRouterImage: original.targetRouterImage,
      desiredRouterImage: settings.desiredRouterImage,
      targetRuntimeImage: original.targetRuntimeImage,
      desiredRuntimeImage: settings.desiredRuntimeImage,
    });
    const environment: EnvironmentRow = shouldAssign
      ? {
          ...original,
          targetGeneration: settings.generation,
          targetSourceRevision: settings.desiredSourceRevision,
          targetRouterImage: settings.desiredRouterImage,
          targetRuntimeImage: settings.desiredRuntimeImage,
        }
      : original;
    if (
      !shouldAssign &&
      (environment.targetSourceRevision !== settings.desiredSourceRevision ||
        environment.targetRouterImage !== settings.desiredRouterImage ||
        environment.targetRuntimeImage !== settings.desiredRuntimeImage)
    ) {
      pinnedResourceCount += 1;
      planned.push(`environment:${environment.id}:pinned`);
    }
    if (shouldAssign) {
      planned.push(`environment:${environment.id}:target`);
      if (mode === "active") {
        await knowledgeDb
          .update(schema.environments)
          .set({
            targetGeneration: settings.generation,
            targetSourceRevision: settings.desiredSourceRevision,
            targetRouterImage: settings.desiredRouterImage,
            targetRuntimeImage: settings.desiredRuntimeImage,
            updatedAt: now,
          })
          .where(eq(schema.environments.id, environment.id));
      }
    }

    const gatewayOperation = await currentGenerationOperation({
      generation: settings.generation,
      environmentId: environment.id,
      type: "environment.gateway.update",
    });
    if (environment.routerImage !== environment.targetRouterImage) {
      planned.push(`environment:${environment.id}:gateway`);
      if (gatewayOperation?.status === "failed") {
        blockedResourceCount += 1;
        continue;
      }
      if (!gatewayOperation && mode === "active" && environment.targetRouterImage) {
        const id = await createGatewayOperation({
          environment,
          generation: settings.generation,
          sourceRevision: settings.desiredSourceRevision,
          routerImage: environment.targetRouterImage,
          priorImage: environment.routerImage,
          now,
        });
        if (id) queuedOperationIds.push(id);
      }
      continue;
    }

    const workspaces = await knowledgeDb.query.environmentWorkspaces.findMany({
      where: (table, { and, eq, isNull, inArray }) =>
        and(
          eq(table.environmentId, environment.id),
          isNull(table.deletedAt),
          inArray(table.status, ["ready", "starting", "degraded", "stopped"]),
        ),
    });
    let environmentBlocked = false;
    let environmentPending = false;
    let environmentPinned = false;
    for (const workspace of workspaces) {
      if (workspace.status === "stopped") continue;
      if (workspace.runtimeImage === environment.targetRuntimeImage) continue;
      planned.push(`workspace:${workspace.id}:runtime`);
      const operation = await currentGenerationOperation({
        generation: settings.generation,
        environmentId: environment.id,
        workspaceId: workspace.id,
        type: "workspace.rebuild",
      });
      if (operation?.status === "failed") {
        blockedResourceCount += 1;
        environmentBlocked = true;
        continue;
      }
      if (
        operation?.status === "completed" &&
        operation.input?.resourceRollback === true
      ) {
        pinnedResourceCount += 1;
        environmentPinned = true;
        planned.push(`workspace:${workspace.id}:pinned`);
        continue;
      }
      environmentPending = true;
      if (!operation && mode === "active" && environment.targetRuntimeImage) {
        const id = await createWorkspaceOperation({
          environment,
          workspace,
          generation: settings.generation,
          sourceRevision: settings.desiredSourceRevision,
          runtimeImage: environment.targetRuntimeImage,
          workspaceDataMigrationRevision:
            settings.workspaceDataMigrationRevision,
          now,
        });
        if (id) queuedOperationIds.push(id);
      }
    }
    if (!environmentPending && !environmentBlocked && !environmentPinned) {
      convergedEnvironmentCount += 1;
      if (
        mode === "active" &&
        environment.runtimeImage !== environment.targetRuntimeImage
      ) {
        await knowledgeDb
          .update(schema.environments)
          .set({
            runtimeImage: environment.targetRuntimeImage,
            failureCode: null,
            failureMessage: null,
            updatedAt: now,
          })
          .where(eq(schema.environments.id, environment.id));
      }
    }
  }

  if (mode === "active") {
    if (canaryOnly && convergedEnvironmentCount === 1 && blockedResourceCount === 0) {
      await knowledgeDb
        .update(schema.platformRuntimeSettings)
        .set({
          activeSourceRevision: settings.desiredSourceRevision,
          activeRouterImage: settings.desiredRouterImage,
          activeRuntimeImage: settings.desiredRuntimeImage,
          status: environments.length > 1 ? "fanout" : "ready",
          lastFailureCode: null,
          lastFailureMessage: null,
          lastFailureAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.platformRuntimeSettings.id, "platform"),
            eq(schema.platformRuntimeSettings.generation, settings.generation),
          ),
        );
    } else if (!canaryOnly) {
      await knowledgeDb
        .update(schema.platformRuntimeSettings)
        .set({
          status: fanoutStatus({
            blockedResourceCount: blockedResourceCount + pinnedResourceCount,
            convergedEnvironmentCount,
            eligibleEnvironmentCount: eligible.length,
          }),
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.platformRuntimeSettings.id, "platform"),
            eq(schema.platformRuntimeSettings.generation, settings.generation),
          ),
        );
    }
  }
  await Promise.all(
    queuedOperationIds.map((operationId) =>
      enqueueEnvironmentOperation(operationId),
    ),
  );
  return {
    mode,
    generation: settings.generation,
    planned,
    queued: queuedOperationIds.length,
    blockedResourceCount,
    pinnedResourceCount,
    convergedEnvironmentCount,
  };
}

async function currentGenerationOperation(input: {
  generation: number;
  environmentId: string;
  workspaceId?: string | undefined;
  type: "environment.gateway.update" | "workspace.rebuild";
}) {
  const operations = await knowledgeDb.query.environmentOperations.findMany({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.environmentId, input.environmentId),
        eq(table.type, input.type),
        input.workspaceId
          ? eq(table.workspaceId, input.workspaceId)
          : isNull(table.workspaceId),
      ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    limit: 10,
  });
  return (
    operations.find(
      (operation) => operation.input?.targetGeneration === input.generation,
    ) ?? null
  );
}

async function createGatewayOperation(input: {
  environment: typeof schema.environments.$inferSelect;
  generation: number;
  sourceRevision: string;
  routerImage: string;
  priorImage: string | null;
  now: Date;
}) {
  const [operation] = await knowledgeDb
    .insert(schema.environmentOperations)
    .values({
      organizationId: input.environment.organizationId,
      environmentId: input.environment.id,
      type: "environment.gateway.update",
      status: "queued",
      stage: "platform.gateway.queued",
      idempotencyKey: `platform-runtime:${input.generation}:gateway:${input.environment.id}`,
      input: {
        targetGeneration: input.generation,
        sourceRevision: input.sourceRevision,
        routerImage: input.routerImage,
        priorImage: input.priorImage,
        retryDeadline: new Date(
          input.now.getTime() + 60 * 60 * 1000,
        ).toISOString(),
      },
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.environmentOperations.id });
  return operation?.id ?? null;
}

async function createWorkspaceOperation(input: {
  environment: typeof schema.environments.$inferSelect;
  workspace: typeof schema.environmentWorkspaces.$inferSelect;
  generation: number;
  sourceRevision: string;
  runtimeImage: string;
  workspaceDataMigrationRevision: string | null;
  now: Date;
}) {
  const [operation] = await knowledgeDb
    .insert(schema.environmentOperations)
    .values({
      organizationId: input.environment.organizationId,
      environmentId: input.environment.id,
      workspaceId: input.workspace.id,
      type: "workspace.rebuild",
      status: "queued",
      stage: "platform.workspace.queued",
      idempotencyKey: `platform-runtime:${input.generation}:workspace:${input.workspace.id}`,
      input: {
        targetGeneration: input.generation,
        sourceRevision: input.sourceRevision,
        runtimeImage: input.runtimeImage,
        priorImage: input.workspace.runtimeImage,
        retryDeadline: new Date(
          input.now.getTime() + 60 * 60 * 1000,
        ).toISOString(),
        workspaceDataMigrationRevision: input.workspaceDataMigrationRevision,
      },
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.environmentOperations.id });
  return operation?.id ?? null;
}

async function markPlatformBlocked(
  generation: number,
  code: string,
  message: string,
) {
  const now = new Date();
  await knowledgeDb
    .update(schema.platformRuntimeSettings)
    .set({
      status: "blocked",
      lastFailureCode: code,
      lastFailureMessage: message,
      lastFailureAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.platformRuntimeSettings.id, "platform"),
        eq(schema.platformRuntimeSettings.generation, generation),
      ),
    );
}
