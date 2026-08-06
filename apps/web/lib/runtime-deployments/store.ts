import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import type { PlatformImagePublication } from "./contracts";

export class PlatformRuntimeDeploymentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function publishPlatformImages(input: PlatformImagePublication) {
  const now = new Date();
  const operationIds = await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`select "id" from "platform_runtime_settings" where "id" = 'platform' for update`,
    );
    const settings = await transaction.query.platformRuntimeSettings.findFirst({
      where: eq(schema.platformRuntimeSettings.id, "platform"),
    });
    if (!settings) {
      throw new PlatformRuntimeDeploymentError(
        "PLATFORM_RUNTIME_SETTINGS_MISSING",
        "Platform runtime settings have not been migrated.",
      );
    }
    if (!settings.canaryEnvironmentId) {
      throw new PlatformRuntimeDeploymentError(
        "PLATFORM_RUNTIME_CANARY_MISSING",
        "A persistent canary Environment must be configured before publication.",
      );
    }
    const matchesDesired =
      settings.desiredSourceRevision === input.sourceRevision &&
      settings.desiredRouterImage === input.routerImage &&
      settings.desiredRuntimeImage === input.runtimeImage &&
      settings.mode === input.rollout.mode &&
      settings.workspaceDataMigrationRevision ===
        input.rollout.workspaceDataMigrationRevision;
    if (matchesDesired) return [];

    const generation = settings.generation + 1;
    const retryDeadline = new Date(now.getTime() + 60 * 60 * 1000);
    const nextStatus =
      input.rollout.mode === "maintenance" ? "maintenance" : "canary";
    await transaction
      .update(schema.platformRuntimeSettings)
      .set({
        generation,
        priorSourceRevision: settings.activeSourceRevision,
        priorRouterImage: settings.activeRouterImage,
        priorRuntimeImage: settings.activeRuntimeImage,
        desiredSourceRevision: input.sourceRevision,
        desiredRouterImage: input.routerImage,
        desiredRuntimeImage: input.runtimeImage,
        mode: input.rollout.mode,
        status: nextStatus,
        workspaceDataMigrationRevision:
          input.rollout.workspaceDataMigrationRevision,
        lastFailureCode: null,
        lastFailureMessage: null,
        lastFailureAt: null,
        publishedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.platformRuntimeSettings.id, "platform"));
    await transaction
      .update(schema.environments)
      .set({
        targetRouterImage: settings.activeRouterImage,
        targetRuntimeImage: settings.activeRuntimeImage,
        targetSourceRevision: settings.activeSourceRevision,
        targetGeneration: generation,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.environments.provider, "fly"),
          isNull(schema.environments.archivedAt),
        ),
      );
    await transaction
      .update(schema.environments)
      .set({
        targetRouterImage: input.routerImage,
        targetRuntimeImage: input.runtimeImage,
        targetSourceRevision: input.sourceRevision,
        targetGeneration: generation,
        updatedAt: now,
      })
      .where(eq(schema.environments.id, settings.canaryEnvironmentId));
    const [operation] = await transaction
      .insert(schema.environmentOperations)
      .values({
        organizationId: sql`(select "organization_id" from "environments" where "id" = ${settings.canaryEnvironmentId})`,
        environmentId: settings.canaryEnvironmentId,
        type: "environment.gateway.update",
        status: "queued",
        stage: "platform.gateway.queued",
        idempotencyKey: `platform-runtime:${generation}:gateway:${settings.canaryEnvironmentId}`,
        input: {
          targetGeneration: generation,
          sourceRevision: input.sourceRevision,
          routerImage: input.routerImage,
          priorImage: settings.activeRouterImage,
          retryDeadline: retryDeadline.toISOString(),
        },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.environmentOperations.id });
    return operation ? [operation.id] : [];
  });
  await Promise.all(operationIds.map((id) => enqueueEnvironmentOperation(id)));
  return getPlatformImagePublicationState(input.sourceRevision);
}

export async function getPlatformImagePublicationState(sourceRevision?: string) {
  const deployment = await getRuntimeDeploymentStatus();
  if (
    sourceRevision &&
    deployment.platform.desiredSourceRevision !== sourceRevision
  ) {
    return {
      ...deployment,
      superseded: true,
      requestedSourceRevision: sourceRevision,
    };
  }
  return { ...deployment, superseded: false };
}

export async function getRuntimeDeploymentStatus() {
  const settings = await knowledgeDb.query.platformRuntimeSettings.findFirst({
    where: eq(schema.platformRuntimeSettings.id, "platform"),
  });
  if (!settings) {
    throw new PlatformRuntimeDeploymentError(
      "PLATFORM_RUNTIME_SETTINGS_MISSING",
      "Platform runtime settings have not been migrated.",
    );
  }
  const environments = await knowledgeDb.query.environments.findMany({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.provider, "fly"), isNull(table.archivedAt)),
    orderBy: (table, { asc }) => [asc(table.name)],
  });
  const environmentIds = environments.map((environment) => environment.id);
  const workspaces = environmentIds.length
    ? await knowledgeDb.query.environmentWorkspaces.findMany({
        where: (table, { and, inArray, isNull }) =>
          and(inArray(table.environmentId, environmentIds), isNull(table.deletedAt)),
        orderBy: (table, { asc }) => [asc(table.name)],
      })
    : [];
  const operations = environmentIds.length
    ? await knowledgeDb.query.environmentOperations.findMany({
        where: (table, { and, inArray }) =>
          and(
            inArray(table.environmentId, environmentIds),
            inArray(table.type, ["environment.gateway.update", "workspace.rebuild"]),
          ),
        orderBy: [desc(schema.environmentOperations.createdAt)],
        limit: 250,
      })
    : [];
  const latestOperation = new Map<string, (typeof operations)[number]>();
  for (const operation of operations) {
    if (typeof operation.input?.targetGeneration !== "number") continue;
    const key = operation.workspaceId ?? operation.environmentId;
    if (!latestOperation.has(key)) latestOperation.set(key, operation);
  }
  return {
    globalApplications: {
      web: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.KESTREL_GIT_SHA ?? null,
      previewEdge: process.env.KESTREL_PREVIEW_EDGE_GIT_SHA ?? null,
      turnWorker: process.env.KESTREL_TURN_WORKER_GIT_SHA ?? null,
      runpodWorker: process.env.KESTREL_RUNPOD_WORKER_GIT_SHA ?? null,
      controlWorker: process.env.KESTREL_CONTROL_WORKER_GIT_SHA ?? null,
    },
    platform: settings,
    environments: environments.map((environment) => ({
      ...environment,
      operation: latestOperation.get(environment.id) ?? null,
      workspaces: workspaces
        .filter((workspace) => workspace.environmentId === environment.id)
        .map((workspace) => ({
          ...workspace,
          operation: latestOperation.get(workspace.id) ?? null,
        })),
    })),
  };
}

export async function retryRuntimeDeploymentResource(input: {
  environmentId: string;
  workspaceId?: string | undefined;
}) {
  const settings = await requireSettings();
  const operation = await knowledgeDb.query.environmentOperations.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.environmentId, input.environmentId),
        input.workspaceId
          ? eq(table.workspaceId, input.workspaceId)
          : and(eq(table.type, "environment.gateway.update"), isNull(table.workspaceId)),
        eq(table.status, "failed"),
      ),
    orderBy: [desc(schema.environmentOperations.createdAt)],
  });
  if (!operation) {
    throw new PlatformRuntimeDeploymentError(
      "PLATFORM_RUNTIME_RESOURCE_NOT_BLOCKED",
      "The selected resource has no terminal failed operation to retry.",
    );
  }
  const targetGeneration = Number(operation.input?.targetGeneration ?? -1);
  if (targetGeneration !== settings.generation) {
    throw new PlatformRuntimeDeploymentError(
      "PLATFORM_RUNTIME_RESOURCE_SUPERSEDED",
      "The selected failure belongs to an older desired generation.",
    );
  }
  const now = new Date();
  const nextInput = { ...(operation.input ?? {}) };
  delete nextInput.safetyRollback;
  delete nextInput.rejectedImage;
  if (input.workspaceId) {
    nextInput.runtimeImage = settings.desiredRuntimeImage;
    nextInput.priorImage = settings.activeRuntimeImage;
  } else {
    nextInput.routerImage = settings.desiredRouterImage;
    nextInput.priorImage = settings.activeRouterImage;
  }
  nextInput.retryDeadline = new Date(
    now.getTime() + 60 * 60 * 1000,
  ).toISOString();
  await knowledgeDb
    .update(schema.environmentOperations)
    .set({
      status: "queued",
      stage: "platform.resource.manual_retry",
      result: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      updatedAt: now,
      input: nextInput,
    })
    .where(eq(schema.environmentOperations.id, operation.id));
  await enqueueEnvironmentOperation(operation.id, { retryTerminal: true });
  return getRuntimeDeploymentStatus();
}

export async function retryRuntimeDeploymentCanary() {
  const settings = await requireSettings();
  if (!settings.canaryEnvironmentId) {
    throw new PlatformRuntimeDeploymentError(
      "PLATFORM_RUNTIME_CANARY_MISSING",
      "No persistent canary Environment is configured.",
    );
  }
  const failed = await knowledgeDb.query.environmentOperations.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.environmentId, settings.canaryEnvironmentId!),
        eq(table.status, "failed"),
      ),
    orderBy: [desc(schema.environmentOperations.createdAt)],
    limit: 25,
  });
  const current = failed.filter(
    (operation) => operation.input?.targetGeneration === settings.generation,
  );
  if (current.length === 0) {
    throw new PlatformRuntimeDeploymentError(
      "PLATFORM_RUNTIME_RESOURCE_NOT_BLOCKED",
      "The canary has no terminal failed operation to retry.",
    );
  }
  const now = new Date();
  for (const operation of current) {
    const nextInput = { ...(operation.input ?? {}) };
    delete nextInput.safetyRollback;
    delete nextInput.rejectedImage;
    if (operation.workspaceId) {
      nextInput.runtimeImage = settings.desiredRuntimeImage;
      nextInput.priorImage = settings.activeRuntimeImage;
    } else {
      nextInput.routerImage = settings.desiredRouterImage;
      nextInput.priorImage = settings.activeRouterImage;
    }
    nextInput.retryDeadline = new Date(
      now.getTime() + 60 * 60 * 1000,
    ).toISOString();
    await knowledgeDb
      .update(schema.environmentOperations)
      .set({
        status: "queued",
        stage: "platform.resource.manual_retry",
        result: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: now,
        input: nextInput,
      })
      .where(eq(schema.environmentOperations.id, operation.id));
    await enqueueEnvironmentOperation(operation.id, { retryTerminal: true });
  }
  await knowledgeDb
    .update(schema.platformRuntimeSettings)
    .set({
      status: settings.mode === "maintenance" ? "maintenance" : "canary",
      lastFailureCode: null,
      lastFailureMessage: null,
      lastFailureAt: null,
      updatedAt: now,
    })
    .where(eq(schema.platformRuntimeSettings.id, "platform"));
  return getRuntimeDeploymentStatus();
}

export async function rollbackRuntimeDeploymentResource(input: {
  environmentId: string;
  workspaceId?: string | undefined;
}) {
  const settings = await requireSettings();
  const priorImage = input.workspaceId
    ? settings.priorRuntimeImage
    : settings.priorRouterImage;
  if (!(priorImage && settings.priorSourceRevision)) {
    throw new PlatformRuntimeDeploymentError(
      "PLATFORM_RUNTIME_ROLLBACK_UNAVAILABLE",
      "No prior verified image is available for this resource.",
    );
  }
  const now = new Date();
  const retryDeadline = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const operationId = crypto.randomUUID();
  await knowledgeDb.transaction(async (transaction) => {
    if (!input.workspaceId) {
      await transaction
        .update(schema.environments)
        .set({
          targetRouterImage: priorImage,
          targetSourceRevision: settings.priorSourceRevision,
          targetGeneration: settings.generation,
          updatedAt: now,
        })
        .where(eq(schema.environments.id, input.environmentId));
    }
    await transaction.insert(schema.environmentOperations).values({
      id: operationId,
      organizationId: sql`(select "organization_id" from "environments" where "id" = ${input.environmentId})`,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      type: input.workspaceId ? "workspace.rebuild" : "environment.gateway.update",
      status: "queued",
      stage: "platform.resource.rollback_queued",
      idempotencyKey:
        `platform-runtime:${settings.generation}:rollback:` +
        `${input.workspaceId ?? input.environmentId}:${now.getTime()}`,
      input: {
        targetGeneration: settings.generation,
        sourceRevision: settings.priorSourceRevision,
        ...(input.workspaceId ? { runtimeImage: priorImage } : { routerImage: priorImage }),
        retryDeadline,
        resourceRollback: true,
      },
      createdAt: now,
      updatedAt: now,
    });
    await transaction
      .update(schema.platformRuntimeSettings)
      .set({
        status: "degraded",
        lastFailureCode: "PLATFORM_RUNTIME_RESOURCE_ROLLBACK_REQUESTED",
        lastFailureMessage: "A resource-local rollback was requested.",
        lastFailureAt: now,
        updatedAt: now,
      })
      .where(eq(schema.platformRuntimeSettings.id, "platform"));
  });
  await enqueueEnvironmentOperation(operationId);
  return getRuntimeDeploymentStatus();
}

async function requireSettings() {
  const settings = await knowledgeDb.query.platformRuntimeSettings.findFirst({
    where: eq(schema.platformRuntimeSettings.id, "platform"),
  });
  if (!settings) {
    throw new PlatformRuntimeDeploymentError(
      "PLATFORM_RUNTIME_SETTINGS_MISSING",
      "Platform runtime settings have not been migrated.",
    );
  }
  return settings;
}

export async function getActivePlatformEnvironmentImages() {
  const settings = await knowledgeDb.query.platformRuntimeSettings.findFirst({
    where: eq(schema.platformRuntimeSettings.id, "platform"),
    columns: {
      activeRouterImage: true,
      activeRuntimeImage: true,
      activeSourceRevision: true,
    },
  });
  return settings?.activeRouterImage && settings.activeRuntimeImage
    ? {
        routerImage: settings.activeRouterImage,
        runtimeImage: settings.activeRuntimeImage,
        sourceRevision: settings.activeSourceRevision,
      }
    : null;
}
