import { and, eq, inArray } from "drizzle-orm";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { listCoreAppDefinitions } from "./catalog";
import type {
  CreateEnvironmentAppConnectionInput,
  EnvironmentAppCapabilityGrantInput,
} from "./contracts";
import {
  type AppCredentialPayload,
  decryptAppCredential,
  encryptAppCredential,
} from "./credential-crypto";
import { getAppProviderAdapter } from "./provider-adapter";
import type {
  AppAuthMethod,
  AppCatalogItem,
  AppConnectionSummary,
  AppDetail,
  AppInstallationStatus,
  AppReadiness,
  AppsOverview,
  EnvironmentAppConfiguration,
} from "./types";

const APP_AUTH_METHODS = new Set<AppAuthMethod>([
  "none",
  "api_key",
  "oauth_personal",
  "oauth_environment",
  "deployment_managed",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function authMethods(value: unknown): AppAuthMethod[] {
  const methods = record(value).authMethods;
  if (!Array.isArray(methods)) return [];
  return methods.filter(
    (method): method is AppAuthMethod =>
      typeof method === "string" && APP_AUTH_METHODS.has(method as AppAuthMethod)
  );
}

export class AppServiceError extends Error {
  readonly code:
    | "APP_NOT_FOUND"
    | "APP_NOT_INSTALLABLE"
    | "APP_ALREADY_INSTALLED"
    | "APP_NOT_INSTALLED"
    | "APP_CONNECTION_NOT_SUPPORTED"
    | "APP_CONNECTION_NOT_FOUND"
    | "ENVIRONMENT_NOT_FOUND";

  constructor(code: AppServiceError["code"], message: string) {
    super(message);
    this.name = "AppServiceError";
    this.code = code;
  }
}

export async function ensureCoreAppCatalog() {
  const now = new Date();
  for (const app of listCoreAppDefinitions()) {
    await knowledgeDb
      .insert(schema.appDefinitions)
      .values({
        key: app.key,
        slug: app.slug,
        displayName: app.displayName,
        description: app.description,
        category: app.category,
        kind: app.kind,
        connectionModel: app.connectionModel,
        connectionRequirement: app.connectionRequirement,
        delivery: app.delivery,
        installMode: app.installMode,
        icon: app.icon,
        published: true,
        metadata: app.metadata,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.appDefinitions.key,
        set: {
          slug: app.slug,
          displayName: app.displayName,
          description: app.description,
          category: app.category,
          kind: app.kind,
          connectionModel: app.connectionModel,
          connectionRequirement: app.connectionRequirement,
          delivery: app.delivery,
          installMode: app.installMode,
          icon: app.icon,
          published: true,
          metadata: app.metadata,
          updatedAt: now,
        },
      });

    for (const capability of app.capabilities) {
      await knowledgeDb
        .insert(schema.appCapabilities)
        .values({
          appKey: app.key,
          key: capability.key,
          runtimeName: capability.runtimeName,
          displayName: capability.displayName,
          description: capability.description,
          groupKey: capability.groupKey,
          accessMode: capability.accessMode,
          audience: capability.audience,
          defaultEnabled: capability.defaultEnabled,
          defaultApprovalMode: capability.defaultApprovalMode,
          defaultRateLimitMode: capability.defaultRateLimitMode,
          defaultLoggingMode: capability.defaultLoggingMode,
          defaultSettings: capability.defaultSettings,
          metadata: capability.metadata,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.appCapabilities.appKey, schema.appCapabilities.key],
          set: {
            runtimeName: capability.runtimeName,
            displayName: capability.displayName,
            description: capability.description,
            groupKey: capability.groupKey,
            accessMode: capability.accessMode,
            audience: capability.audience,
            defaultEnabled: capability.defaultEnabled,
            defaultApprovalMode: capability.defaultApprovalMode,
            defaultRateLimitMode: capability.defaultRateLimitMode,
            defaultLoggingMode: capability.defaultLoggingMode,
            defaultSettings: capability.defaultSettings,
            metadata: capability.metadata,
            updatedAt: now,
          },
        });
    }
  }
}

export async function ensureEnvironmentAppPolicies(input: {
  organizationId: string;
  environmentId: string;
}) {
  await ensureCoreAppCatalog();
  const environment = await getOrganizationEnvironment(input);
  if (!environment) {
    throw new AppServiceError(
      "ENVIRONMENT_NOT_FOUND",
      "Environment not found."
    );
  }
  const [definitions, installations, capabilities] = await Promise.all([
    knowledgeDb.query.appDefinitions.findMany({
      where: (table, { eq: equals }) => equals(table.published, true),
    }),
    knowledgeDb.query.appInstallations.findMany({
      where: (table, { eq: equals }) =>
        equals(table.organizationId, input.organizationId),
    }),
    knowledgeDb.query.appCapabilities.findMany(),
  ]);
  const installationByApp = new Map(
    installations.map((installation) => [installation.appKey, installation])
  );
  const availableAppKeys = new Set(
    definitions.flatMap((definition) =>
      definition.installMode === "inherited" ||
      installationByApp.get(definition.key)?.status === "installed"
        ? [definition.key]
        : []
    )
  );
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    for (const definition of definitions) {
      if (definition.installMode !== "inherited") continue;
      await transaction
        .insert(schema.appInstallations)
        .values({
          organizationId: input.organizationId,
          appKey: definition.key,
          status: "installed",
          settings: {},
          installedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
    for (const capability of capabilities) {
      if (!availableAppKeys.has(capability.appKey)) continue;
      await transaction
        .insert(schema.environmentAppCapabilityGrants)
        .values({
          environmentId: input.environmentId,
          appKey: capability.appKey,
          capabilityKey: capability.key,
          enabled: capability.defaultEnabled,
          approvalMode: capability.defaultEnabled
            ? capability.defaultApprovalMode
            : "deny",
          loggingMode: capability.defaultLoggingMode,
          rateLimitMode: capability.defaultRateLimitMode,
          settings: capability.defaultSettings,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
  });
}

function resolveReadiness(input: {
  installMode: "inherited" | "explicit";
  installationStatus: AppInstallationStatus;
  connectionModel: "none" | "personal" | "environment" | "hybrid";
  connectionRequirement: "none" | "optional" | "required";
  connections: AppConnectionSummary[];
}): AppReadiness {
  if (input.installationStatus === "disabled") return "disabled";
  if (
    input.installMode === "explicit" &&
    input.installationStatus === "not_installed"
  ) {
    return "install_required";
  }
  if (
    input.connectionModel === "none" ||
    input.connectionRequirement !== "required"
  ) {
    return "ready";
  }
  if (
    input.connections.some((connection) => connection.status === "connected")
  ) {
    return "ready";
  }
  if (
    input.connections.some((connection) => connection.status === "degraded")
  ) {
    return "degraded";
  }
  return "setup_required";
}

function connectionSummary(
  row: typeof schema.appConnections.$inferSelect,
  userId: string
): AppConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    ownerType: row.ownerType,
    status: row.status,
    environmentId: row.environmentId,
    isMine: row.userId === userId,
    lastHealthAt: row.lastHealthAt?.toISOString() ?? null,
  };
}

export async function listAppsForOrganization(input: {
  organizationId: string;
  userId: string;
  canManageOrganization: boolean;
}): Promise<AppsOverview> {
  await ensureCoreAppCatalog();
  const [definitions, capabilities, installations, connectionRows] =
    await Promise.all([
      knowledgeDb.query.appDefinitions.findMany({
        where: (table, { eq: equals }) => equals(table.published, true),
        orderBy: (table, { asc }) => [asc(table.displayName)],
      }),
      knowledgeDb.query.appCapabilities.findMany(),
      knowledgeDb.query.appInstallations.findMany({
        where: (table, { eq: equals }) =>
          equals(table.organizationId, input.organizationId),
      }),
      knowledgeDb.query.appConnections.findMany({
        where: (table, { and: all, eq: equals, isNull, or }) =>
          all(
            equals(table.organizationId, input.organizationId),
            or(equals(table.userId, input.userId), isNull(table.userId))
          ),
      }),
    ]);

  const installationByApp = new Map(
    installations.map((installation) => [installation.appKey, installation])
  );
  const capabilitiesByApp = new Map<string, typeof capabilities>();
  for (const capability of capabilities) {
    const rows = capabilitiesByApp.get(capability.appKey) ?? [];
    rows.push(capability);
    capabilitiesByApp.set(capability.appKey, rows);
  }
  const connectionsByApp = new Map<string, AppConnectionSummary[]>();
  for (const row of connectionRows) {
    const rows = connectionsByApp.get(row.appKey) ?? [];
    rows.push(connectionSummary(row, input.userId));
    connectionsByApp.set(row.appKey, rows);
  }

  const apps: AppCatalogItem[] = definitions.map((definition) => {
    const installation = installationByApp.get(definition.key);
    const installationStatus: AppInstallationStatus =
      definition.installMode === "inherited"
        ? "installed"
        : (installation?.status ?? "not_installed");
    const appCapabilities = capabilitiesByApp.get(definition.key) ?? [];
    const connections = connectionsByApp.get(definition.key) ?? [];
    return {
      key: definition.key,
      slug: definition.slug,
      displayName: definition.displayName,
      description: definition.description,
      category: definition.category,
      kind: definition.kind,
      connectionModel: definition.connectionModel,
      connectionRequirement: definition.connectionRequirement,
      authMethods: authMethods(definition.metadata),
      delivery: definition.delivery,
      installMode: definition.installMode,
      icon: definition.icon,
      installationStatus,
      readiness: resolveReadiness({
        installMode: definition.installMode,
        installationStatus,
        connectionModel: definition.connectionModel,
        connectionRequirement: definition.connectionRequirement,
        connections,
      }),
      capabilityCount: appCapabilities.length,
      capabilityGroups: [
        ...new Set(appCapabilities.map((capability) => capability.groupKey)),
      ],
      connectionCount: connections.length,
      canManageInstallation: input.canManageOrganization,
    };
  });

  return {
    apps,
    categories: [...new Set(apps.map((app) => app.category))],
    canManageOrganization: input.canManageOrganization,
    canCreateCustomApp: input.canManageOrganization,
    userId: input.userId,
  };
}

export async function getAppForOrganization(input: {
  organizationId: string;
  userId: string;
  canManageOrganization: boolean;
  appKey: string;
}): Promise<AppDetail | null> {
  const overview = await listAppsForOrganization(input);
  const item = overview.apps.find((app) => app.key === input.appKey);
  if (!item) return null;
  const [definition, capabilityRows, connectionRows] = await Promise.all([
    knowledgeDb.query.appDefinitions.findFirst({
      where: (table, { eq: equals }) => equals(table.key, input.appKey),
    }),
    knowledgeDb.query.appCapabilities.findMany({
      where: (table, { eq: equals }) => equals(table.appKey, input.appKey),
      orderBy: (table, { asc }) => [
        asc(table.groupKey),
        asc(table.displayName),
      ],
    }),
    knowledgeDb.query.appConnections.findMany({
      where: (table, { and: all, eq: equals, isNull, or }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.appKey, input.appKey),
          or(equals(table.userId, input.userId), isNull(table.userId))
        ),
      orderBy: (table, { asc }) => [asc(table.name)],
    }),
  ]);
  if (!definition) return null;
  return {
    ...item,
    capabilities: capabilityRows.map((capability) => ({
      key: capability.key,
      runtimeName: capability.runtimeName,
      displayName: capability.displayName,
      description: capability.description,
      groupKey: capability.groupKey,
      accessMode: capability.accessMode,
      audience: capability.audience,
      defaultEnabled: capability.defaultEnabled,
      defaultApprovalMode: capability.defaultApprovalMode,
      defaultLoggingMode: capability.defaultLoggingMode,
      defaultRateLimitMode: capability.defaultRateLimitMode,
      metadata: record(capability.metadata),
    })),
    connections: connectionRows.map((connection) =>
      connectionSummary(connection, input.userId)
    ),
    metadata: record(definition.metadata),
  };
}

export async function setAppInstallation(input: {
  organizationId: string;
  appKey: string;
  actorUserId: string;
  installed: boolean;
}) {
  await ensureCoreAppCatalog();
  const definition = await knowledgeDb.query.appDefinitions.findFirst({
    where: (table, { eq: equals }) => equals(table.key, input.appKey),
  });
  if (!definition) {
    throw new AppServiceError("APP_NOT_FOUND", "App not found.");
  }
  if (definition.installMode === "inherited") {
    throw new AppServiceError(
      "APP_NOT_INSTALLABLE",
      "Built-in Apps are inherited and cannot be removed."
    );
  }
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .insert(schema.appInstallations)
      .values({
        organizationId: input.organizationId,
        appKey: input.appKey,
        status: input.installed ? "installed" : "disabled",
        installedByUserId: input.actorUserId,
        settings: {},
        installedAt: now,
        disabledAt: input.installed ? null : now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.appInstallations.organizationId,
          schema.appInstallations.appKey,
        ],
        set: {
          status: input.installed ? "installed" : "disabled",
          installedByUserId: input.actorUserId,
          disabledAt: input.installed ? null : now,
          updatedAt: now,
        },
      });
    if (!input.installed) return;
    const [environments, capabilities] = await Promise.all([
      transaction.query.environments.findMany({
        where: (table, { and: all, eq: equals, isNull }) =>
          all(
            equals(table.organizationId, input.organizationId),
            isNull(table.archivedAt)
          ),
        columns: { id: true },
      }),
      transaction.query.appCapabilities.findMany({
        where: (table, { eq: equals }) => equals(table.appKey, input.appKey),
      }),
    ]);
    for (const environment of environments) {
      for (const capability of capabilities) {
        await transaction
          .insert(schema.environmentAppCapabilityGrants)
          .values({
            environmentId: environment.id,
            appKey: input.appKey,
            capabilityKey: capability.key,
            enabled: capability.defaultEnabled,
            approvalMode: capability.defaultEnabled
              ? capability.defaultApprovalMode
              : "deny",
            loggingMode: capability.defaultLoggingMode,
            rateLimitMode: capability.defaultRateLimitMode,
            settings: capability.defaultSettings,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
      }
    }
  });
}

export async function listAppConnectionsForEnvironment(input: {
  organizationId: string;
  environmentId: string;
  appKeys?: string[];
}) {
  return knowledgeDb.query.appConnections.findMany({
    where: and(
      eq(schema.appConnections.organizationId, input.organizationId),
      eq(schema.appConnections.environmentId, input.environmentId),
      input.appKeys?.length
        ? inArray(schema.appConnections.appKey, input.appKeys)
        : undefined
    ),
  });
}

async function requireEnvironmentApp(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
}) {
  await ensureCoreAppCatalog();
  const [environment, definition, installation] = await Promise.all([
    getOrganizationEnvironment({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
    }),
    knowledgeDb.query.appDefinitions.findFirst({
      where: (table, { eq: equals }) => equals(table.key, input.appKey),
    }),
    knowledgeDb.query.appInstallations.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.appKey, input.appKey)
        ),
    }),
  ]);
  if (!environment) {
    throw new AppServiceError(
      "ENVIRONMENT_NOT_FOUND",
      "Environment not found."
    );
  }
  if (!definition) {
    throw new AppServiceError("APP_NOT_FOUND", "App not found.");
  }
  const installed =
    definition.installMode === "inherited" ||
    installation?.status === "installed";
  if (!installed) {
    throw new AppServiceError(
      "APP_NOT_INSTALLED",
      "Install this App before configuring the Environment."
    );
  }
  return { environment, definition, installation };
}

export async function getEnvironmentAppConfiguration(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
}): Promise<EnvironmentAppConfiguration> {
  const { definition } = await requireEnvironmentApp(input);
  const [capabilityRows, grantRows, connectionRows] = await Promise.all([
    knowledgeDb.query.appCapabilities.findMany({
      where: (table, { eq: equals }) => equals(table.appKey, input.appKey),
      orderBy: (table, { asc }) => [
        asc(table.groupKey),
        asc(table.displayName),
      ],
    }),
    knowledgeDb.query.environmentAppCapabilityGrants.findMany({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.environmentId, input.environmentId),
          equals(table.appKey, input.appKey)
        ),
    }),
    knowledgeDb.query.appConnections.findMany({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.environmentId, input.environmentId),
          equals(table.appKey, input.appKey)
        ),
      orderBy: (table, { asc }) => [asc(table.name)],
    }),
  ]);
  const grants = new Map(
    grantRows.map((grant) => [grant.capabilityKey, grant])
  );
  const connections = connectionRows.map((connection) =>
    connectionSummary(connection, "")
  );
  const installationStatus: AppInstallationStatus =
    definition.installMode === "inherited" ? "installed" : "installed";
  return {
    environmentId: input.environmentId,
    app: {
      key: definition.key,
      slug: definition.slug,
      displayName: definition.displayName,
      description: definition.description,
      category: definition.category,
      connectionModel: definition.connectionModel,
      connectionRequirement: definition.connectionRequirement,
      authMethods: authMethods(definition.metadata),
      delivery: definition.delivery,
      icon: definition.icon,
      installationStatus,
      readiness: resolveReadiness({
        installMode: definition.installMode,
        installationStatus,
        connectionModel: definition.connectionModel,
        connectionRequirement: definition.connectionRequirement,
        connections,
      }),
    },
    connections,
    capabilities: capabilityRows.map((capability) => {
      const grant = grants.get(capability.key);
      return {
        key: capability.key,
        runtimeName: capability.runtimeName,
        displayName: capability.displayName,
        description: capability.description,
        groupKey: capability.groupKey,
        accessMode: capability.accessMode,
        audience: capability.audience,
        defaultEnabled: capability.defaultEnabled,
        defaultApprovalMode: capability.defaultApprovalMode,
        defaultLoggingMode: capability.defaultLoggingMode,
        defaultRateLimitMode: capability.defaultRateLimitMode,
        metadata: record(capability.metadata),
        enabled: grant?.enabled ?? capability.defaultEnabled,
        approvalMode: grant?.approvalMode ?? capability.defaultApprovalMode,
        loggingMode: grant?.loggingMode ?? capability.defaultLoggingMode,
        rateLimitMode: grant?.rateLimitMode ?? capability.defaultRateLimitMode,
        inheritedDefault: !grant,
      };
    }),
  };
}

export async function listEnvironmentAppConfigurations(input: {
  organizationId: string;
  environmentId: string;
}) {
  await ensureEnvironmentAppPolicies(input);
  const [installations, definitions] = await Promise.all([
    knowledgeDb.query.appInstallations.findMany({
      where: (table, { eq: equals }) =>
        equals(table.organizationId, input.organizationId),
    }),
    knowledgeDb.query.appDefinitions.findMany({
      where: (table, { eq: equals }) => equals(table.published, true),
      orderBy: (table, { asc }) => [asc(table.displayName)],
    }),
  ]);
  const installationByApp = new Map(
    installations.map((installation) => [installation.appKey, installation])
  );
  const availableDefinitions = definitions.filter(
    (definition) =>
      definition.installMode === "inherited" ||
      installationByApp.get(definition.key)?.status === "installed"
  );
  return Promise.all(
    availableDefinitions.map((definition) =>
      getEnvironmentAppConfiguration({ ...input, appKey: definition.key })
    )
  );
}

async function validateEnvironmentConnection(
  appKey: string,
  input: CreateEnvironmentAppConnectionInput
) {
  const adapter = getAppProviderAdapter(appKey);
  if (!adapter?.validateEnvironmentConnection) {
    throw new AppServiceError(
      "APP_CONNECTION_NOT_SUPPORTED",
      "This App does not support managed Environment connections yet."
    );
  }
  return adapter.validateEnvironmentConnection(input);
}

function createEnvironmentCredential(
  appKey: string,
  input: CreateEnvironmentAppConnectionInput
) {
  const adapter = getAppProviderAdapter(appKey);
  if (!adapter?.createEnvironmentCredential) {
    throw new AppServiceError(
      "APP_CONNECTION_NOT_SUPPORTED",
      "This App does not support managed Environment credentials yet."
    );
  }
  return adapter.createEnvironmentCredential(input);
}

export async function saveEnvironmentAppConnection(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  actorUserId: string;
  connection: CreateEnvironmentAppConnectionInput;
}) {
  const { definition } = await requireEnvironmentApp(input);
  if (
    (definition.connectionModel !== "environment" &&
      definition.connectionModel !== "hybrid") ||
    definition.delivery !== "api_key"
  ) {
    throw new AppServiceError(
      "APP_CONNECTION_NOT_SUPPORTED",
      "This App does not accept shared Environment connections."
    );
  }
  const health = await validateEnvironmentConnection(
    input.appKey,
    input.connection
  );
  const credentialPayload = createEnvironmentCredential(
    input.appKey,
    input.connection
  );
  const now = health.checkedAt;
  return knowledgeDb.transaction(async (transaction) => {
    const existing = await transaction.query.appConnections.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.environmentId, input.environmentId),
          equals(table.appKey, input.appKey),
          equals(table.ownerType, "environment"),
          equals(table.name, input.connection.name)
        ),
    });
    if (existing?.credentialId) {
      await transaction
        .update(schema.appCredentials)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(eq(schema.appCredentials.id, existing.credentialId));
    }
    const credentialId = crypto.randomUUID();
    const payload: AppCredentialPayload = credentialPayload;
    const encryptedPayload = encryptAppCredential({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      appKey: input.appKey,
      credentialId,
      payload,
    });
    await transaction.insert(schema.appCredentials).values({
      id: credentialId,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      appKey: input.appKey,
      name: input.connection.name,
      kind: "api_key",
      encryptedPayload,
      envelopeVersion: "kapp:v1",
      status: "active",
      createdByUserId: input.actorUserId,
      metadata: { verifiedAt: now.toISOString() },
      createdAt: now,
      updatedAt: now,
    });
    const [connection] = existing
      ? await transaction
          .update(schema.appConnections)
          .set({
            credentialId,
            status: "connected",
            failureCode: null,
            failureMessage: null,
            lastHealthAt: now,
            disconnectedAt: null,
            updatedAt: now,
          })
          .where(eq(schema.appConnections.id, existing.id))
          .returning()
      : await transaction
          .insert(schema.appConnections)
          .values({
            organizationId: input.organizationId,
            environmentId: input.environmentId,
            appKey: input.appKey,
            ownerType: "environment",
            credentialId,
            name: input.connection.name,
            status: "connected",
            lastHealthAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
    if (!connection) {
      throw new Error("App connection could not be saved.");
    }
    const capabilities = await transaction.query.appCapabilities.findMany({
      where: (table, { eq: equals }) => equals(table.appKey, input.appKey),
    });
    for (const capability of capabilities) {
      await transaction
        .insert(schema.environmentAppCapabilityGrants)
        .values({
          environmentId: input.environmentId,
          appKey: input.appKey,
          capabilityKey: capability.key,
          enabled: capability.defaultEnabled,
          approvalMode: capability.defaultEnabled
            ? capability.defaultApprovalMode
            : "deny",
          loggingMode: capability.defaultLoggingMode,
          rateLimitMode: capability.defaultRateLimitMode,
          settings: capability.defaultSettings,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
    return connectionSummary(connection, "");
  });
}

export async function disconnectEnvironmentAppConnection(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  connectionId: string;
}) {
  const { definition } = await requireEnvironmentApp(input);
  return knowledgeDb.transaction(async (transaction) => {
    const connection = await transaction.query.appConnections.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, input.connectionId),
          equals(table.organizationId, input.organizationId),
          equals(table.environmentId, input.environmentId),
          equals(table.appKey, input.appKey),
          equals(table.ownerType, "environment")
        ),
    });
    if (!connection) {
      throw new AppServiceError(
        "APP_CONNECTION_NOT_FOUND",
        "App connection not found."
      );
    }
    const now = new Date();
    if (connection.credentialId) {
      await transaction
        .update(schema.appCredentials)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(eq(schema.appCredentials.id, connection.credentialId));
    }
    const [disconnected] = await transaction
      .update(schema.appConnections)
      .set({
        status: "disconnected",
        failureCode: "DISCONNECTED_BY_ADMIN",
        failureMessage: null,
        disconnectedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.appConnections.id, connection.id))
      .returning();
    if (!disconnected)
      throw new Error("App connection could not be disconnected.");
    if (definition.delivery === "mcp") {
      await transaction
        .update(schema.mcpServers)
        .set({ status: "disabled", updatedAt: now })
        .where(
          and(
            eq(schema.mcpServers.id, connection.id),
            eq(schema.mcpServers.organizationId, input.organizationId),
            eq(schema.mcpServers.environmentId, input.environmentId)
          )
        );
    }
    return connectionSummary(disconnected, "");
  });
}

export async function saveEnvironmentAppCapabilityGrant(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  capabilityKey: string;
  grant: EnvironmentAppCapabilityGrantInput;
}) {
  await requireEnvironmentApp(input);
  const capability = await knowledgeDb.query.appCapabilities.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.appKey, input.appKey),
        equals(table.key, input.capabilityKey)
      ),
  });
  if (!capability) {
    throw new AppServiceError("APP_NOT_FOUND", "App capability not found.");
  }
  const now = new Date();
  const [grant] = await knowledgeDb
    .insert(schema.environmentAppCapabilityGrants)
    .values({
      environmentId: input.environmentId,
      appKey: input.appKey,
      capabilityKey: input.capabilityKey,
      ...input.grant,
      settings: capability.defaultSettings,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.environmentAppCapabilityGrants.environmentId,
        schema.environmentAppCapabilityGrants.appKey,
        schema.environmentAppCapabilityGrants.capabilityKey,
      ],
      set: { ...input.grant, updatedAt: now },
    })
    .returning();
  if (!grant) throw new Error("Environment App capability could not be saved.");
  return grant;
}

export async function resolveEnvironmentAppCredential(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  connectionId: string;
}) {
  const row = await knowledgeDb
    .select({
      connection: schema.appConnections,
      credential: schema.appCredentials,
    })
    .from(schema.appConnections)
    .innerJoin(
      schema.appCredentials,
      eq(schema.appCredentials.id, schema.appConnections.credentialId)
    )
    .where(
      and(
        eq(schema.appConnections.id, input.connectionId),
        eq(schema.appConnections.organizationId, input.organizationId),
        eq(schema.appConnections.environmentId, input.environmentId),
        eq(schema.appConnections.appKey, input.appKey),
        eq(schema.appConnections.status, "connected"),
        eq(schema.appCredentials.status, "active")
      )
    )
    .limit(1);
  const resolved = row[0];
  if (!resolved) {
    throw new AppServiceError(
      "APP_CONNECTION_NOT_FOUND",
      "Active App connection not found."
    );
  }
  const payload = decryptAppCredential({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    appKey: input.appKey,
    credentialId: resolved.credential.id,
    encrypted: resolved.credential.encryptedPayload,
  });
  await knowledgeDb
    .update(schema.appCredentials)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.appCredentials.id, resolved.credential.id));
  return payload;
}
