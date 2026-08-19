import "server-only";

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  environmentProviderConnectionConfigurationSchema,
  environmentProviderPlacementPersistenceSchema,
  environmentProviderQualificationEvidenceSchema,
  environmentProviderResourceMetadataV1Schema,
  environmentProviderResourceWriteSchema,
  parseEnvironmentProviderConnectionConfiguration,
  parseEnvironmentProviderQualificationEvidence,
  parseEnvironmentProviderResourceMetadata,
  type EnvironmentProviderResourceWrite,
} from "./provider-persistence-contracts";
import type {
  EnvironmentProviderKind,
  EnvironmentResourceRole,
} from "./providers/contracts-v2";

type EnvironmentTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

export class EnvironmentProviderPersistenceError extends Error {
  constructor(
    readonly code:
      | "PROVIDER_CONNECTION_NOT_FOUND"
      | "PROVIDER_CONNECTION_MISMATCH"
      | "PROVIDER_CONNECTION_REVOKED"
      | "PROVIDER_RESOURCE_CONFLICT"
      | "PROVIDER_PERSISTENCE_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentProviderPersistenceError";
  }
}

export const flyEnvironmentProviderConnectionId = (organizationId: string) =>
  `organization-fly:${organizationId}`;

function parseConnectionRow(
  row: typeof schema.environmentProviderConnections.$inferSelect,
) {
  try {
    const configuration = parseEnvironmentProviderConnectionConfiguration(
      row.configuration,
    );
    const qualificationEvidence =
      parseEnvironmentProviderQualificationEvidence(row.qualificationEvidence);
    if (
      (row.provider === "fly" &&
        configuration.contract !== "fly-connection-configuration-v1") ||
      (row.provider === "kubernetes" &&
        !configuration.contract.startsWith("kubernetes-"))
    ) {
      throw new Error("provider/configuration contract mismatch");
    }
    return { ...row, configuration, qualificationEvidence };
  } catch (error) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_PERSISTENCE_CORRUPT",
      `Provider connection ${row.id} contains invalid versioned data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseResourceRow(
  row: typeof schema.environmentProviderResources.$inferSelect,
) {
  try {
    return {
      ...row,
      providerMetadata: parseEnvironmentProviderResourceMetadata(
        row.providerMetadata,
      ),
    };
  } catch (error) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_PERSISTENCE_CORRUPT",
      `Provider resource ${row.id} contains invalid versioned metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function getEnvironmentProviderConnection(input: {
  organizationId: string;
  connectionId: string;
}) {
  const row = await knowledgeDb.query.environmentProviderConnections.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.connectionId),
        eq(table.organizationId, input.organizationId),
      ),
  });
  return row ? parseConnectionRow(row) : null;
}

export async function listEnvironmentProviderConnections(input: {
  organizationId: string;
  provider?: EnvironmentProviderKind | undefined;
  includeRevoked?: boolean | undefined;
}) {
  const rows = await knowledgeDb.query.environmentProviderConnections.findMany({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.organizationId, input.organizationId),
        input.provider ? eq(table.provider, input.provider) : undefined,
        input.includeRevoked ? undefined : isNull(table.revokedAt),
      ),
    orderBy: (table, { asc, desc }) => [
      desc(table.isDefault),
      asc(table.displayName),
      asc(table.id),
    ],
  });
  return rows.map(parseConnectionRow);
}

export async function createEnvironmentProviderConnection(input: {
  organizationId: string;
  provider: EnvironmentProviderKind;
  displayName: string;
  configuration: unknown;
  qualificationEvidence?: unknown;
  isDefault?: boolean | undefined;
  configuredByUserId?: string | null | undefined;
}) {
  const configuration = environmentProviderConnectionConfigurationSchema.parse(
    input.configuration,
  );
  if (
    (input.provider === "fly" &&
      configuration.contract !== "fly-connection-configuration-v1") ||
    (input.provider === "kubernetes" &&
      !configuration.contract.startsWith("kubernetes-"))
  ) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_CONNECTION_MISMATCH",
      "Provider connection configuration does not match its provider.",
    );
  }
  const evidence = environmentProviderQualificationEvidenceSchema.parse(
    input.qualificationEvidence ?? [],
  );
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`environment-provider-default:${input.organizationId}:${input.provider}`}, 0))`,
    );
    const existingDefault =
      await transaction.query.environmentProviderConnections.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.provider, input.provider),
            eq(table.isDefault, true),
            isNull(table.revokedAt),
          ),
        columns: { id: true },
      });
    const isDefault = input.isDefault ?? !existingDefault;
    if (isDefault && existingDefault) {
      await transaction
        .update(schema.environmentProviderConnections)
        .set({ isDefault: false, updatedAt: now })
        .where(eq(schema.environmentProviderConnections.id, existingDefault.id));
    }
    const [created] = await transaction
      .insert(schema.environmentProviderConnections)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        provider: input.provider,
        displayName: input.displayName.trim(),
        isDefault,
        status: input.provider === "kubernetes" ? "pending" : "degraded",
        supportStatus: "unverified",
        configuration,
        qualificationEvidence: evidence,
        configuredByUserId: input.configuredByUserId ?? null,
        configuredAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("Provider connection creation failed.");
    return parseConnectionRow(created);
  });
}

export async function resolveEnvironmentProviderConnection(input: {
  organizationId: string;
  environmentId: string;
}) {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.environmentId),
        eq(table.organizationId, input.organizationId),
      ),
    columns: {
      id: true,
      organizationId: true,
      provider: true,
      providerConnectionId: true,
      providerPlacement: true,
      workspaceLimit: true,
      runtimeTemplate: true,
    },
  });
  if (!environment) return null;
  if (environment.provider === "desktop") {
    if (environment.providerConnectionId !== null) {
      throw new EnvironmentProviderPersistenceError(
        "PROVIDER_CONNECTION_MISMATCH",
        "Desktop Environments cannot have a hosted provider connection.",
      );
    }
    return { environment, connection: null, placement: null };
  }
  if (!environment.providerConnectionId) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_CONNECTION_NOT_FOUND",
      `Hosted Environment ${environment.id} has no provider connection.`,
    );
  }
  const connection = await getEnvironmentProviderConnection({
    organizationId: input.organizationId,
    connectionId: environment.providerConnectionId,
  });
  if (!connection || connection.provider !== environment.provider) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_CONNECTION_MISMATCH",
      `Environment ${environment.id} is bound to a mismatched provider connection.`,
    );
  }
  if (connection.revokedAt || connection.status === "revoked") {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_CONNECTION_REVOKED",
      `Environment ${environment.id} is bound to a revoked provider connection.`,
    );
  }
  const placement = environment.providerPlacement
    ? environmentProviderPlacementPersistenceSchema.parse(
        environment.providerPlacement,
      )
    : null;
  if (
    placement &&
    placement.connectionId !== environment.providerConnectionId
  ) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_PERSISTENCE_CORRUPT",
      `Environment ${environment.id} placement references another connection.`,
    );
  }
  return { environment, connection, placement };
}

async function assertResourceOwnership(
  transaction: EnvironmentTransaction,
  input: ReturnType<typeof environmentProviderResourceWriteSchema.parse>,
) {
  const connection =
    await transaction.query.environmentProviderConnections.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.providerConnectionId),
          eq(table.organizationId, input.organizationId),
          eq(table.provider, input.provider),
          isNull(table.revokedAt),
        ),
      columns: { id: true },
    });
  const environment = await transaction.query.environments.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.environmentId),
        eq(table.organizationId, input.organizationId),
        eq(table.provider, input.provider),
        eq(table.providerConnectionId, input.providerConnectionId),
      ),
    columns: { id: true },
  });
  const workspace = input.workspaceId
    ? await transaction.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, input.workspaceId!),
            eq(table.organizationId, input.organizationId),
            eq(table.environmentId, input.environmentId),
          ),
        columns: { id: true },
      })
    : null;
  if (!(connection && environment && (!input.workspaceId || workspace))) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_CONNECTION_MISMATCH",
      "Provider resource ownership does not match its organization, Environment, workspace, and connection.",
    );
  }
}

export async function upsertEnvironmentProviderResource(
  input: EnvironmentProviderResourceWrite,
) {
  const parsed = environmentProviderResourceWriteSchema.parse(input);
  return knowledgeDb.transaction((transaction) =>
    upsertEnvironmentProviderResourceInTransaction(transaction, parsed),
  );
}

export async function upsertEnvironmentProviderResourceInTransaction(
  transaction: EnvironmentTransaction,
  input: EnvironmentProviderResourceWrite,
) {
  const parsed = environmentProviderResourceWriteSchema.parse(input);
  await assertResourceOwnership(transaction, parsed);
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`environment-provider-resource:${parsed.environmentId}:${parsed.workspaceId ?? "environment"}:${parsed.resourceRole}:${parsed.replacementId ?? "primary"}`}, 0))`,
  );
  const existing =
    parsed.resourceRole === "snapshot"
      ? await transaction.query.environmentProviderResources.findFirst({
          where: (table, { and, eq, isNull }) =>
            and(
              eq(table.providerConnectionId, parsed.providerConnectionId),
              eq(table.resourceRole, "snapshot"),
              eq(table.externalId, parsed.externalId),
              isNull(table.deletedAt),
            ),
        })
      : await transaction.query.environmentProviderResources.findFirst({
          where: (table, { and, eq, isNull }) =>
            and(
              eq(table.environmentId, parsed.environmentId),
              parsed.workspaceId
                ? eq(table.workspaceId, parsed.workspaceId)
                : isNull(table.workspaceId),
              eq(table.resourceRole, parsed.resourceRole),
              parsed.replacementId
                ? eq(table.replacementId, parsed.replacementId)
                : isNull(table.replacementId),
              isNull(table.deletedAt),
            ),
        });
  const externalConflict =
    await transaction.query.environmentProviderResources.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.providerConnectionId, parsed.providerConnectionId),
          eq(table.environmentId, parsed.environmentId),
          eq(table.resourceRole, parsed.resourceRole),
          eq(table.externalId, parsed.externalId),
          isNull(table.deletedAt),
        ),
      columns: { id: true },
    });
  if (
    existing &&
    (existing.organizationId !== parsed.organizationId ||
      existing.environmentId !== parsed.environmentId ||
      existing.workspaceId !== parsed.workspaceId ||
      existing.provider !== parsed.provider)
  ) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_RESOURCE_CONFLICT",
      `Provider resource ${parsed.resourceRole}/${parsed.externalId} cannot change logical ownership.`,
    );
  }
  if (externalConflict && externalConflict.id !== existing?.id) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_RESOURCE_CONFLICT",
      `Provider resource ${parsed.resourceRole}/${parsed.externalId} is already bound.`,
    );
  }
  const now = new Date();
  const values = {
    organizationId: parsed.organizationId,
    environmentId: parsed.environmentId,
    workspaceId: parsed.workspaceId,
    replacementId: parsed.replacementId,
    providerConnectionId: parsed.providerConnectionId,
    provider: parsed.provider,
    resourceRole: parsed.resourceRole,
    externalId: parsed.externalId,
    providerUid: parsed.providerUid,
    desiredRevision: parsed.desiredRevision,
    observedGeneration: parsed.observedGeneration,
    state: parsed.state,
    providerMetadata: parsed.providerMetadata,
    deletedAt: null,
    updatedAt: now,
  };
  const [row] = existing
    ? await transaction
        .update(schema.environmentProviderResources)
        .set(values)
        .where(eq(schema.environmentProviderResources.id, existing.id))
        .returning()
    : await transaction
        .insert(schema.environmentProviderResources)
        .values({ id: crypto.randomUUID(), ...values, createdAt: now })
        .returning();
  if (!row) throw new Error("Provider resource upsert failed.");
  return parseResourceRow(row);
}

export async function promoteEnvironmentProviderReplacement(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  replacementId: string;
  roles?: Array<"workspace_compute" | "workspace_storage"> | undefined;
  expectedReplacementExternalIds?:
    | Partial<Record<"workspace_compute" | "workspace_storage", string>>
    | undefined;
  expectedRetiredExternalIds?:
    | Partial<Record<"workspace_compute" | "workspace_storage", string>>
    | undefined;
}) {
  return knowledgeDb.transaction((transaction) =>
    promoteEnvironmentProviderReplacementInTransaction(transaction, input),
  );
}

export async function promoteEnvironmentProviderReplacementInTransaction(
  transaction: EnvironmentTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    workspaceId: string;
    replacementId: string;
    roles?: Array<"workspace_compute" | "workspace_storage"> | undefined;
    expectedReplacementExternalIds?:
      | Partial<Record<"workspace_compute" | "workspace_storage", string>>
      | undefined;
    expectedRetiredExternalIds?:
      | Partial<Record<"workspace_compute" | "workspace_storage", string>>
      | undefined;
  },
) {
    const roles = input.roles ?? ["workspace_storage", "workspace_compute"];
    const now = new Date();
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`environment-provider-replacement:${input.environmentId}:${input.workspaceId}`}, 0))`,
    );
    const replacements =
      await transaction.query.environmentProviderResources.findMany({
        where: (table, { and, eq, inArray, isNull }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.environmentId, input.environmentId),
            eq(table.workspaceId, input.workspaceId),
            eq(table.replacementId, input.replacementId),
            inArray(table.resourceRole, roles),
            isNull(table.deletedAt),
          ),
      });
    if (replacements.length === 0 && input.expectedReplacementExternalIds) {
      const resources =
        await transaction.query.environmentProviderResources.findMany({
          where: (table, { and, eq, inArray }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.environmentId, input.environmentId),
              eq(table.workspaceId, input.workspaceId),
              inArray(table.resourceRole, roles),
            ),
        });
      const promoted = roles.map((role) =>
        resources.find((resource) =>
          resource.resourceRole === role &&
          resource.replacementId === null &&
          resource.deletedAt === null &&
          resource.externalId === input.expectedReplacementExternalIds?.[role]
        )
      );
      if (promoted.every((resource) => resource !== undefined)) {
        const retired = input.expectedRetiredExternalIds
          ? roles.flatMap((role) => {
              const resource = resources.find((candidate) =>
                candidate.resourceRole === role &&
                candidate.deletedAt !== null &&
                candidate.state === "replaced" &&
                candidate.externalId === input.expectedRetiredExternalIds?.[role]
              );
              return resource ? [resource] : [];
            })
          : [];
        return {
          promoted: promoted.map((resource) => parseResourceRow(resource!)),
          retired: retired.map(parseResourceRow),
        };
      }
    }
    if (replacements.length !== roles.length) {
      throw new EnvironmentProviderPersistenceError(
        "PROVIDER_RESOURCE_CONFLICT",
        "Replacement resource set is incomplete.",
      );
    }
    const primaries =
      await transaction.query.environmentProviderResources.findMany({
        where: (table, { and, eq, inArray, isNull }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.environmentId, input.environmentId),
            eq(table.workspaceId, input.workspaceId),
            inArray(table.resourceRole, roles),
            isNull(table.replacementId),
            isNull(table.deletedAt),
          ),
      });
    if (primaries.length > 0) {
      await transaction
        .update(schema.environmentProviderResources)
        .set({ deletedAt: now, state: "replaced", updatedAt: now })
        .where(
          and(
            eq(schema.environmentProviderResources.organizationId, input.organizationId),
            eq(schema.environmentProviderResources.environmentId, input.environmentId),
            eq(schema.environmentProviderResources.workspaceId, input.workspaceId),
            inArray(schema.environmentProviderResources.resourceRole, roles),
            isNull(schema.environmentProviderResources.replacementId),
            isNull(schema.environmentProviderResources.deletedAt),
          ),
        );
    }
    const promoted = await transaction
      .update(schema.environmentProviderResources)
      .set({ replacementId: null, updatedAt: now })
      .where(
        and(
          eq(schema.environmentProviderResources.organizationId, input.organizationId),
          eq(schema.environmentProviderResources.environmentId, input.environmentId),
          eq(schema.environmentProviderResources.workspaceId, input.workspaceId),
          eq(schema.environmentProviderResources.replacementId, input.replacementId),
          inArray(schema.environmentProviderResources.resourceRole, roles),
          isNull(schema.environmentProviderResources.deletedAt),
        ),
      )
      .returning();
    return {
      promoted: promoted.map(parseResourceRow),
      retired: primaries.map((row) =>
        parseResourceRow({ ...row, deletedAt: now, state: "replaced", updatedAt: now }),
      ),
    };
}

export async function listEnvironmentProviderResources(input: {
  organizationId: string;
  environmentId: string;
  workspaceId?: string | undefined;
  includeDeleted?: boolean | undefined;
}) {
  const rows = await knowledgeDb.query.environmentProviderResources.findMany({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        input.workspaceId ? eq(table.workspaceId, input.workspaceId) : undefined,
        input.includeDeleted ? undefined : isNull(table.deletedAt),
      ),
    orderBy: (table, { asc }) => [
      asc(table.resourceRole),
      asc(table.createdAt),
      asc(table.id),
    ],
  });
  return rows.map(parseResourceRow);
}

export async function tombstoneEnvironmentProviderResource(input: {
  organizationId: string;
  resourceId: string;
  state?: string | undefined;
}) {
  const [row] = await knowledgeDb
    .update(schema.environmentProviderResources)
    .set({
      deletedAt: new Date(),
      state: input.state ?? "deleted",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.environmentProviderResources.id, input.resourceId),
        eq(
          schema.environmentProviderResources.organizationId,
          input.organizationId,
        ),
        isNull(schema.environmentProviderResources.deletedAt),
      ),
    )
    .returning();
  return row ? parseResourceRow(row) : null;
}

export async function resolveFlyProviderResourceIdentity(input: {
  organizationId: string;
  environmentId: string;
  workspaceId?: string | null | undefined;
  role: EnvironmentResourceRole;
  legacyExternalId: string | null;
}) {
  const binding = await resolveEnvironmentProviderConnection({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  if (!(binding?.connection && binding.environment.provider === "fly")) {
    throw new EnvironmentProviderPersistenceError(
      "PROVIDER_CONNECTION_MISMATCH",
      "Fly resource resolution requires a Fly Environment binding.",
    );
  }
  const neutral =
    await knowledgeDb.query.environmentProviderResources.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          input.workspaceId
            ? eq(table.workspaceId, input.workspaceId)
            : isNull(table.workspaceId),
          eq(table.resourceRole, input.role),
          isNull(table.deletedAt),
        ),
    });
  if (neutral) {
    const parsed = parseResourceRow(neutral);
    if (
      input.legacyExternalId &&
      parsed.externalId !== input.legacyExternalId
    ) {
      await knowledgeDb
        .update(schema.environments)
        .set({
          status: "degraded",
          failureCode: "PROVIDER_RESOURCE_CONFLICT",
          failureMessage: `${input.role} differs between neutral and legacy provider identity.`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.environments.id, input.environmentId),
            eq(schema.environments.organizationId, input.organizationId),
          ),
        );
      throw new EnvironmentProviderPersistenceError(
        "PROVIDER_RESOURCE_CONFLICT",
        `${input.role} differs between neutral and legacy provider identity.`,
      );
    }
    return { externalId: parsed.externalId, source: "neutral" as const };
  }
  if (!input.legacyExternalId) return null;
  await upsertEnvironmentProviderResource({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    workspaceId: input.workspaceId ?? null,
    providerConnectionId: binding.connection.id,
    provider: "fly",
    resourceRole: input.role,
    externalId: input.legacyExternalId,
    providerUid: null,
    desiredRevision: "legacy-v1",
    observedGeneration: input.legacyExternalId,
    state: null,
    providerMetadata: {
      contract: "provider-resource-metadata-v1",
      source: "read_repair",
    },
  });
  return { externalId: input.legacyExternalId, source: "legacy_fallback" as const };
}

export async function mirrorFlyProviderConnectionInTransaction(
  transaction: EnvironmentTransaction,
  input: {
    organizationId: string;
    organizationSlug: string;
    encryptedCredential: string;
    enabled: boolean;
    status: "not_configured" | "ready" | "degraded";
    configuredByUserId?: string | null | undefined;
    now: Date;
  },
) {
  const id = flyEnvironmentProviderConnectionId(input.organizationId);
  const existing =
    await transaction.query.environmentProviderConnections.findFirst({
      where: (table, { eq }) => eq(table.id, id),
      columns: { id: true },
    });
  const values = {
    organizationId: input.organizationId,
    provider: "fly" as const,
    displayName: "Fly.io",
    isDefault: true,
    status:
      input.enabled && input.status === "ready"
        ? ("ready" as const)
        : ("degraded" as const),
    supportStatus: "certified" as const,
    configuration: {
      contract: "fly-connection-configuration-v1" as const,
      organizationSlug: input.organizationSlug,
    },
    qualificationEvidence: [
      { level: "production" as const, phase: "slice-2-fly-mirror" },
    ],
    encryptedCredential: input.encryptedCredential,
    configuredByUserId: input.configuredByUserId ?? null,
    configuredAt: input.now,
    failureCode: null,
    failureMessage: null,
    updatedAt: input.now,
  };
  const [row] = existing
    ? await transaction
        .update(schema.environmentProviderConnections)
        .set(values)
        .where(eq(schema.environmentProviderConnections.id, id))
        .returning()
    : await transaction
        .insert(schema.environmentProviderConnections)
        .values({ id, ...values, createdAt: input.now })
        .returning();
  if (!row) throw new Error("Fly provider connection mirror failed.");
  return parseConnectionRow(row);
}

export async function runFlyProviderPersistenceBackfillBatch(input: {
  batchSize?: number | undefined;
}) {
  const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
  return knowledgeDb.transaction(async (transaction) => {
    const candidates = await transaction
      .select({
        id: schema.environments.id,
        organizationId: schema.environments.organizationId,
      })
      .from(schema.environments)
      .where(
        and(
          eq(schema.environments.provider, "fly"),
          isNull(schema.environments.archivedAt),
          or(
            isNull(schema.environments.providerConnectionId),
            sql`(
              ${schema.environments.flyAppName} IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${schema.environmentProviderResources} resource
                WHERE resource.environment_id = ${schema.environments.id}
                  AND resource.resource_role = 'environment_scope'
                  AND resource.deleted_at IS NULL
              )
            )`,
            sql`(
              ${schema.environments.flyGatewayMachineId} IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${schema.environmentProviderResources} resource
                WHERE resource.environment_id = ${schema.environments.id}
                  AND resource.resource_role = 'gateway'
                  AND resource.deleted_at IS NULL
              )
            )`,
            sql`EXISTS (
              SELECT 1 FROM ${schema.environmentWorkspaces} workspace
              WHERE workspace.environment_id = ${schema.environments.id}
                AND workspace.deleted_at IS NULL
                AND workspace.fly_machine_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM ${schema.environmentProviderResources} resource
                  WHERE resource.workspace_id = workspace.id
                    AND resource.resource_role = 'workspace_compute'
                    AND resource.deleted_at IS NULL
                )
            )`,
            sql`EXISTS (
              SELECT 1 FROM ${schema.environmentWorkspaces} workspace
              WHERE workspace.environment_id = ${schema.environments.id}
                AND workspace.deleted_at IS NULL
                AND workspace.fly_volume_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM ${schema.environmentProviderResources} resource
                  WHERE resource.workspace_id = workspace.id
                    AND resource.resource_role = 'workspace_storage'
                    AND resource.deleted_at IS NULL
                )
            )`,
          ),
        ),
      )
      .limit(batchSize)
      .for("update", { skipLocked: true });
    let migrated = 0;
    for (const candidate of candidates) {
      const legacy = await transaction.query.aiProviderConnections.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, candidate.organizationId),
            eq(table.provider, "fly"),
          ),
      });
      if (!legacy) continue;
      const metadata = (legacy.metadata ?? {}) as { organizationSlug?: unknown };
      const organizationSlug =
        typeof metadata.organizationSlug === "string"
          ? metadata.organizationSlug.trim()
          : "";
      if (!(legacy.apiKey && organizationSlug)) continue;
      await mirrorFlyProviderConnectionInTransaction(transaction, {
        organizationId: candidate.organizationId,
        organizationSlug,
        encryptedCredential: legacy.apiKey,
        enabled: legacy.enabled,
        status: legacy.status,
        now: new Date(),
      });
      await transaction
        .update(schema.environments)
        .set({
          providerConnectionId: flyEnvironmentProviderConnectionId(
            candidate.organizationId,
          ),
          updatedAt: new Date(),
        })
        .where(eq(schema.environments.id, candidate.id));
      await transaction
        .update(schema.environmentWorkspaces)
        .set({
          flyMachineId: sql`${schema.environmentWorkspaces.flyMachineId}`,
          flyVolumeId: sql`${schema.environmentWorkspaces.flyVolumeId}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.environmentWorkspaces.environmentId, candidate.id));
      migrated += 1;
    }
    return {
      eligible: candidates.length,
      migrated,
      incomplete: candidates.length - migrated,
      remainingMayExist: candidates.length === batchSize,
    };
  });
}

export const providerPersistenceParsers = {
  connectionConfiguration: environmentProviderConnectionConfigurationSchema,
  qualificationEvidence: environmentProviderQualificationEvidenceSchema,
  resourceMetadata: environmentProviderResourceMetadataV1Schema,
};
