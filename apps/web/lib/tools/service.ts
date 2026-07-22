import { and, eq, sql } from "drizzle-orm";
import { getBotUserName } from "@/lib/bots/github-config";
import { getUnifiedBotRuntime } from "@/lib/bots/runtime";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getKnowledgeOcrMode } from "@/lib/knowledge/documents/ocr-config";
import { getActiveKnowledgeSnapshot } from "@/lib/knowledge/snapshot-store";
import { mapWithConcurrencyLimit } from "./concurrency";
import { buildToolsOverview } from "./overview";
import { getToolProviderDefinition, listToolProviders } from "./registry";
import type {
  ResolvedToolCapability,
  ResolvedToolProvider,
  ResolvedToolProviderConnection,
  ToolApprovalMode,
  ToolCapabilityKey,
  ToolCapabilityPolicy,
  ToolLoggingMode,
  ToolProviderAdapter,
  ToolProviderDefinition,
  ToolProviderKey,
  ToolRateLimitMode,
  ToolRuntimeConfiguration,
  ToolSurfaceAccess,
  ToolsOverview,
} from "./types";

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function toSurfaceAccess(value: unknown): ToolSurfaceAccess {
  const record = parseRecord(value);
  return {
    chat: record.chat !== false,
    admin: record.admin === true,
  };
}

function getOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function mergePolicy(
  definition: ToolProviderDefinition["capabilities"][number],
  row?: {
    enabled: boolean;
    approvalMode: ToolApprovalMode;
    surfaceAccess: unknown;
    rateLimitMode: ToolRateLimitMode;
    loggingMode: ToolLoggingMode;
    settings: unknown;
  } | null,
): ToolCapabilityPolicy {
  return {
    enabled: row?.enabled ?? definition.defaultPolicy.enabled,
    approvalMode: row?.approvalMode ?? definition.defaultPolicy.approvalMode,
    surfaceAccess: row
      ? toSurfaceAccess(row.surfaceAccess)
      : definition.defaultPolicy.surfaceAccess,
    rateLimitMode: row?.rateLimitMode ?? definition.defaultPolicy.rateLimitMode,
    loggingMode: row?.loggingMode ?? definition.defaultPolicy.loggingMode,
    settings: {
      ...definition.defaultPolicy.settings,
      ...parseRecord(row?.settings),
    },
  };
}

function createToolServiceError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function createSystemConnection(
  overrides: Partial<ResolvedToolProviderConnection> = {},
): ResolvedToolProviderConnection {
  return {
    authSource: "system",
    status: "connected",
    isReady: true,
    label: "System",
    lastError: null,
    metadata: {},
    ...overrides,
  };
}

function sqlExcluded(columnName: string) {
  return sql.raw(`excluded."${columnName}"`);
}

const builtInSystemAdapter: ToolProviderAdapter = {
  async getConnectionStatus() {
    return createSystemConnection();
  },
};

const artifactsAdapter: ToolProviderAdapter = {
  async getConnectionStatus() {
    return createSystemConnection();
  },
};

const knowledgeSearchAdapter: ToolProviderAdapter = {
  async getConnectionStatus({ organizationId }) {
    const documentRows = await knowledgeDb
      .select({
        status: schema.knowledgeDocuments.status,
      })
      .from(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.organizationId, organizationId));

    const readyCount = documentRows.filter(
      (row) => row.status === "ready" || row.status === "partial",
    ).length;
    const processingCount = documentRows.filter(
      (row) => row.status === "uploaded" || row.status === "processing",
    ).length;
    const failedCount = documentRows.filter(
      (row) => row.status === "failed",
    ).length;

    if (readyCount > 0) {
      return createSystemConnection({
        label: `${readyCount} document${readyCount === 1 ? "" : "s"} ready`,
        metadata: {
          manageUrl: "/knowledge",
          totalDocumentCount: documentRows.length,
          readyDocumentCount: readyCount,
          processingDocumentCount: processingCount,
          failedDocumentCount: failedCount,
          ocrMode: getKnowledgeOcrMode(),
        },
      });
    }

    return createSystemConnection({
      status: documentRows.length > 0 ? "degraded" : "not_configured",
      isReady: false,
      label: processingCount > 0 ? "Processing documents" : "Upload documents",
      lastError:
        failedCount > 0
          ? `${failedCount} document${failedCount === 1 ? "" : "s"} failed ingestion.`
          : null,
      metadata: {
        manageUrl: "/knowledge",
        totalDocumentCount: documentRows.length,
        readyDocumentCount: readyCount,
        processingDocumentCount: processingCount,
        failedDocumentCount: failedCount,
        ocrMode: getKnowledgeOcrMode(),
      },
    });
  },
};

const sandboxAdapter: ToolProviderAdapter = {
  async getConnectionStatus({ organizationId }) {
    const [sourceRows, activeSnapshot] = await Promise.all([
      knowledgeDb
        .select({ id: schema.sources.id })
        .from(schema.sources)
        .where(eq(schema.sources.organizationId, organizationId)),
      getActiveKnowledgeSnapshot(organizationId),
    ]);

    if (activeSnapshot) {
      return createSystemConnection({
        label: "Snapshot ready",
        metadata: {
          manageUrl: "/knowledge",
          sourceCount: sourceRows.length,
          activeSnapshotId: activeSnapshot.id,
        },
      });
    }

    return createSystemConnection({
      status: sourceRows.length > 0 ? "degraded" : "not_configured",
      isReady: false,
      label: sourceRows.length > 0 ? "Run source sync" : "Add sources",
      lastError:
        sourceRows.length > 0
          ? "No active knowledge snapshot is available."
          : null,
      metadata: {
        manageUrl: "/knowledge",
        sourceCount: sourceRows.length,
        activeSnapshotId: null,
      },
    });
  },
};

const githubAdapter: ToolProviderAdapter = {
  async getConnectionStatus({ organizationId, origin }) {
    const hasPat = Boolean(process.env.GITHUB_TOKEN);
    const hasApp = Boolean(
      process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY,
    );
    const hasWebhookSecret = Boolean(process.env.GITHUB_WEBHOOK_SECRET);
    const [sourceRows, activeSnapshot] = await Promise.all([
      knowledgeDb
        .select({ id: schema.sources.id })
        .from(schema.sources)
        .where(
          and(
            eq(schema.sources.organizationId, organizationId),
            eq(schema.sources.type, "github"),
          ),
        ),
      getActiveKnowledgeSnapshot(organizationId),
    ]);

    const configured = (hasPat || hasApp) && hasWebhookSecret;
    const adapterAvailable = getUnifiedBotRuntime().hasGitHubAdapter();
    const snapshotReady = Boolean(activeSnapshot);
    const status = configured
      ? adapterAvailable && snapshotReady
        ? "env_backed"
        : "degraded"
      : "not_configured";

    return {
      authSource: "env",
      status,
      isReady: configured && adapterAvailable && snapshotReady,
      label: configured
        ? adapterAvailable && snapshotReady
          ? "Env-backed"
          : "Action required"
        : "Missing credentials",
      lastError:
        configured && !snapshotReady
          ? "No active knowledge snapshot is available."
          : configured && !adapterAvailable
            ? "GitHub adapter is not initialized."
            : null,
      metadata: {
        configured,
        authMode: hasPat ? "pat" : hasApp ? "app" : null,
        hasWebhookSecret,
        botUserName: getBotUserName(),
        replyToNewIssues: process.env.GITHUB_REPLY_TO_NEW_ISSUES === "true",
        webhookUrl: origin ? `${origin}/api/webhooks/github` : null,
        sourceCount: sourceRows.length,
        activeSnapshotId: activeSnapshot?.id ?? null,
        snapshotReady,
        adapterAvailable,
        stateBackend: getUnifiedBotRuntime().getStateBackend(),
      },
    };
  },
};

const googleWorkspaceAdapter: ToolProviderAdapter = {
  async getConnectionStatus({ organizationId }) {
    const connections = await knowledgeDb.query.userToolConnections.findMany({
      where: (table, { and, eq, inArray }) =>
        and(
          eq(table.organizationId, organizationId),
          eq(table.providerKey, "google_workspace"),
          inArray(table.status, ["connected", "degraded"]),
        ),
      columns: { status: true },
    });
    const connectedCount = connections.filter(
      (connection) => connection.status === "connected",
    ).length;
    const degradedCount = connections.length - connectedCount;
    const configured = Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
    );
    return {
      authSource: "oauth",
      status:
        connectedCount > 0
          ? "connected"
          : degradedCount > 0
            ? "degraded"
            : "not_configured",
      isReady: configured && connectedCount > 0,
      label:
        connectedCount > 0
          ? `${connectedCount} connected account${connectedCount === 1 ? "" : "s"}`
          : degradedCount > 0
            ? "Reconnect required"
            : configured
              ? "Connect from a Project"
              : "Missing credentials",
      lastError:
        degradedCount > 0
          ? `${degradedCount} Google account${degradedCount === 1 ? "" : "s"} require reconnection.`
          : configured
            ? null
            : "Google OAuth credentials are not configured.",
      metadata: { configured, connectedCount, degradedCount },
    };
  },
};

const tavilyAdapter: ToolProviderAdapter = {
  async getConnectionStatus() {
    const configured = Boolean(process.env.TAVILY_API_KEY?.trim());
    return {
      authSource: "env",
      status: configured ? "env_backed" : "not_configured",
      isReady: configured,
      label: configured ? "Deployment managed" : "API key required",
      lastError: configured ? null : "No Tavily API key is configured.",
      metadata: {
        configured,
        connectionModel: "environment",
        deploymentManaged: configured,
        envVar: "TAVILY_API_KEY",
        projectId: process.env.TAVILY_PROJECT?.trim() || null,
      },
    };
  },
};

const environmentManagedAdapter: ToolProviderAdapter = {
  async getConnectionStatus() {
    return {
      authSource: "api_key",
      status: "not_configured",
      isReady: false,
      label: "Configure per Environment",
      lastError: null,
      metadata: { connectionModel: "environment" },
    };
  },
};

const providerAdapters = new Map<ToolProviderKey, ToolProviderAdapter>([
  ["ngrok", environmentManagedAdapter],
  ["built_in.weather", builtInSystemAdapter],
  ["built_in.time", builtInSystemAdapter],
  ["built_in.geocoding", builtInSystemAdapter],
  ["built_in.exchange_rates", builtInSystemAdapter],
  ["built_in.knowledge_search", knowledgeSearchAdapter],
  ["built_in.sandbox", sandboxAdapter],
  ["built_in.artifacts", artifactsAdapter],
  ["github", githubAdapter],
  ["google_workspace", googleWorkspaceAdapter],
  ["tavily", tavilyAdapter],
]);

async function ensureToolCatalogRows() {
  const providers = listToolProviders();
  const now = new Date();

  await knowledgeDb
    .insert(schema.toolProviders)
    .values(
      providers.map((provider) => ({
        key: provider.key,
        displayName: provider.displayName,
        description: provider.description,
        type: provider.type,
        authType: provider.authType,
        metadata: provider.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.toolProviders.key],
      set: {
        displayName: sqlExcluded("display_name"),
        description: sqlExcluded("description"),
        type: sqlExcluded("type"),
        authType: sqlExcluded("auth_type"),
        metadata: sqlExcluded("metadata"),
        updatedAt: now,
      },
    });

  const capabilities = providers.flatMap((provider) =>
    provider.capabilities.map((capability) => ({
      providerKey: provider.key,
      key: capability.key,
      runtimeName: capability.runtimeName,
      displayName: capability.displayName,
      description: capability.description,
      accessMode: capability.accessMode,
      defaultEnabled: capability.defaultPolicy.enabled,
      defaultApprovalMode: capability.defaultPolicy.approvalMode,
      defaultSurfaceAccess: capability.defaultPolicy.surfaceAccess,
      defaultRateLimitMode: capability.defaultPolicy.rateLimitMode,
      defaultLoggingMode: capability.defaultPolicy.loggingMode,
      defaultSettings: capability.defaultPolicy.settings,
      metadata: capability.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })),
  );

  if (capabilities.length === 0) {
    return;
  }

  await knowledgeDb
    .insert(schema.toolCapabilities)
    .values(capabilities)
    .onConflictDoUpdate({
      target: [
        schema.toolCapabilities.providerKey,
        schema.toolCapabilities.key,
      ],
      set: {
        runtimeName: sqlExcluded("runtime_name"),
        displayName: sqlExcluded("display_name"),
        description: sqlExcluded("description"),
        accessMode: sqlExcluded("access_mode"),
        defaultEnabled: sqlExcluded("default_enabled"),
        defaultApprovalMode: sqlExcluded("default_approval_mode"),
        defaultSurfaceAccess: sqlExcluded("default_surface_access"),
        defaultRateLimitMode: sqlExcluded("default_rate_limit_mode"),
        defaultLoggingMode: sqlExcluded("default_logging_mode"),
        defaultSettings: sqlExcluded("default_settings"),
        metadata: sqlExcluded("metadata"),
        updatedAt: now,
      },
    });
}

async function ensureOrganizationToolRows(organizationId: string) {
  await ensureToolCatalogRows();
  const providers = listToolProviders();

  await knowledgeDb
    .insert(schema.organizationToolProviders)
    .values(
      providers.map((provider) => ({
        organizationId,
        providerKey: provider.key,
        enabled: true,
        settings: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    )
    .onConflictDoNothing({
      target: [
        schema.organizationToolProviders.organizationId,
        schema.organizationToolProviders.providerKey,
      ],
    });

  await knowledgeDb
    .insert(schema.organizationToolCapabilities)
    .values(
      providers.flatMap((provider) =>
        provider.capabilities.map((capability) => ({
          organizationId,
          providerKey: provider.key,
          capabilityKey: capability.key,
          enabled: capability.defaultPolicy.enabled,
          approvalMode: capability.defaultPolicy.approvalMode,
          surfaceAccess: capability.defaultPolicy.surfaceAccess,
          rateLimitMode: capability.defaultPolicy.rateLimitMode,
          loggingMode: capability.defaultPolicy.loggingMode,
          settings: capability.defaultPolicy.settings,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      ),
    )
    .onConflictDoNothing({
      target: [
        schema.organizationToolCapabilities.organizationId,
        schema.organizationToolCapabilities.providerKey,
        schema.organizationToolCapabilities.capabilityKey,
      ],
    });
}

async function syncToolConnections(
  organizationId: string,
  origin?: string,
): Promise<Map<ToolProviderKey, ResolvedToolProviderConnection>> {
  const definitions = listToolProviders();
  const resolved = await mapWithConcurrencyLimit(
    definitions,
    4,
    async (provider) => {
      const adapter =
        providerAdapters.get(provider.key) ??
        ({
          async getConnectionStatus() {
            return {
              authSource: provider.authType,
              status: "not_configured" as const,
              isReady: false,
              label: "Not configured",
              lastError: null,
              metadata: {},
            };
          },
        } satisfies ToolProviderAdapter);
      const connection = await adapter.getConnectionStatus({
        organizationId,
        origin,
      });

      await knowledgeDb
        .insert(schema.organizationToolConnections)
        .values({
          organizationId,
          providerKey: provider.key,
          authSource: connection.authSource,
          status: connection.status,
          accountId: getOptionalString(connection.metadata, "accountId"),
          credentialRef: getOptionalString(
            connection.metadata,
            "credentialRef",
          ),
          metadata: connection.metadata,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.organizationToolConnections.organizationId,
            schema.organizationToolConnections.providerKey,
          ],
          set: {
            authSource: connection.authSource,
            status: connection.status,
            accountId: getOptionalString(connection.metadata, "accountId"),
            credentialRef: getOptionalString(
              connection.metadata,
              "credentialRef",
            ),
            metadata: connection.metadata,
            updatedAt: new Date(),
          },
        });

      return [provider.key, connection] as const;
    },
  );

  return new Map(resolved);
}

export async function listResolvedToolProviders(input: {
  organizationId: string;
  origin?: string;
}) {
  await ensureOrganizationToolRows(input.organizationId);

  const [providerRows, capabilityRows, connections] = await Promise.all([
    knowledgeDb.query.organizationToolProviders.findMany({
      where: (table, { eq }) => eq(table.organizationId, input.organizationId),
    }),
    knowledgeDb.query.organizationToolCapabilities.findMany({
      where: (table, { eq }) => eq(table.organizationId, input.organizationId),
    }),
    syncToolConnections(input.organizationId, input.origin),
  ]);

  const providerRowMap = new Map(
    providerRows.map((row) => [row.providerKey as ToolProviderKey, row]),
  );
  const capabilityRowMap = new Map(
    capabilityRows.map((row) => [
      `${row.providerKey}:${row.capabilityKey}`,
      row,
    ]),
  );

  return listToolProviders().map((definition): ResolvedToolProvider => {
    const providerRow = providerRowMap.get(definition.key);
    const connection = connections.get(definition.key) ?? {
      authSource: definition.authType,
      status: "not_configured",
      isReady: false,
      label: "Not configured",
      lastError: null,
      metadata: {},
    };

    const enabled = providerRow?.enabled ?? true;
    const capabilities: ResolvedToolCapability[] = definition.capabilities.map(
      (capability) => {
        const row = capabilityRowMap.get(`${definition.key}:${capability.key}`);
        const policy = mergePolicy(capability, row);
        return {
          ...capability,
          policy,
          isAvailable:
            enabled &&
            policy.enabled &&
            policy.approvalMode !== "deny" &&
            Boolean(capability.runtimeName || definition.type !== "built_in") &&
            connection.isReady,
        };
      },
    );

    return {
      key: definition.key,
      displayName: definition.displayName,
      description: definition.description,
      type: definition.type,
      authType: definition.authType,
      enabled,
      settings: {
        ...parseRecord(providerRow?.settings),
      },
      connection,
      capabilities,
      counts: {
        total: capabilities.length,
        enabled: capabilities.filter((capability) => capability.policy.enabled)
          .length,
        available: capabilities.filter((capability) => capability.isAvailable)
          .length,
      },
    };
  });
}

export async function getResolvedToolProvider(input: {
  organizationId: string;
  providerKey: ToolProviderKey;
  origin?: string;
}) {
  const providers = await listResolvedToolProviders({
    organizationId: input.organizationId,
    origin: input.origin,
  });

  return (
    providers.find((provider) => provider.key === input.providerKey) ?? null
  );
}

export async function getToolsOverview(input: {
  organizationId: string;
  origin?: string;
}): Promise<ToolsOverview> {
  const providers = await listResolvedToolProviders(input);
  return buildToolsOverview(providers);
}

export async function updateOrganizationToolProvider(input: {
  organizationId: string;
  providerKey: ToolProviderKey;
  enabled?: boolean;
  settings?: Record<string, unknown>;
}) {
  const provider = getToolProviderDefinition(input.providerKey);
  if (!provider) {
    throw createToolServiceError(
      "TOOL_PROVIDER_NOT_FOUND",
      "Tool provider not found",
    );
  }

  await ensureOrganizationToolRows(input.organizationId);

  const existing = await knowledgeDb.query.organizationToolProviders.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.providerKey, input.providerKey),
      ),
  });

  await knowledgeDb
    .insert(schema.organizationToolProviders)
    .values({
      organizationId: input.organizationId,
      providerKey: input.providerKey,
      enabled: input.enabled ?? existing?.enabled ?? true,
      settings: input.settings ?? parseRecord(existing?.settings),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationToolProviders.organizationId,
        schema.organizationToolProviders.providerKey,
      ],
      set: {
        enabled: input.enabled ?? existing?.enabled ?? true,
        settings: input.settings ?? parseRecord(existing?.settings),
        updatedAt: new Date(),
      },
    });
}

export async function updateOrganizationToolCapability(input: {
  organizationId: string;
  providerKey: ToolProviderKey;
  capabilityKey: ToolCapabilityKey;
  patch: Partial<ToolCapabilityPolicy>;
}) {
  const capability = getToolProviderDefinition(
    input.providerKey,
  )?.capabilities.find((entry) => entry.key === input.capabilityKey);
  if (!capability) {
    throw createToolServiceError(
      "TOOL_CAPABILITY_NOT_FOUND",
      "Tool capability not found",
    );
  }

  await ensureOrganizationToolRows(input.organizationId);

  const existing =
    await knowledgeDb.query.organizationToolCapabilities.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerKey, input.providerKey),
          eq(table.capabilityKey, input.capabilityKey),
        ),
    });

  const policy = mergePolicy(capability, existing);
  const nextPolicy: ToolCapabilityPolicy = {
    ...policy,
    ...input.patch,
    surfaceAccess: input.patch.surfaceAccess ?? policy.surfaceAccess,
    settings: input.patch.settings
      ? { ...policy.settings, ...input.patch.settings }
      : policy.settings,
  };

  await knowledgeDb
    .insert(schema.organizationToolCapabilities)
    .values({
      organizationId: input.organizationId,
      providerKey: input.providerKey,
      capabilityKey: input.capabilityKey,
      enabled: nextPolicy.enabled,
      approvalMode: nextPolicy.approvalMode,
      surfaceAccess: nextPolicy.surfaceAccess,
      rateLimitMode: nextPolicy.rateLimitMode,
      loggingMode: nextPolicy.loggingMode,
      settings: nextPolicy.settings,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationToolCapabilities.organizationId,
        schema.organizationToolCapabilities.providerKey,
        schema.organizationToolCapabilities.capabilityKey,
      ],
      set: {
        enabled: nextPolicy.enabled,
        approvalMode: nextPolicy.approvalMode,
        surfaceAccess: nextPolicy.surfaceAccess,
        rateLimitMode: nextPolicy.rateLimitMode,
        loggingMode: nextPolicy.loggingMode,
        settings: nextPolicy.settings,
        updatedAt: new Date(),
      },
    });
}

export async function testToolProviderConnection(input: {
  organizationId: string;
  providerKey: ToolProviderKey;
  origin?: string;
}) {
  const provider = await getResolvedToolProvider(input);
  if (!provider) {
    throw createToolServiceError(
      "TOOL_PROVIDER_NOT_FOUND",
      "Tool provider not found",
    );
  }

  return {
    testedAt: new Date().toISOString(),
    connection: provider.connection,
  };
}

export async function listEnabledToolRuntimeNames(input: {
  organizationId: string;
  surface: keyof ToolSurfaceAccess;
  origin?: string;
}) {
  const runtimeConfigurations = await listToolRuntimeConfigurations(input);
  return Object.keys(runtimeConfigurations);
}

export async function listToolRuntimeConfigurations(input: {
  organizationId: string;
  surface: keyof ToolSurfaceAccess;
  origin?: string;
}) {
  const providers = await listResolvedToolProviders({
    organizationId: input.organizationId,
    origin: input.origin,
  });

  return Object.fromEntries(
    providers.flatMap((provider) =>
      provider.enabled
        ? provider.capabilities
            .filter(
              (capability) =>
                capability.runtimeName &&
                capability.policy.enabled &&
                capability.policy.approvalMode !== "deny" &&
                capability.policy.surfaceAccess[input.surface] &&
                provider.connection.isReady,
            )
            .map((capability) => [
              capability.runtimeName as string,
              {
                providerKey: provider.key,
                capabilityKey: capability.key,
                runtimeName: capability.runtimeName as string,
                approvalMode: capability.policy.approvalMode,
                rateLimitMode: capability.policy.rateLimitMode,
                loggingMode: capability.policy.loggingMode,
                settings: capability.policy.settings,
              } satisfies ToolRuntimeConfiguration,
            ])
        : [],
    ),
  );
}

export async function filterRuntimeTools(input: {
  organizationId: string;
  surface: keyof ToolSurfaceAccess;
  tools: Record<string, unknown>;
  origin?: string;
}) {
  const enabledRuntimeNames = new Set(
    Object.keys(
      await listToolRuntimeConfigurations({
        organizationId: input.organizationId,
        surface: input.surface,
        origin: input.origin,
      }),
    ),
  );

  return Object.fromEntries(
    Object.entries(input.tools).filter(([name]) =>
      enabledRuntimeNames.has(name),
    ),
  );
}
