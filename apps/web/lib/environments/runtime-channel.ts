import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
      | "RUNTIME_CANARY_UNAVAILABLE"
      | "RUNTIME_CANARY_INCOMPLETE"
      | "RUNTIME_CANARY_MISMATCH"
      | "RUNTIME_UPDATE_CONFLICT"
      | "RUNTIME_ALREADY_CURRENT"
      | "RUNTIME_ROLLBACK_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentRuntimeChannelError";
  }
}

export type EnvironmentRuntimeVersion = {
  id: string;
  runtimeImage: string;
  routerImage: string;
  createdAt: Date;
};

export type EnvironmentRuntimeChannel = {
  name: typeof PRODUCTION_CHANNEL;
  generation: number;
  canaryEnvironmentId: string | null;
  currentVersion: EnvironmentRuntimeVersion | null;
  previousVersion: EnvironmentRuntimeVersion | null;
  updatedAt: Date;
};

type ChannelRow = {
  name: typeof PRODUCTION_CHANNEL;
  generation: number;
  canaryEnvironmentId: string | null;
  currentVersionId: string | null;
  currentRuntimeImage: string | null;
  currentRouterImage: string | null;
  currentCreatedAt: Date | string | null;
  previousVersionId: string | null;
  previousRuntimeImage: string | null;
  previousRouterImage: string | null;
  previousCreatedAt: Date | string | null;
  updatedAt: Date | string;
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
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_CHANNEL_SCHEMA_UNAVAILABLE",
      "Migration 0072 must be applied before reading Environment Runtime state.",
    );
  }
  const rows = await knowledgeDb.execute<ChannelRow>(sql`
    SELECT
      channel."name",
      channel."generation",
      channel."canary_environment_id" AS "canaryEnvironmentId",
      current_version."id" AS "currentVersionId",
      current_version."workspace_runtime_image" AS "currentRuntimeImage",
      current_version."environment_router_image" AS "currentRouterImage",
      current_version."created_at" AS "currentCreatedAt",
      previous_version."id" AS "previousVersionId",
      previous_version."workspace_runtime_image" AS "previousRuntimeImage",
      previous_version."environment_router_image" AS "previousRouterImage",
      previous_version."created_at" AS "previousCreatedAt",
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
    updatedAt: runtimeDate(row.updatedAt),
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

export async function registerEnvironmentRuntimeVersion(input: {
  runtimeImage: string;
  routerImage: string;
}) {
  await requireRuntimeChannelSchema();
  const [created] = await knowledgeDb
    .insert(schema.environmentRuntimeVersions)
    .values({
      id: crypto.randomUUID(),
      workspaceRuntimeImage: input.runtimeImage,
      environmentRouterImage: input.routerImage,
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
  const channel = await getEnvironmentRuntimeChannel();
  return { version: mapSchemaVersion(version), generation: channel.generation };
}

export async function activateEnvironmentRuntimeVersion(input: {
  runtimeVersionId: string;
  canaryOperationId: string;
}) {
  await requireRuntimeChannelSchema();
  return knowledgeDb.transaction(async (transaction) => {
    const channelRows = await transaction.execute<{
      currentVersionId: string | null;
      generation: number;
    }>(sql`
      SELECT
        "current_version_id" AS "currentVersionId",
        "generation"
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
    const version =
      await transaction.query.environmentRuntimeVersions.findFirst({
        where: eq(
          schema.environmentRuntimeVersions.id,
          input.runtimeVersionId,
        ),
      });
    if (!version) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_VERSION_NOT_FOUND",
        "The requested Environment Runtime Version does not exist.",
      );
    }
    const operation = await transaction.query.environmentOperations.findFirst({
      where: and(
        eq(schema.environmentOperations.id, input.canaryOperationId),
        eq(schema.environmentOperations.type, "environment.update"),
      ),
    });
    if (
      !operation ||
      operation.status !== "completed" ||
      operation.stage !== "environment.update.ready" ||
      operation.input?.runtimeVersionId !== version.id
    ) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_CANARY_INCOMPLETE",
        "The exact canary operation did not complete this runtime version.",
      );
    }
    const environment = await transaction.query.environments.findFirst({
      where: and(
        eq(schema.environments.id, operation.environmentId),
        eq(schema.environments.provider, "fly"),
      ),
      columns: { runtimeImage: true, routerImage: true },
    });
    if (
      environment?.runtimeImage !== version.workspaceRuntimeImage ||
      environment.routerImage !== version.environmentRouterImage
    ) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_CANARY_MISMATCH",
        "The canary Environment does not run the exact runtime pair.",
      );
    }
    if (channel.currentVersionId === version.id) {
      return {
        versionId: version.id,
        generation: channel.generation,
        canaryEnvironmentId: operation.environmentId,
        alreadyCurrent: true,
      };
    }
    const [updated] = await transaction
      .update(schema.environmentRuntimeChannels)
      .set({
        currentVersionId: version.id,
        previousVersionId: channel.currentVersionId,
        generation: channel.generation + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.environmentRuntimeChannels.name, PRODUCTION_CHANNEL))
      .returning({ generation: schema.environmentRuntimeChannels.generation });
    if (!updated) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_CHANNEL_UNAVAILABLE",
        "The production Environment Runtime Channel was not activated.",
      );
    }
    return {
      versionId: version.id,
      generation: updated.generation,
      canaryEnvironmentId: operation.environmentId,
      alreadyCurrent: false,
    };
  });
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
    if (
      existing?.status === "completed" &&
      existing.stage === "environment.update.ready"
    ) {
      return {
        environment,
        operation: existing,
        version: mapSchemaVersion(version),
      };
    }
    if (
      !(
        existing &&
        (existing.status === "failed" ||
          existing.status === "cancelled" ||
          (existing.status === "completed" &&
            existing.stage === "environment.update.recovery_required"))
      )
    ) {
      throw new EnvironmentRuntimeChannelError(
        "RUNTIME_ALREADY_CURRENT",
        "The Environment already uses the requested runtime version.",
      );
    }
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
      if (
        existing.status === "failed" ||
        existing.status === "cancelled" ||
        (existing.status === "completed" &&
          existing.stage === "environment.update.recovery_required")
      ) {
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
        if (!requeued)
          throw new Error("Environment update retry was not queued.");
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
  return [
    "environment.update",
    input.environmentId,
    input.runtimeVersionId,
    input.sourceRuntimeImage ?? "none",
    input.sourceRouterImage ?? "none",
  ].join(":");
}

function mapSchemaVersion(
  version: typeof schema.environmentRuntimeVersions.$inferSelect,
): EnvironmentRuntimeVersion {
  return {
    id: version.id,
    runtimeImage: version.workspaceRuntimeImage,
    routerImage: version.environmentRouterImage,
    createdAt: runtimeDate(version.createdAt),
  };
}

function runtimeDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function mapVersion(
  row: ChannelRow,
  prefix: "current" | "previous",
) {
  const versions = {
    current: {
      id: row.currentVersionId,
      runtimeImage: row.currentRuntimeImage,
      routerImage: row.currentRouterImage,
      createdAt: row.currentCreatedAt,
    },
    previous: {
      id: row.previousVersionId,
      runtimeImage: row.previousRuntimeImage,
      routerImage: row.previousRouterImage,
      createdAt: row.previousCreatedAt,
    },
  };
  const version = versions[prefix];
  if (!version.id) return null;
  if (
    !(
      version.runtimeImage && version.routerImage && version.createdAt
    )
  ) {
    throw new EnvironmentRuntimeChannelError(
      "RUNTIME_CHANNEL_UNAVAILABLE",
      `The ${prefix} Environment Runtime Version is incomplete.`,
    );
  }
  return {
    id: version.id,
    runtimeImage: version.runtimeImage,
    routerImage: version.routerImage,
    createdAt: runtimeDate(version.createdAt),
  };
}
