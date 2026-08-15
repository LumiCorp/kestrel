import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { environmentLifecycleLockKey } from "./lifecycle-lock";

const PRODUCTION_CHANNEL = "production" as const;

export class EnvironmentRuntimeChannelError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_CHANNEL_SCHEMA_UNAVAILABLE"
      | "RUNTIME_CHANNEL_UNAVAILABLE"
      | "RUNTIME_VERSION_NOT_FOUND"
      | "RUNTIME_VERSION_CONFLICT"
      | "RUNTIME_VERSION_METADATA_CONFLICT"
      | "RUNTIME_CANARY_UNAVAILABLE"
      | "RUNTIME_CANARY_INCOMPLETE"
      | "RUNTIME_CANARY_MISMATCH"
      | "RUNTIME_UPDATE_CONFLICT"
      | "RUNTIME_ALREADY_CURRENT",
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentRuntimeChannelError";
  }
}

export type EnvironmentRuntimeVersion = {
  id: string;
  runtimeImage: string;
  runtimeSourceRevision: string;
  routerImage: string;
  routerSourceRevision: string;
  githubRunId: string | null;
  githubRunAttempt: number | null;
  createdAt: Date;
};

export type EnvironmentRuntimeChannel = {
  name: typeof PRODUCTION_CHANNEL;
  generation: number;
  canaryEnvironmentId: string | null;
  currentVersion: EnvironmentRuntimeVersion | null;
  previousVersion: EnvironmentRuntimeVersion | null;
  lastGithubRunId: string | null;
  lastGithubRunAttempt: number | null;
  updatedAt: Date;
  source: "runtime-channel" | "legacy-read-bridge";
};

type ChannelRow = {
  name: typeof PRODUCTION_CHANNEL;
  generation: number;
  canaryEnvironmentId: string | null;
  currentVersionId: string | null;
  currentRuntimeImage: string | null;
  currentRuntimeSourceRevision: string | null;
  currentRouterImage: string | null;
  currentRouterSourceRevision: string | null;
  currentGithubRunId: string | null;
  currentGithubRunAttempt: number | null;
  currentCreatedAt: Date | null;
  previousVersionId: string | null;
  previousRuntimeImage: string | null;
  previousRuntimeSourceRevision: string | null;
  previousRouterImage: string | null;
  previousRouterSourceRevision: string | null;
  previousGithubRunId: string | null;
  previousGithubRunAttempt: number | null;
  previousCreatedAt: Date | null;
  lastGithubRunId: string | null;
  lastGithubRunAttempt: number | null;
  updatedAt: Date;
};

export async function environmentRuntimeChannelSchemaExists() {
  const rows = await knowledgeDb.execute<{ available: boolean }>(sql`
    SELECT
      to_regclass('public.environment_runtime_versions') IS NOT NULL
      AND to_regclass('public.environment_runtime_channels') IS NOT NULL
      AS available
  `);
  return rows[0]?.available ?? false;
}

export async function getEnvironmentRuntimeChannel(): Promise<EnvironmentRuntimeChannel> {
  if (!(await environmentRuntimeChannelSchemaExists())) {
    return getLegacyRuntimeChannel();
  }
  const rows = await knowledgeDb.execute<ChannelRow>(sql`
    SELECT
      channel."name",
      channel."generation",
      channel."canary_environment_id" AS "canaryEnvironmentId",
      current_version."id" AS "currentVersionId",
      current_version."workspace_runtime_image" AS "currentRuntimeImage",
      current_version."workspace_runtime_source_revision" AS "currentRuntimeSourceRevision",
      current_version."environment_router_image" AS "currentRouterImage",
      current_version."environment_router_source_revision" AS "currentRouterSourceRevision",
      current_version."github_run_id" AS "currentGithubRunId",
      current_version."github_run_attempt" AS "currentGithubRunAttempt",
      current_version."created_at" AS "currentCreatedAt",
      previous_version."id" AS "previousVersionId",
      previous_version."workspace_runtime_image" AS "previousRuntimeImage",
      previous_version."workspace_runtime_source_revision" AS "previousRuntimeSourceRevision",
      previous_version."environment_router_image" AS "previousRouterImage",
      previous_version."environment_router_source_revision" AS "previousRouterSourceRevision",
      previous_version."github_run_id" AS "previousGithubRunId",
      previous_version."github_run_attempt" AS "previousGithubRunAttempt",
      previous_version."created_at" AS "previousCreatedAt",
      channel."last_github_run_id" AS "lastGithubRunId",
      channel."last_github_run_attempt" AS "lastGithubRunAttempt",
      channel."updated_at" AS "updatedAt"
    FROM "environment_runtime_channels" channel
    LEFT JOIN "environment_runtime_versions" current_version
      ON current_version."id" = channel."current_version_id"
    LEFT JOIN "environment_runtime_versions" previous_version
      ON previous_version."id" = channel."previous_version_id"
    WHERE channel."name" = ${PRODUCTION_CHANNEL}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_CHANNEL_UNAVAILABLE",
      "The production Environment Runtime Channel is unavailable.",
    );
  }
  return {
    name: PRODUCTION_CHANNEL,
    generation: row.generation,
    canaryEnvironmentId: row.canaryEnvironmentId,
    currentVersion: mapVersion(row, "current"),
    previousVersion: mapVersion(row, "previous"),
    lastGithubRunId: row.lastGithubRunId,
    lastGithubRunAttempt: row.lastGithubRunAttempt,
    updatedAt: row.updatedAt,
    source: "runtime-channel",
  };
}

export async function getCurrentEnvironmentRuntime() {
  return (await getEnvironmentRuntimeChannel()).currentVersion;
}

export async function requireCurrentEnvironmentRuntime() {
  const current = await getCurrentEnvironmentRuntime();
  if (!current) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_CHANNEL_UNAVAILABLE",
      "Hosted provisioning requires a current Environment Runtime Version.",
    );
  }
  return current;
}

export async function getEnvironmentRuntimeVersion(versionId: string) {
  await requireRuntimeChannelSchema();
  return knowledgeDb.query.environmentRuntimeVersions.findFirst({
    where: eq(schema.environmentRuntimeVersions.id, versionId),
  });
}

export async function listEnvironmentRuntimeCanaries() {
  await requireRuntimeChannelSchema();
  return knowledgeDb
    .select({
      id: schema.environments.id,
      name: schema.environments.name,
      organizationName: schema.organizations.name,
      status: schema.environments.status,
    })
    .from(schema.environments)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.environments.organizationId),
    )
    .where(
      and(
        eq(schema.environments.provider, "fly"),
        isNull(schema.environments.archivedAt),
        inArray(schema.environments.status, ["ready", "degraded"]),
      ),
    )
    .orderBy(asc(schema.organizations.name), asc(schema.environments.name));
}

export async function setEnvironmentRuntimeCanary(environmentId: string) {
  await requireRuntimeChannelSchema();
  return knowledgeDb.transaction(async (transaction) => {
    const environment = await transaction.query.environments.findFirst({
      where: and(
        eq(schema.environments.id, environmentId),
        eq(schema.environments.provider, "fly"),
        isNull(schema.environments.archivedAt),
        inArray(schema.environments.status, ["ready", "degraded"]),
      ),
      columns: { id: true },
    });
    if (!environment) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_CANARY_UNAVAILABLE",
        "The canary must be an active Fly Environment.",
      );
    }
    const [updated] = await transaction
      .update(schema.environmentRuntimeChannels)
      .set({ canaryEnvironmentId: environmentId, updatedAt: new Date() })
      .where(eq(schema.environmentRuntimeChannels.name, PRODUCTION_CHANNEL))
      .returning();
    if (!updated) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_CHANNEL_UNAVAILABLE",
        "The production Environment Runtime Channel is unavailable.",
      );
    }
    return updated;
  });
}

export async function registerEnvironmentRuntimeVersion(input: {
  runtimeImage: string;
  runtimeSourceRevision: string;
  routerImage: string;
  routerSourceRevision: string;
  githubRunId: string;
  githubRunAttempt: number;
}) {
  await requireRuntimeChannelSchema();
  const [created] = await knowledgeDb
    .insert(schema.environmentRuntimeVersions)
    .values({
      id: crypto.randomUUID(),
      workspaceRuntimeImage: input.runtimeImage,
      workspaceRuntimeSourceRevision: input.runtimeSourceRevision,
      environmentRouterImage: input.routerImage,
      environmentRouterSourceRevision: input.routerSourceRevision,
      githubRunId: input.githubRunId,
      githubRunAttempt: input.githubRunAttempt,
    })
    .onConflictDoNothing({
      target: [
        schema.environmentRuntimeVersions.workspaceRuntimeImage,
        schema.environmentRuntimeVersions.environmentRouterImage,
      ],
    })
    .returning();
  const version =
    created ??
    (await knowledgeDb.query.environmentRuntimeVersions.findFirst({
      where: and(
        eq(
          schema.environmentRuntimeVersions.workspaceRuntimeImage,
          input.runtimeImage,
        ),
        eq(
          schema.environmentRuntimeVersions.environmentRouterImage,
          input.routerImage,
        ),
      ),
    }));
  if (!version) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_VERSION_NOT_FOUND",
      "Environment Runtime Version registration did not produce a version.",
    );
  }
  if (
    version.workspaceRuntimeSourceRevision !== input.runtimeSourceRevision ||
    version.environmentRouterSourceRevision !== input.routerSourceRevision
  ) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_VERSION_METADATA_CONFLICT",
      "The immutable digest pair is already registered with different source metadata.",
    );
  }
  const channel = await getEnvironmentRuntimeChannel();
  return { version: mapSchemaVersion(version), generation: channel.generation };
}

export async function requestEnvironmentRuntimeUpdate(input: {
  organizationId: string;
  environmentId: string;
  runtimeVersionId: string;
  actorUserId: string | null;
}) {
  await requireRuntimeChannelSchema();
  const version = await getEnvironmentRuntimeVersion(input.runtimeVersionId);
  if (!version) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_VERSION_NOT_FOUND",
      "The requested Environment Runtime Version does not exist.",
    );
  }
  const environment = await knowledgeDb.query.environments.findFirst({
    where: and(
      eq(schema.environments.id, input.environmentId),
      eq(schema.environments.organizationId, input.organizationId),
    ),
  });
  if (!environment || environment.provider !== "fly") {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_VERSION_NOT_FOUND",
      "The requested Fly Environment does not exist.",
    );
  }
  if (
    environment.runtimeImage === version.workspaceRuntimeImage &&
    environment.routerImage === version.environmentRouterImage
  ) {
    const existing = await knowledgeDb.query.environmentOperations.findFirst({
      where: and(
        eq(schema.environmentOperations.organizationId, input.organizationId),
        eq(schema.environmentOperations.environmentId, input.environmentId),
        eq(schema.environmentOperations.type, "environment.update"),
        sql`${schema.environmentOperations.input}->>'runtimeVersionId' = ${version.id}`,
      ),
      orderBy: desc(schema.environmentOperations.createdAt),
    });
    if (existing?.status === "completed") {
      return { environment, operation: existing, version: mapSchemaVersion(version) };
    }
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_ALREADY_CURRENT",
      "The Environment already uses the requested runtime version.",
    );
  }
  const now = new Date();
  const idempotencyKey = environmentRuntimeUpdateIdempotencyKey({
    environmentId: input.environmentId,
    runtimeVersionId: version.id,
    sourceRuntimeImage: environment.runtimeImage,
    sourceRouterImage: environment.routerImage,
  });
  const operation = await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`,
    );
    const existing = await transaction.query.environmentOperations.findFirst({
      where: and(
        eq(schema.environmentOperations.organizationId, input.organizationId),
        eq(schema.environmentOperations.idempotencyKey, idempotencyKey),
      ),
    });
    if (existing) {
      if (existing.status === "failed" || existing.status === "cancelled") {
        const [requeued] = await transaction
          .update(schema.environmentOperations)
          .set({
            status: "queued",
            stage: "requested",
            result: null,
            errorCode: null,
            errorMessage: null,
            startedAt: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(schema.environmentOperations.id, existing.id))
          .returning();
        if (!requeued) throw new Error("Environment update retry was not queued.");
        return requeued;
      }
      return existing;
    }
    const conflict = await transaction.query.environmentOperations.findFirst({
      where: and(
        eq(schema.environmentOperations.environmentId, input.environmentId),
        inArray(schema.environmentOperations.status, ["queued", "running"]),
      ),
    });
    if (conflict) {
      if (conflict.input?.runtimeVersionId === version.id) return conflict;
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_UPDATE_CONFLICT",
        "The Environment already has an active lifecycle operation.",
      );
    }
    const [created] = await transaction
      .insert(schema.environmentOperations)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        requestedByUserId: input.actorUserId,
        type: "environment.update",
        status: "queued",
        stage: "requested",
        idempotencyKey,
        input: {
          runtimeVersionId: version.id,
          runtimeImage: version.workspaceRuntimeImage,
          routerImage: version.environmentRouterImage,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("Environment update was not created.");
    return created;
  });
  return { environment, operation, version: mapSchemaVersion(version) };
}

export async function requestEnvironmentRuntimeCanary(input: {
  runtimeVersionId: string;
}) {
  const channel = await getEnvironmentRuntimeChannel();
  if (channel.source !== "runtime-channel" || !channel.canaryEnvironmentId) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_CANARY_UNAVAILABLE",
      "The production Runtime Channel has no canary Environment.",
    );
  }
  const environment = await knowledgeDb.query.environments.findFirst({
    where: eq(schema.environments.id, channel.canaryEnvironmentId),
    columns: { organizationId: true },
  });
  if (!environment) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_CANARY_UNAVAILABLE",
      "The configured canary Environment does not exist.",
    );
  }
  return requestEnvironmentRuntimeUpdate({
    organizationId: environment.organizationId,
    environmentId: channel.canaryEnvironmentId,
    runtimeVersionId: input.runtimeVersionId,
    actorUserId: null,
  });
}

export async function getEnvironmentRuntimeCanary(versionId: string) {
  const channel = await getEnvironmentRuntimeChannel();
  if (channel.source !== "runtime-channel" || !channel.canaryEnvironmentId) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_CANARY_UNAVAILABLE",
      "The production Runtime Channel has no canary Environment.",
    );
  }
  return knowledgeDb.query.environmentOperations.findFirst({
    where: and(
      eq(schema.environmentOperations.environmentId, channel.canaryEnvironmentId),
      eq(schema.environmentOperations.type, "environment.update"),
      sql`${schema.environmentOperations.input}->>'runtimeVersionId' = ${versionId}`,
    ),
    orderBy: desc(schema.environmentOperations.createdAt),
  });
}

export async function promoteEnvironmentRuntimeVersion(input: {
  runtimeVersionId: string;
  expectedCurrentVersionId: string | null;
  expectedGeneration: number;
  canaryOperationId: string;
  githubRunId: string;
  githubRunAttempt: number;
}) {
  await requireRuntimeChannelSchema();
  return knowledgeDb.transaction(async (transaction) => {
    const channelRows = await transaction.execute<{
      currentVersionId: string | null;
      generation: number;
      canaryEnvironmentId: string | null;
    }>(sql`
      SELECT
        "current_version_id" AS "currentVersionId",
        "generation",
        "canary_environment_id" AS "canaryEnvironmentId"
      FROM "environment_runtime_channels"
      WHERE "name" = ${PRODUCTION_CHANNEL}
      FOR UPDATE
    `);
    const channel = channelRows[0];
    if (!channel) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_CHANNEL_UNAVAILABLE",
        "The production Environment Runtime Channel is unavailable.",
      );
    }
    if (channel.currentVersionId === input.runtimeVersionId) {
      return { versionId: input.runtimeVersionId, generation: channel.generation };
    }
    if (
      channel.currentVersionId !== input.expectedCurrentVersionId ||
      channel.generation !== input.expectedGeneration
    ) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_VERSION_CONFLICT",
        "The production Runtime Channel changed; rebuild the pair from the current version.",
      );
    }
    if (!channel.canaryEnvironmentId) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_CANARY_UNAVAILABLE",
        "The production Runtime Channel has no canary Environment.",
      );
    }
    const version = await transaction.query.environmentRuntimeVersions.findFirst({
      where: eq(schema.environmentRuntimeVersions.id, input.runtimeVersionId),
    });
    if (!version) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_VERSION_NOT_FOUND",
        "The proposed Environment Runtime Version does not exist.",
      );
    }
    const operation = await transaction.query.environmentOperations.findFirst({
      where: and(
        eq(schema.environmentOperations.id, input.canaryOperationId),
        eq(schema.environmentOperations.environmentId, channel.canaryEnvironmentId),
        eq(schema.environmentOperations.type, "environment.update"),
      ),
    });
    if (
      !operation ||
      operation.status !== "completed" ||
      operation.stage !== "environment.update.ready" ||
      operation.input?.runtimeVersionId !== input.runtimeVersionId
    ) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_CANARY_INCOMPLETE",
        "The proposed version has not completed its bound canary operation.",
      );
    }
    const canary = await transaction.query.environments.findFirst({
      where: eq(schema.environments.id, channel.canaryEnvironmentId),
      columns: { runtimeImage: true, routerImage: true },
    });
    if (
      canary?.runtimeImage !== version.workspaceRuntimeImage ||
      canary.routerImage !== version.environmentRouterImage
    ) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_CANARY_MISMATCH",
        "The canary Environment does not store the proposed immutable image pair.",
      );
    }
    await transaction
      .update(schema.environmentRuntimeChannels)
      .set({
        previousVersionId: channel.currentVersionId,
        currentVersionId: version.id,
        generation: channel.generation + 1,
        lastGithubRunId: input.githubRunId,
        lastGithubRunAttempt: input.githubRunAttempt,
        updatedAt: new Date(),
      })
      .where(eq(schema.environmentRuntimeChannels.name, PRODUCTION_CHANNEL));
    return { versionId: version.id, generation: channel.generation + 1 };
  });
}

async function requireRuntimeChannelSchema() {
  if (!(await environmentRuntimeChannelSchemaExists())) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_CHANNEL_SCHEMA_UNAVAILABLE",
      "Migration 0072 must be applied before mutating Environment Runtime state.",
    );
  }
}

function environmentRuntimeUpdateIdempotencyKey(input: {
  environmentId: string;
  runtimeVersionId: string;
  sourceRuntimeImage: string | null;
  sourceRouterImage: string | null;
}) {
  const sourceFingerprint = createHash("sha256")
    .update(
      JSON.stringify([input.sourceRuntimeImage, input.sourceRouterImage]),
    )
    .digest("hex");
  return [
    "environment.update",
    input.environmentId,
    input.runtimeVersionId,
    sourceFingerprint,
  ].join(":");
}

async function getLegacyRuntimeChannel(): Promise<EnvironmentRuntimeChannel> {
  const settings = await knowledgeDb.query.flyImageReleaseSettings.findFirst({
    where: eq(schema.flyImageReleaseSettings.id, "platform"),
    columns: { stableReleaseId: true, canaryEnvironmentId: true, updatedAt: true },
  });
  if (!settings?.stableReleaseId) {
    return {
      name: PRODUCTION_CHANNEL,
      generation: 0,
      canaryEnvironmentId: settings?.canaryEnvironmentId ?? null,
      currentVersion: null,
      previousVersion: null,
      lastGithubRunId: null,
      lastGithubRunAttempt: null,
      updatedAt: settings?.updatedAt ?? new Date(0),
      source: "legacy-read-bridge",
    };
  }
  const components = await knowledgeDb.query.flyImageReleaseComponents.findMany({
    where: and(
      eq(schema.flyImageReleaseComponents.releaseId, settings.stableReleaseId),
      inArray(schema.flyImageReleaseComponents.role, [
        "workspace-runtime",
        "environment-router",
      ]),
    ),
  });
  const runtime = components.find((component) => component.role === "workspace-runtime");
  const router = components.find((component) => component.role === "environment-router");
  const complete = runtime && router;
  return {
    name: PRODUCTION_CHANNEL,
    generation: complete ? 1 : 0,
    canaryEnvironmentId: settings.canaryEnvironmentId,
    currentVersion: complete
      ? {
          id: `legacy-${settings.stableReleaseId}`,
          runtimeImage: runtime.image,
          runtimeSourceRevision: runtime.sourceRevision,
          routerImage: router.image,
          routerSourceRevision: router.sourceRevision,
          githubRunId: null,
          githubRunAttempt: null,
          createdAt: runtime.createdAt,
        }
      : null,
    previousVersion: null,
    lastGithubRunId: null,
    lastGithubRunAttempt: null,
    updatedAt: settings.updatedAt,
    source: "legacy-read-bridge",
  };
}

function mapSchemaVersion(
  version: typeof schema.environmentRuntimeVersions.$inferSelect,
): EnvironmentRuntimeVersion {
  return {
    id: version.id,
    runtimeImage: version.workspaceRuntimeImage,
    runtimeSourceRevision: version.workspaceRuntimeSourceRevision,
    routerImage: version.environmentRouterImage,
    routerSourceRevision: version.environmentRouterSourceRevision,
    githubRunId: version.githubRunId,
    githubRunAttempt: version.githubRunAttempt,
    createdAt: version.createdAt,
  };
}

function mapVersion(row: ChannelRow, prefix: "current" | "previous") {
  const id = prefix === "current" ? row.currentVersionId : row.previousVersionId;
  if (!id) return null;
  const runtimeImage =
    prefix === "current" ? row.currentRuntimeImage : row.previousRuntimeImage;
  const runtimeSourceRevision =
    prefix === "current"
      ? row.currentRuntimeSourceRevision
      : row.previousRuntimeSourceRevision;
  const routerImage =
    prefix === "current" ? row.currentRouterImage : row.previousRouterImage;
  const routerSourceRevision =
    prefix === "current"
      ? row.currentRouterSourceRevision
      : row.previousRouterSourceRevision;
  const createdAt =
    prefix === "current" ? row.currentCreatedAt : row.previousCreatedAt;
  if (!(runtimeImage && runtimeSourceRevision && routerImage && routerSourceRevision && createdAt)) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_CHANNEL_UNAVAILABLE",
      `The ${prefix} Environment Runtime Version is incomplete.`,
    );
  }
  return {
    id,
    runtimeImage,
    runtimeSourceRevision,
    routerImage,
    routerSourceRevision,
    githubRunId:
      prefix === "current" ? row.currentGithubRunId : row.previousGithubRunId,
    githubRunAttempt:
      prefix === "current"
        ? row.currentGithubRunAttempt
        : row.previousGithubRunAttempt,
    createdAt,
  };
}
