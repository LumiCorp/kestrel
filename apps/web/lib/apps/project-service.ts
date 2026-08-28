import { and, eq, inArray, sql } from "drizzle-orm";
import { defaultToolCatalog } from "../../../../tools/catalog";
import { getProjectEnvironmentBinding } from "@/lib/environments/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  microsoft365PackAllowsCapability,
  hasMicrosoft365CapabilityScopes,
  parseMicrosoft365Packs,
} from "@/lib/integrations/microsoft-365-contract";
import {
  hasGoogleCalendarCapabilityScopes,
  parseSelectedGoogleWorkspacePacks,
} from "@/lib/integrations/google-calendar-contract";
import { hasGmailCapabilityScopes } from "@/lib/integrations/gmail-contract";
import type {
  ToolApprovalMode,
  ToolLoggingMode,
  ToolRateLimitMode,
} from "@/lib/tools/types";
import { getCoreAppDefinition } from "./catalog";
import {
  applyMinimumApprovalMode,
  intersectAppApprovalModes,
  isProjectApprovalWithinEnvironment,
} from "./policy";
import { ensureCoreAppCatalog, ensureEnvironmentAppPolicies } from "./service";
import type { AppConnectionSummary } from "./types";
import type { AppConnectionModel, AppConnectionRequirement } from "./types";
import {
  githubCapabilityHasReadyResource,
  listAuthorizedGitHubResources,
} from "@/lib/integrations/github-resource-access";
import type { GitHubCapability } from "@/lib/integrations/github-policy-contract";
import { classifyWorkflowCapability, type WorkflowCapabilityUse } from "@/lib/workflows/capabilities";

export type ProjectAppConnection = AppConnectionSummary & {
  scope: "shared" | "personal";
  isDefault: boolean;
};

export type ProjectAppCapability = {
  key: string;
  runtimeName: string | null;
  displayName: string;
  description: string;
  groupKey: string;
  enabled: boolean;
  approvalMode: ToolApprovalMode;
  environmentEnabled: boolean;
  environmentApprovalMode: ToolApprovalMode;
  projectApprovalMode: ToolApprovalMode;
  minimumApprovalMode: Exclude<ToolApprovalMode, "deny">;
  loggingMode: ToolLoggingMode;
  rateLimitMode: ToolRateLimitMode;
  inherited: boolean;
  resourceReady: boolean;
  inputSchema: Record<string, unknown>;
  accessMode: import("@/lib/tools/types").ToolAccessMode;
  workflowUse: WorkflowCapabilityUse;
  descriptorContractRevision: string | null;
};

function capabilityInputSchema(capability: {
  runtimeName: string | null;
  metadata: Record<string, unknown> | null;
}): Record<string, unknown> {
  const descriptor = capability.runtimeName
    ? defaultToolCatalog.getDescriptor(capability.runtimeName)
    : undefined;
  if (descriptor) return descriptor.inputSchema;
  const candidate = capability.metadata?.inputSchema;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : { type: "object", properties: {}, additionalProperties: false };
}

function capabilityDescriptorContractRevision(capability: {
  runtimeName: string | null;
  metadata: Record<string, unknown> | null;
}) {
  const descriptor = capability.runtimeName
    ? defaultToolCatalog.getDescriptor(capability.runtimeName)
    : undefined;
  if (descriptor) return descriptor.contractRevision;
  const candidate = capability.metadata?.descriptorContractRevision ?? capability.metadata?.definitionDigest;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export type ProjectAppConfiguration = {
  projectId: string;
  environmentId: string;
  app: {
    key: string;
    displayName: string;
    description: string;
    icon: string | null;
    connectionModel: AppConnectionModel;
    connectionRequirement: AppConnectionRequirement;
    authMethods: import("./types").AppAuthMethod[];
  };
  enabled: boolean;
  availableConnections: AppConnectionSummary[];
  attachedConnections: ProjectAppConnection[];
  capabilities: ProjectAppCapability[];
  dependencies: ProjectAppDependencyStatus[];
  dependencyReady: boolean;
};

export type ProjectAppDependencyStatus = {
  role: string;
  minimum: number;
  satisfied: boolean;
  alternatives: Array<{ appKey: string; displayName: string; ready: boolean }>;
};

export class ProjectAppError extends Error {
  readonly code:
    | "APP_NOT_FOUND"
    | "APP_NOT_INSTALLED"
    | "APP_CONNECTION_NOT_FOUND"
    | "APP_CONNECTION_SCOPE_INVALID"
    | "APP_CAPABILITY_NOT_AVAILABLE"
    | "APP_POLICY_WIDENS_ENVIRONMENT"
    | "PROJECT_NOT_FOUND";

  constructor(code: ProjectAppError["code"], message: string) {
    super(message);
    this.name = "ProjectAppError";
    this.code = code;
  }
}

export function addProjectAppDependencyStatuses(
  configurations: ProjectAppConfiguration[],
) {
  return configurations.map((configuration) => ({ ...configuration, dependencies: [], dependencyReady: true }));
}

function toConnectionSummary(
  row: typeof schema.appConnections.$inferSelect,
  userId: string,
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

async function requireProjectAppContext(input: {
  organizationId: string;
  projectId: string;
  appKey: string;
}) {
  await ensureCoreAppCatalog();
  const [binding, definition, installation] = await Promise.all([
    getProjectEnvironmentBinding({
      organizationId: input.organizationId,
      projectId: input.projectId,
    }),
    knowledgeDb.query.appDefinitions.findFirst({
      where: (table, { eq: equals }) => equals(table.key, input.appKey),
    }),
    knowledgeDb.query.appInstallations.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.appKey, input.appKey),
        ),
    }),
  ]);
  if (!binding) {
    throw new ProjectAppError("PROJECT_NOT_FOUND", "Project not found.");
  }
  await ensureEnvironmentAppPolicies({
    organizationId: input.organizationId,
    environmentId: binding.environmentId,
  });
  if (!definition) {
    throw new ProjectAppError("APP_NOT_FOUND", "App not found.");
  }
  if (
    definition.installMode !== "inherited" &&
    installation?.status !== "installed"
  ) {
    throw new ProjectAppError(
      "APP_NOT_INSTALLED",
      "Install this App before adding it to a Project.",
    );
  }
  return { binding, definition };
}

export async function listProjectAppConfigurations(input: {
  organizationId: string;
  projectId: string;
  userId: string;
}) {
  await ensureCoreAppCatalog();
  const binding = await getProjectEnvironmentBinding({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!binding) {
    throw new ProjectAppError("PROJECT_NOT_FOUND", "Project not found.");
  }
  await ensureEnvironmentAppPolicies({
    organizationId: input.organizationId,
    environmentId: binding.environmentId,
  });
  const [
    definitions,
    installations,
    projectApps,
    capabilities,
    grants,
    policies,
  ] = await Promise.all([
    knowledgeDb.query.appDefinitions.findMany({
      where: (table, { eq: equals }) => equals(table.published, true),
      orderBy: (table, { asc }) => [asc(table.displayName)],
    }),
    knowledgeDb.query.appInstallations.findMany({
      where: (table, { eq: equals }) =>
        equals(table.organizationId, input.organizationId),
    }),
    knowledgeDb.query.projectApps.findMany({
      where: (table, { eq: equals }) =>
        equals(table.projectId, input.projectId),
    }),
    knowledgeDb.query.appCapabilities.findMany(),
    knowledgeDb.query.environmentAppCapabilityGrants.findMany({
      where: (table, { eq: equals }) =>
        equals(table.environmentId, binding.environmentId),
    }),
    knowledgeDb.query.projectAppCapabilityPolicies.findMany({
      where: (table, { eq: equals }) =>
        equals(table.projectId, input.projectId),
    }),
  ]);
  const installationByApp = new Map(
    installations.map((installation) => [installation.appKey, installation]),
  );
  const installedDefinitions = definitions.filter(
    (definition) =>
      definition.installMode === "inherited" ||
      installationByApp.get(definition.key)?.status === "installed",
  );
  if (!installedDefinitions.length) return [];
  const appKeys = installedDefinitions.map((definition) => definition.key);
  const [connectionRows, attachmentRows] = await Promise.all([
    knowledgeDb.query.appConnections.findMany({
      where: and(
        eq(schema.appConnections.organizationId, input.organizationId),
        inArray(schema.appConnections.appKey, appKeys),
      ),
      orderBy: (table, { asc }) => [asc(table.name)],
    }),
    knowledgeDb.query.projectAppConnections.findMany({
      where: (table, { and: all, eq: equals, inArray: among }) =>
        all(
          equals(table.projectId, input.projectId),
          among(table.appKey, appKeys),
        ),
    }),
  ]);
  const connectionById = new Map(
    connectionRows.map((connection) => [connection.id, connection]),
  );
  const projectAppByKey = new Map(projectApps.map((app) => [app.appKey, app]));
  const grantByCapability = new Map(
    grants.map((grant) => [`${grant.appKey}:${grant.capabilityKey}`, grant]),
  );
  const policyByCapability = new Map(
    policies.map((policy) => [
      `${policy.appKey}:${policy.capabilityKey}`,
      policy,
    ]),
  );

  const configurations = installedDefinitions.map<ProjectAppConfiguration>(
    (definition) => {
      const available = connectionRows.filter(
        (connection) =>
          connection.appKey === definition.key &&
          (connection.status === "connected" ||
            (definition.delivery === "lifecycle" &&
              connection.status === "degraded")) &&
          ((definition.connectionModel === "organization" &&
            connection.ownerType === "organization") ||
            ((definition.connectionModel === "environment" ||
              definition.connectionModel === "hybrid") &&
              connection.environmentId === binding.environmentId &&
              (connection.ownerType === "environment" ||
                connection.ownerType === "deployment_managed")) ||
            ((definition.connectionModel === "personal" ||
              definition.connectionModel === "hybrid") &&
              connection.ownerType === "personal" &&
              connection.userId === input.userId)),
      );
      const attached = attachmentRows.flatMap((attachment) => {
        if (attachment.appKey !== definition.key) return [];
        if (
          attachment.scope === "personal" &&
          attachment.userId !== input.userId
        ) {
          return [];
        }
        const connection = connectionById.get(attachment.connectionId);
        if (!connection) return [];
        return [
          {
            ...toConnectionSummary(connection, input.userId),
            scope: attachment.scope,
            isDefault: attachment.isDefault,
          },
        ];
      });
      const selectedConnection = selectEffectiveConnection({
        connectionModel: definition.connectionModel,
        connections: attached,
      });
      return {
        projectId: input.projectId,
        environmentId: binding.environmentId,
        app: {
          key: definition.key,
          displayName: definition.displayName,
          description: definition.description,
          icon: definition.icon,
          connectionModel: definition.connectionModel,
          connectionRequirement: definition.connectionRequirement,
          authMethods: Array.isArray(definition.metadata?.authMethods)
            ? (definition.metadata
                .authMethods as import("./types").AppAuthMethod[])
            : [],
        },
        enabled:
          projectAppByKey.get(definition.key)?.enabled ??
          definition.installMode === "inherited",
        availableConnections: available.map((connection) =>
          toConnectionSummary(connection, input.userId),
        ),
        attachedConnections: attached,
        capabilities: capabilities
          .filter(
            (capability) =>
              capability.appKey === definition.key &&
              capability.active &&
              (capability.connectionId === null ||
                capability.connectionId === selectedConnection?.id),
          )
          .map((capability) => {
            const grant = grantByCapability.get(
              `${definition.key}:${capability.key}`,
            );
            const policy = policyByCapability.get(
              `${definition.key}:${capability.key}`,
            );
            const minimumApprovalMode =
              getCoreAppDefinition(definition.key)?.capabilities.find(
                (candidate) => candidate.key === capability.key,
              )?.minimumApprovalMode ?? "auto";
            const environmentEnabled = Boolean(
              grant?.enabled && grant.approvalMode !== "deny",
            );
            const environmentApprovalMode = grant?.approvalMode ?? "deny";
            const enabled = Boolean(
              environmentEnabled &&
              (policy
                ? policy.enabled && policy.approvalMode !== "deny"
                : true),
            );
            return {
              key: capability.key,
              runtimeName: capability.runtimeName,
              displayName: capability.displayName,
              description: capability.description,
              groupKey: capability.groupKey,
              enabled,
              approvalMode: enabled
                ? applyMinimumApprovalMode({
                    requested: intersectAppApprovalModes(
                      environmentApprovalMode,
                      policy?.approvalMode ?? environmentApprovalMode,
                    ),
                    minimum: minimumApprovalMode,
                  })
                : "deny",
              environmentEnabled,
              environmentApprovalMode,
              projectApprovalMode:
                policy?.approvalMode ?? environmentApprovalMode,
              minimumApprovalMode,
              loggingMode: grant?.loggingMode ?? "metadata_only",
              rateLimitMode: grant?.rateLimitMode ?? "strict",
              inherited: !policy,
              resourceReady: true,
              inputSchema: capabilityInputSchema(capability),
              accessMode: capability.accessMode,
              workflowUse: classifyWorkflowCapability(capability),
              descriptorContractRevision: capabilityDescriptorContractRevision(capability),
            };
          }),
        dependencies: [],
        dependencyReady: true,
      };
    },
  );
  const withDependencies = addProjectAppDependencyStatuses(configurations);
  const github = withDependencies.find(
    (configuration) => configuration.app.key === "github",
  );
  const githubConnection = github
    ? selectEffectiveConnection({
        connectionModel: github.app.connectionModel,
        connections: github.attachedConnections,
      })
    : null;
  if (!(github && githubConnection)) return withDependencies;
  const resources = await listAuthorizedGitHubResources({
    projectId: input.projectId,
    connectionId: githubConnection.id,
  });
  return withDependencies.map((configuration) =>
    configuration.app.key !== "github"
      ? configuration
      : {
          ...configuration,
          dependencyReady: configuration.capabilities.some((capability) =>
            githubCapabilityHasReadyResource(
              capability.key as GitHubCapability,
              resources,
            ),
          ),
          capabilities: configuration.capabilities.map((capability) => ({
            ...capability,
            resourceReady: githubCapabilityHasReadyResource(
              capability.key as GitHubCapability,
              resources,
            ),
          })),
        },
  );
}

export async function resolveEffectiveProjectAppsAccess(input: {
  organizationId: string;
  projectId: string;
  userId: string;
}) {
  const configurations = await listProjectAppConfigurations(input);
  return configurations.flatMap((configuration) => {
    if (!configuration.enabled) return [];
    const selectedConnection = selectEffectiveConnection({
      connectionModel: configuration.app.connectionModel,
      connections: configuration.attachedConnections,
    });
    if (
      configuration.app.connectionRequirement === "required" &&
      !selectedConnection
    ) {
      return [];
    }
    const capabilities = configuration.capabilities.flatMap((capability) =>
      capability.enabled && capability.resourceReady && capability.runtimeName
        ? [
            {
              key: capability.key,
              runtimeName: capability.runtimeName,
              approvalMode: capability.approvalMode,
              environmentApprovalMode: capability.environmentApprovalMode,
              projectApprovalMode: capability.projectApprovalMode,
              minimumApprovalMode: capability.minimumApprovalMode,
              loggingMode: capability.loggingMode,
              rateLimitMode: capability.rateLimitMode,
              settings: {},
              inputSchema: capability.inputSchema,
              accessMode: capability.accessMode,
              workflowUse: capability.workflowUse,
              descriptorContractRevision: capability.descriptorContractRevision,
            },
          ]
        : [],
    );
    return capabilities.length
      ? [
          {
            appKey: configuration.app.key,
            projectId: input.projectId,
            environmentId: configuration.environmentId,
            connectionId: selectedConnection?.id ?? null,
            capabilities,
          },
        ]
      : [];
  });
}

export async function setProjectAppEnabled(input: {
  organizationId: string;
  projectId: string;
  appKey: string;
  actorUserId: string;
  enabled: boolean;
}) {
  const { binding } = await requireProjectAppContext(input);
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const [projectApp] = await transaction
      .insert(schema.projectApps)
      .values({
        projectId: input.projectId,
        appKey: input.appKey,
        enabled: input.enabled,
        addedByUserId: input.actorUserId,
        settings: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.projectApps.projectId, schema.projectApps.appKey],
        set: {
          enabled: input.enabled,
          addedByUserId: input.actorUserId,
          updatedAt: now,
        },
      })
      .returning();
    if (!projectApp) throw new Error("Project App could not be updated.");
    if (input.enabled) {
      const grants =
        await transaction.query.environmentAppCapabilityGrants.findMany({
          where: (table, { and: all, eq: equals }) =>
            all(
              equals(table.environmentId, binding.environmentId),
              equals(table.appKey, input.appKey),
            ),
        });
      for (const grant of grants) {
        await transaction
          .insert(schema.projectAppCapabilityPolicies)
          .values({
            projectId: input.projectId,
            appKey: input.appKey,
            capabilityKey: grant.capabilityKey,
            enabled: grant.enabled,
            approvalMode: grant.approvalMode,
            loggingMode: grant.loggingMode,
            rateLimitMode: grant.rateLimitMode,
            settings: grant.settings,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
      }
    }
    return projectApp;
  });
}

export async function attachProjectAppConnection(input: {
  organizationId: string;
  projectId: string;
  appKey: string;
  connectionId: string;
  actorUserId: string;
  scope: "shared" | "personal";
  isDefault: boolean;
}) {
  const { binding, definition } = await requireProjectAppContext(input);
  const connection = await knowledgeDb.query.appConnections.findFirst({
    where: (table, { and: all, eq: equals, inArray: among }) =>
      all(
        equals(table.id, input.connectionId),
        equals(table.organizationId, input.organizationId),
        equals(table.appKey, input.appKey),
        among(
          table.status,
          definition.delivery === "lifecycle"
            ? ["connected", "degraded"]
            : ["connected"],
        ),
      ),
  });
  if (!connection) {
    throw new ProjectAppError(
      "APP_CONNECTION_NOT_FOUND",
      "Available App connection not found.",
    );
  }
  const validShared =
    input.scope === "shared" &&
    ((definition.connectionModel === "organization" &&
      connection.ownerType === "organization") ||
      ((definition.connectionModel === "environment" ||
        definition.connectionModel === "hybrid") &&
        connection.environmentId === binding.environmentId &&
        (connection.ownerType === "environment" ||
          connection.ownerType === "deployment_managed")));
  const validPersonal =
    input.scope === "personal" &&
    (definition.connectionModel === "personal" ||
      definition.connectionModel === "hybrid") &&
    connection.ownerType === "personal" &&
    connection.userId === input.actorUserId;
  if (!(validShared || validPersonal)) {
    throw new ProjectAppError(
      "APP_CONNECTION_SCOPE_INVALID",
      "This connection cannot be attached at the requested Project scope.",
    );
  }
  const now = new Date();
  const lockKey = `project-app-default:${input.projectId}:${input.appKey}:${input.scope}:${validPersonal ? input.actorUserId : "shared"}`;
  const connectionLockKey = `personal-app-connection:${connection.id}`;
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionLockKey}, 0))`,
    );
    const lockedConnection = await transaction.query.appConnections.findFirst({
      where: (table, { and: all, eq: equals, inArray: among }) =>
        all(
          equals(table.id, connection.id),
          equals(table.organizationId, input.organizationId),
          equals(table.appKey, input.appKey),
          among(
            table.status,
            definition.delivery === "lifecycle"
              ? ["connected", "degraded"]
              : ["connected"],
          ),
        ),
    });
    if (!lockedConnection) {
      throw new ProjectAppError(
        "APP_CONNECTION_NOT_FOUND",
        "Available App connection not found.",
      );
    }
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    await transaction
      .insert(schema.projectApps)
      .values({
        projectId: input.projectId,
        appKey: input.appKey,
        enabled: true,
        addedByUserId: input.actorUserId,
        settings: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.projectApps.projectId, schema.projectApps.appKey],
        set: { enabled: true, updatedAt: now },
      });
    if (input.isDefault) {
      await transaction
        .update(schema.projectAppConnections)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(schema.projectAppConnections.projectId, input.projectId),
            eq(schema.projectAppConnections.appKey, input.appKey),
            eq(schema.projectAppConnections.scope, input.scope),
            input.scope === "personal"
              ? eq(schema.projectAppConnections.userId, input.actorUserId)
              : sql`${schema.projectAppConnections.userId} is null`,
          ),
        );
    }
    const [attachment] = await transaction
      .insert(schema.projectAppConnections)
      .values({
        projectId: input.projectId,
        appKey: input.appKey,
        connectionId: input.connectionId,
        scope: input.scope,
        userId: validPersonal ? input.actorUserId : null,
        isDefault: input.isDefault,
        addedByUserId: input.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.projectAppConnections.projectId,
          schema.projectAppConnections.appKey,
          schema.projectAppConnections.connectionId,
        ],
        set: {
          scope: input.scope,
          userId: validPersonal ? input.actorUserId : null,
          isDefault: input.isDefault,
          addedByUserId: input.actorUserId,
          updatedAt: now,
        },
      })
      .returning();
    if (!attachment)
      throw new Error("Project App connection could not be attached.");
    return attachment;
  });
}

export async function detachProjectAppConnection(input: {
  organizationId: string;
  projectId: string;
  appKey: string;
  connectionId: string;
  actorUserId: string;
  canManageShared: boolean;
}) {
  await requireProjectAppContext(input);
  const attachment = await knowledgeDb.query.projectAppConnections.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.projectId, input.projectId),
        equals(table.appKey, input.appKey),
        equals(table.connectionId, input.connectionId),
      ),
  });
  if (!attachment) {
    throw new ProjectAppError(
      "APP_CONNECTION_NOT_FOUND",
      "Project App connection not found.",
    );
  }
  if (
    (attachment.scope === "shared" && !input.canManageShared) ||
    (attachment.scope === "personal" && attachment.userId !== input.actorUserId)
  ) {
    throw new ProjectAppError(
      "APP_CONNECTION_SCOPE_INVALID",
      "You cannot remove this Project connection.",
    );
  }
  await knowledgeDb
    .delete(schema.projectAppConnections)
    .where(
      and(
        eq(schema.projectAppConnections.projectId, input.projectId),
        eq(schema.projectAppConnections.appKey, input.appKey),
        eq(schema.projectAppConnections.connectionId, input.connectionId),
      ),
    );
}

export async function saveProjectAppCapabilityPolicy(input: {
  organizationId: string;
  projectId: string;
  appKey: string;
  capabilityKey: string;
  actorUserId: string;
  enabled: boolean;
  approvalMode: ToolApprovalMode;
}) {
  const { binding } = await requireProjectAppContext(input);
  const grant =
    await knowledgeDb.query.environmentAppCapabilityGrants.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.environmentId, binding.environmentId),
          equals(table.appKey, input.appKey),
          equals(table.capabilityKey, input.capabilityKey),
        ),
    });
  if (!grant) {
    throw new ProjectAppError(
      "APP_CAPABILITY_NOT_AVAILABLE",
      "This capability is not available in the Project Environment.",
    );
  }
  const capability = await knowledgeDb.query.appCapabilities.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.appKey, input.appKey),
        equals(table.key, input.capabilityKey),
      ),
    columns: { connectionId: true, active: true },
  });
  if (!capability?.active) {
    throw new ProjectAppError(
      "APP_CAPABILITY_NOT_AVAILABLE",
      "This capability is not available in the Project Environment.",
    );
  }
  if (capability.connectionId) {
    const configurations = await listProjectAppConfigurations({
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.actorUserId,
    });
    const configuration = configurations.find(
      (candidate) => candidate.app.key === input.appKey,
    );
    const selectedConnection = configuration
      ? selectEffectiveConnection({
          connectionModel: configuration.app.connectionModel,
          connections: configuration.attachedConnections,
        })
      : null;
    if (selectedConnection?.id !== capability.connectionId) {
      throw new ProjectAppError(
        "APP_CAPABILITY_NOT_AVAILABLE",
        "This capability does not belong to the selected Project connection.",
      );
    }
  }
  const minimumApprovalMode =
    getCoreAppDefinition(input.appKey)?.capabilities.find(
      (candidate) => candidate.key === input.capabilityKey,
    )?.minimumApprovalMode ?? "auto";
  const approvalMode = applyMinimumApprovalMode({
    requested: input.approvalMode,
    minimum: minimumApprovalMode,
    enabled: input.enabled,
  });
  if (
    input.enabled &&
    (!grant.enabled ||
      grant.approvalMode === "deny" ||
      !isProjectApprovalWithinEnvironment({
        environment: grant.approvalMode,
        project: approvalMode,
      }))
  ) {
    throw new ProjectAppError(
      "APP_POLICY_WIDENS_ENVIRONMENT",
      "Project access cannot broaden the Environment ceiling.",
    );
  }
  const now = new Date();
  const policy = await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .insert(schema.projectApps)
      .values({
        projectId: input.projectId,
        appKey: input.appKey,
        enabled: true,
        addedByUserId: input.actorUserId,
        settings: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const [saved] = await transaction
      .insert(schema.projectAppCapabilityPolicies)
      .values({
        projectId: input.projectId,
        appKey: input.appKey,
        capabilityKey: input.capabilityKey,
        enabled: input.enabled,
        approvalMode,
        loggingMode: grant.loggingMode,
        rateLimitMode: grant.rateLimitMode,
        settings: grant.settings,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.projectAppCapabilityPolicies.projectId,
          schema.projectAppCapabilityPolicies.appKey,
          schema.projectAppCapabilityPolicies.capabilityKey,
        ],
        set: { enabled: input.enabled, approvalMode, updatedAt: now },
      })
      .returning();
    return saved;
  });
  if (!policy) throw new Error("Project App capability could not be saved.");
  return policy;
}

export async function resolveEffectiveProjectAppAccess(input: {
  organizationId: string;
  projectId: string;
  appKey: string;
  userId: string;
  includePolicyOnly?: boolean | undefined;
  skipResourceReadiness?: boolean | undefined;
  skipInitialization?: boolean | undefined;
}, executor: typeof knowledgeDb = knowledgeDb) {
  const db = executor;
  let context: Awaited<ReturnType<typeof requireProjectAppContext>>;
  try {
    if (input.skipInitialization) {
      const [binding, definition, installation] = await Promise.all([
        db.query.projects.findFirst({
          where: (table, { and: all, eq: equals }) =>
            all(
              equals(table.id, input.projectId),
              equals(table.organizationId, input.organizationId),
            ),
          columns: {
            id: true,
            organizationId: true,
            environmentId: true,
            updatedAt: true,
          },
        }),
        db.query.appDefinitions.findFirst({
          where: (table, { eq: equals }) => equals(table.key, input.appKey),
        }),
        db.query.appInstallations.findFirst({
          where: (table, { and: all, eq: equals }) =>
            all(
              equals(table.organizationId, input.organizationId),
              equals(table.appKey, input.appKey),
            ),
        }),
      ]);
      if (!binding) {
        throw new ProjectAppError("PROJECT_NOT_FOUND", "Project not found.");
      }
      if (!definition) {
        throw new ProjectAppError("APP_NOT_FOUND", "App not found.");
      }
      if (
        definition.installMode !== "inherited" &&
        installation?.status !== "installed"
      ) {
        throw new ProjectAppError(
          "APP_NOT_INSTALLED",
          "Install this App before adding it to a Project.",
        );
      }
      context = { binding, definition };
    } else {
      context = await requireProjectAppContext(input);
    }
  } catch (error) {
    if (
      error instanceof ProjectAppError &&
      (error.code === "APP_NOT_FOUND" || error.code === "APP_NOT_INSTALLED")
    ) {
      return null;
    }
    throw error;
  }
  const { binding, definition } = context;
  const projectApp = await db.query.projectApps.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.projectId, input.projectId),
        equals(table.appKey, input.appKey),
      ),
  });
  const projectEnabled =
    projectApp?.enabled ?? definition.installMode === "inherited";
  if (!projectEnabled) return null;
  const [attachments, grants, policies, capabilities] = await Promise.all([
    db.query.projectAppConnections.findMany({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.projectId, input.projectId),
          equals(table.appKey, input.appKey),
          equals(table.isDefault, true),
        ),
    }),
    db.query.environmentAppCapabilityGrants.findMany({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.environmentId, binding.environmentId),
          equals(table.appKey, input.appKey),
        ),
    }),
    db.query.projectAppCapabilityPolicies.findMany({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.projectId, input.projectId),
          equals(table.appKey, input.appKey),
        ),
    }),
    db.query.appCapabilities.findMany({
      where: (table, { eq: equals }) => equals(table.appKey, input.appKey),
    }),
  ]);
  const selectedAttachment = selectEffectiveAttachment({
    connectionModel: definition.connectionModel,
    userId: input.userId,
    attachments,
  });
  if (definition.connectionRequirement === "required" && !selectedAttachment) {
    return null;
  }
  const selectedConnection = selectedAttachment
    ? await db.query.appConnections.findFirst({
        where: (table, { and: all, eq: equals }) =>
          all(
            equals(table.id, selectedAttachment.connectionId),
            equals(table.organizationId, input.organizationId),
            equals(table.appKey, input.appKey),
            inArray(table.status, ["connected", "degraded"]),
          ),
      })
    : null;
  if (definition.connectionRequirement === "required" && !selectedConnection) {
    return null;
  }
  const grantByKey = new Map(
    grants.map((grant) => [grant.capabilityKey, grant]),
  );
  const policyByKey = new Map(
    policies.map((policy) => [policy.capabilityKey, policy]),
  );
  const selectedMicrosoftPacks =
    input.appKey === "microsoft_365"
      ? new Set(
          parseMicrosoft365Packs(
            selectedConnection?.deliveryConfig?.capabilityPacks,
          ),
        )
      : null;
  const effectiveCapabilities = capabilities.flatMap((capability) => {
    if (
      !capability.active ||
      (capability.connectionId !== null &&
        capability.connectionId !== selectedConnection?.id)
    ) {
      return [];
    }
    const grant = grantByKey.get(capability.key);
    const policy = policyByKey.get(capability.key);
    if (
      !grant?.enabled ||
      grant.approvalMode === "deny" ||
      (policy && (!policy.enabled || policy.approvalMode === "deny")) ||
      !(capability.runtimeName || input.includePolicyOnly) ||
      (selectedMicrosoftPacks !== null &&
        !microsoft365PackAllowsCapability({
          selectedPacks: [...selectedMicrosoftPacks],
          capabilityMetadata: capability.metadata,
        })) ||
      (input.appKey === "microsoft_365" &&
        !hasMicrosoft365CapabilityScopes({
          grantedScopes: selectedConnection?.scopes ?? [],
          capability: capability.key as import("@/lib/integrations/microsoft-365-contract").Microsoft365Capability,
        })) ||
      (input.appKey === "google_workspace" &&
        !googleWorkspaceCapabilityIsEligible({
          capabilityKey: capability.key,
          selectedPacks: parseSelectedGoogleWorkspacePacks(
            selectedConnection?.deliveryConfig,
          ),
          grantedScopes: selectedConnection?.scopes ?? [],
        }))
    ) {
      return [];
    }
    return [
      {
        key: capability.key,
        runtimeName: capability.runtimeName,
        approvalMode: applyMinimumApprovalMode({
          requested: intersectAppApprovalModes(
            grant.approvalMode,
            policy?.approvalMode ?? grant.approvalMode,
          ),
          minimum:
            getCoreAppDefinition(input.appKey)?.capabilities.find(
              (candidate) => candidate.key === capability.key,
            )?.minimumApprovalMode ?? "auto",
        }),
        loggingMode: grant.loggingMode,
        rateLimitMode: grant.rateLimitMode,
        settings: grant.settings ?? {},
        inputSchema: capabilityInputSchema(capability),
        accessMode: capability.accessMode,
        workflowUse: classifyWorkflowCapability(capability),
        descriptorContractRevision: capabilityDescriptorContractRevision(capability),
      },
    ];
  });
  if (!effectiveCapabilities.length) return null;
  const filteredCapabilities =
    input.appKey === "github" && selectedConnection && !input.skipResourceReadiness
      ? await filterGitHubCapabilitiesByResource({
          projectId: input.projectId,
          connectionId: selectedConnection.id,
          capabilities: effectiveCapabilities,
        })
      : effectiveCapabilities;
  if (!filteredCapabilities.length) return null;
  return {
    appKey: input.appKey,
    projectId: input.projectId,
    environmentId: binding.environmentId,
    connectionId: selectedConnection?.id ?? null,
    capabilities: filteredCapabilities,
  };
}

function googleWorkspaceCapabilityIsEligible(input: {
  capabilityKey: string;
  selectedPacks: readonly string[];
  grantedScopes: readonly string[];
}) {
  if (input.capabilityKey.startsWith("gmail.")) {
    return input.selectedPacks.includes("gmail") && hasGmailCapabilityScopes({
      grantedScopes: input.grantedScopes,
      capability: input.capabilityKey as import("@/lib/integrations/gmail-contract").GmailCapability,
    });
  }
  return input.selectedPacks.includes("calendar") && hasGoogleCalendarCapabilityScopes({
    grantedScopes: input.grantedScopes,
    capability: input.capabilityKey as import("@/lib/integrations/google-calendar-contract").GoogleCalendarCapability,
  });
}

async function filterGitHubCapabilitiesByResource<T extends { key: string }>(
  input: {
    projectId: string;
    connectionId: string;
    capabilities: T[];
  },
) {
  const resources = await listAuthorizedGitHubResources({
    projectId: input.projectId,
    connectionId: input.connectionId,
  });
  return input.capabilities.filter((capability) =>
    githubCapabilityHasReadyResource(
      capability.key as GitHubCapability,
      resources,
    ),
  );
}

export function selectEffectiveConnection(input: {
  connectionModel: AppConnectionModel;
  connections: ProjectAppConnection[];
}): ProjectAppConnection | null {
  if (input.connectionModel === "none") return null;
  const defaults = input.connections.filter(
    (connection) => connection.isDefault,
  );
  return (
    selectByScopeAndStatus(input.connectionModel, defaults, "connected") ??
    selectByScopeAndStatus(input.connectionModel, defaults, "degraded")
  );
}

function selectByScopeAndStatus(
  connectionModel: AppConnectionModel,
  connections: ProjectAppConnection[],
  status: "connected" | "degraded",
): ProjectAppConnection | null {
  const candidates = connections.filter(
    (connection) => connection.status === status,
  );
  if (connectionModel === "personal" || connectionModel === "hybrid") {
    const personal = candidates.find(
      (connection) => connection.scope === "personal",
    );
    if (personal) return personal;
  }
  if (
    connectionModel === "organization" ||
    connectionModel === "environment" ||
    connectionModel === "hybrid"
  ) {
    return (
      candidates.find((connection) => connection.scope === "shared") ?? null
    );
  }
  return null;
}

function selectEffectiveAttachment(input: {
  connectionModel: AppConnectionModel;
  userId: string;
  attachments: Array<typeof schema.projectAppConnections.$inferSelect>;
}) {
  if (input.connectionModel === "none") return null;
  if (
    input.connectionModel === "personal" ||
    input.connectionModel === "hybrid"
  ) {
    const personal = input.attachments.find(
      (attachment) =>
        attachment.scope === "personal" && attachment.userId === input.userId,
    );
    if (personal) return personal;
  }
  if (
    input.connectionModel === "organization" ||
    input.connectionModel === "environment" ||
    input.connectionModel === "hybrid"
  ) {
    return (
      input.attachments.find((attachment) => attachment.scope === "shared") ??
      null
    );
  }
  return null;
}
