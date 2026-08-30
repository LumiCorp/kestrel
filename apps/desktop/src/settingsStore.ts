import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { applyKestrelLocalEnvDefaults } from "./localDev.js";
import {
  describeDesktopProviderRequirement,
  hasConfiguredDesktopProviderCredential as sharedHasConfiguredDesktopProviderCredential,
} from "../../../src/desktopShell/onboarding.js";
import { buildDesktopModelEnvironment } from "../../../src/desktopShell/modelEnvironment.js";
import type { DatabaseUrlSource } from "../../../src/runtime/databasePreflight.js";
import {
  createDefaultModelPolicy,
  type ModelPolicyV1,
  type ResolvedModelPolicy,
  resolveProfileWithModelPolicy,
} from "../../../src/profile/modelPolicy.js";
import { isLegacyGeneratedDesktopSelection } from "../../../src/profile/runtimeProfile.js";
import {
  composeKestrelOneProfile,
  KESTREL_ONE_POLICY_ID,
} from "../../../src/profile/kestrelOnePolicy.js";
import {
  createDesktopModelConfiguration,
  DESKTOP_DEFAULT_MODEL_CONFIGURATION_ID,
  DESKTOP_DEFAULT_ENABLED_APP_IDS,
  filterDesktopBuiltInAppIds,
  filterDesktopPersonalAppIds,
  getDesktopAppDefinition,
  listDesktopAppDefinitions,
  normalizeDesktopAppId,
  parseDesktopModelConfigurations,
  type DesktopExecutionSelection,
} from "../../../src/desktopShell/configuration.js";
import {
  getDesktopStandardAppConnection,
  hasDesktopStandardAppRequiredTools,
  selectDesktopStandardAppTools,
} from "../../../src/desktopShell/standardAppConnections.js";
import type { McpServerConfig } from "../../../src/mcp/contracts.js";
import {
  BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
  canonicalizePublicBrowserDestination,
  type BrowserPublicDomainAuthorityV1,
} from "../../../src/browser/domainAuthority.js";
import { KESTREL_STANDARD_APP_MANIFESTS } from "@kestrel-agents/protocol";
import type {
  DesktopBrowserPersonalDomainPartitionV1,
  DesktopBrowserPersonalDomainProjectionV1,
  DesktopBrowserPersonalDomainRecordV1,
  DesktopBrowserPersonalDomainsV1,
  DesktopCapabilityPackId,
  DesktopDatabaseMode,
  DesktopModelProvider,
  DesktopProjectRegistration,
  DesktopMcpServerConfig,
  DesktopPluginInstallation,
  DesktopSettings,
} from "./contracts.js";
import {
  DESKTOP_BROWSER_PERSONAL_DOMAIN_PARTITION_VERSION,
  DESKTOP_BROWSER_PERSONAL_DOMAIN_PROVENANCE_VERSION,
  DESKTOP_BROWSER_PERSONAL_DOMAIN_RECORD_VERSION,
  DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION,
} from "../../../src/desktopShell/contracts.js";

export { buildDesktopModelEnvironment } from "../../../src/desktopShell/modelEnvironment.js";

type DesktopSettingsFileBase = {
  selectedProvider?: DesktopModelProvider | undefined;
  databaseMode?: DesktopDatabaseMode | undefined;
  databaseUrl?: string | undefined;
  openrouterApiKey?: string | undefined;
  openrouterModel?: string | undefined;
  openrouterBaseUrl?: string | undefined;
  openrouterSiteUrl?: string | undefined;
  openrouterAppName?: string | undefined;
  openaiApiKey?: string | undefined;
  openaiModel?: string | undefined;
  openaiBaseUrl?: string | undefined;
  openaiOrgId?: string | undefined;
  openaiProjectId?: string | undefined;
  anthropicApiKey?: string | undefined;
  anthropicModel?: string | undefined;
  anthropicBaseUrl?: string | undefined;
  anthropicVersion?: string | undefined;
  ollamaModel?: string | undefined;
  ollamaBaseUrl?: string | undefined;
  lmstudioModel?: string | undefined;
  lmstudioBaseUrl?: string | undefined;
  tavilyApiKey?: string | undefined;
  tavilyBaseUrl?: string | undefined;
  tavilyProject?: string | undefined;
  tavilyHttpProxy?: string | undefined;
  tavilyHttpsProxy?: string | undefined;
  providerSelectionCompletedAt?: string | undefined;
  setupCompletedAt?: string | undefined;
  desktopOnboarding?: DesktopSettings["desktopOnboarding"] | undefined;
  advancedWorkspaceEnabled?: boolean | undefined;
  mcpServers?: DesktopSettings["mcpServers"] | undefined;
  plugins?: DesktopPluginInstallation[] | undefined;
  capabilityVerifications?:
    | DesktopSettings["capabilityVerifications"]
    | undefined;
  developerShellPath?: string | undefined;
  developerPath?: string | undefined;
  developerShellEnvMode?: DesktopSettings["developerShellEnvMode"] | undefined;
  developerShellAllowedEnvNames?: string[] | undefined;
  approvalPolicyPackId?: DesktopSettings["approvalPolicyPackId"] | undefined;
  modelConfigurations?: DesktopSettings["modelConfigurations"] | undefined;
  defaultModelConfigurationId?: string | undefined;
  defaultEnabledAppIds?: string[] | undefined;
  defaultEnabledBuiltInAppIds?: string[] | undefined;
  appearanceTheme?: DesktopSettings["appearanceTheme"] | undefined;
  projectTombstones?: DesktopSettings["projectTombstones"] | undefined;
  browserPersonalDomains?: DesktopSettings["browserPersonalDomains"] | undefined;
};

type DesktopSettingsInput = Partial<DesktopSettings> & {
  defaultEnabledAppIds?: string[] | undefined;
};

type DesktopSettingsFileV1 = {
  version: 1;
  openrouterApiKey?: string | undefined;
};

type DesktopSettingsFileV2 = DesktopSettingsFileBase & {
  version: 2;
};

type DesktopSettingsFileV3 = DesktopSettingsFileBase & {
  version: 3;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
};

type DesktopSettingsFileV4 = DesktopSettingsFileBase & {
  version: 4;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
  projects?: DesktopProjectRegistration[] | undefined;
};

type DesktopSettingsFileV5 = DesktopSettingsFileBase & {
  version: 5;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
  projects?: DesktopProjectRegistration[] | undefined;
};

type DesktopSettingsFileV6 = DesktopSettingsFileBase & {
  version: 6;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
  projects?: DesktopProjectRegistration[] | undefined;
};

type DesktopSettingsFileV7 = DesktopSettingsFileBase & {
  version: 7;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
  projects?: DesktopProjectRegistration[] | undefined;
};

type DesktopSettingsFileV8 = DesktopSettingsFileBase & {
  version: 8;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
  projects?: DesktopProjectRegistration[] | undefined;
};

type DesktopSettingsFileV9 = DesktopSettingsFileBase & {
  version: 9;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
  projects?: DesktopProjectRegistration[] | undefined;
};

type DesktopSettingsFileV10 = DesktopSettingsFileBase & {
  version: 10;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
  projects?: DesktopProjectRegistration[] | undefined;
};

type DesktopSettingsFileV12 = DesktopSettingsFileBase & {
  version: 12;
  plugins?: DesktopPluginInstallation[] | undefined;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
  projects?: DesktopProjectRegistration[] | undefined;
};

type DesktopSettingsFileV13 = DesktopSettingsFileBase & {
  version: 13;
  plugins?: DesktopPluginInstallation[] | undefined;
  presetId?: DesktopSettings["presetId"] | undefined;
  capabilityPacks?: DesktopSettings["capabilityPacks"] | undefined;
  projects?: DesktopProjectRegistration[] | undefined;
  browserPersonalDomains: DesktopBrowserPersonalDomainsV1;
};

const LEGACY_SETUP_COMPLETED_AT = "1970-01-01T00:00:00.000Z";
const LEGACY_PROVIDER_SELECTION_COMPLETED_AT = "1970-01-01T00:00:00.000Z";
const DESKTOP_SAFE_CAPABILITY_PACKS: DesktopCapabilityPackId[] = [
  "balanced",
  "filesystem",
  "desktop_host",
  "sandbox_code",
];

function normalizeDesktopCapabilityPacks(
  capabilityPacks: readonly DesktopCapabilityPackId[] | undefined,
): DesktopCapabilityPackId[] {
  const next = new Set<DesktopCapabilityPackId>();
  const source = capabilityPacks ?? DESKTOP_SAFE_CAPABILITY_PACKS;
  for (const pack of source) {
    if (
      pack === "balanced" ||
      pack === "filesystem" ||
      pack === "dev_shell" ||
      pack === "desktop_host" ||
      pack === "sandbox_code"
    ) {
      next.add(pack);
    }
  }
  next.add("desktop_host");
  return next.size > 0 ? [...next] : [...DESKTOP_SAFE_CAPABILITY_PACKS];
}

export function createDefaultDesktopSettings(
  fallbackModelPolicy: ModelPolicyV1 = createDefaultModelPolicy(),
): DesktopSettings {
  return {
    selectedProvider: "openrouter",
    databaseMode: "default",
    presetId: "desktop_safe_local",
    capabilityPacks: [...DESKTOP_SAFE_CAPABILITY_PACKS],
    projects: [],
    projectTombstones: [],
    mcpServers: [],
    plugins: buildDesktopPluginInstallations([], DESKTOP_DEFAULT_ENABLED_APP_IDS),
    capabilityVerifications: {},
    developerShellEnvMode: "inherit",
    developerShellAllowedEnvNames: [],
    approvalPolicyPackId: "dev",
    advancedWorkspaceEnabled: false,
    modelConfigurations: [createDesktopModelConfiguration(fallbackModelPolicy)],
    defaultModelConfigurationId: DESKTOP_DEFAULT_MODEL_CONFIGURATION_ID,
    defaultEnabledBuiltInAppIds: [...DESKTOP_DEFAULT_ENABLED_APP_IDS],
    appearanceTheme: "system",
    browserPersonalDomains: createEmptyDesktopBrowserPersonalDomains(),
  };
}

export function desktopPreV12SettingsBackupPath(settingsPath: string): string {
  const extension = path.extname(settingsPath);
  const basename = path.basename(settingsPath, extension);
  return path.join(
    path.dirname(settingsPath),
    `${basename}.pre-v12${extension || ".json"}`,
  );
}

export function hasConfiguredDesktopProviderCredential(
  settings: DesktopSettings,
): boolean {
  return sharedHasConfiguredDesktopProviderCredential(settings);
}

export function describeDesktopProviderCredentialRequirement(
  settings: DesktopSettings,
): string | undefined {
  return describeDesktopProviderRequirement(settings)?.detail;
}

export function normalizeDesktopSettings(
  settings: DesktopSettingsInput | undefined,
  options: {
    legacySetupCompletedFromKeys?: boolean | undefined;
    legacyAdvancedWorkspaceEnabled?: boolean | undefined;
    backfillProviderSelection?: boolean | undefined;
    fallbackModelPolicy?: ModelPolicyV1 | undefined;
  } = {},
): DesktopSettings {
  const openrouterApiKey = normalizeOptionalSecret(settings?.openrouterApiKey);
  const databaseUrl = normalizeOptionalSecret(settings?.databaseUrl);
  const openrouterModel = normalizeOptionalSecret(settings?.openrouterModel);
  const openrouterBaseUrl = normalizeOptionalSecret(
    settings?.openrouterBaseUrl,
  );
  const openrouterSiteUrl = normalizeOptionalSecret(
    settings?.openrouterSiteUrl,
  );
  const openrouterAppName = normalizeOptionalSecret(
    settings?.openrouterAppName,
  );
  const openaiApiKey = normalizeOptionalSecret(settings?.openaiApiKey);
  const openaiModel = normalizeOptionalSecret(settings?.openaiModel);
  const openaiBaseUrl = normalizeOptionalSecret(settings?.openaiBaseUrl);
  const openaiOrgId = normalizeOptionalSecret(settings?.openaiOrgId);
  const openaiProjectId = normalizeOptionalSecret(settings?.openaiProjectId);
  const anthropicApiKey = normalizeOptionalSecret(settings?.anthropicApiKey);
  const anthropicModel = normalizeOptionalSecret(settings?.anthropicModel);
  const anthropicBaseUrl = normalizeOptionalSecret(settings?.anthropicBaseUrl);
  const anthropicVersion = normalizeOptionalSecret(settings?.anthropicVersion);
  const ollamaModel = normalizeOptionalSecret(settings?.ollamaModel);
  const ollamaBaseUrl = normalizeOptionalSecret(settings?.ollamaBaseUrl);
  const lmstudioModel = normalizeOptionalSecret(settings?.lmstudioModel);
  const lmstudioBaseUrl = normalizeOptionalSecret(settings?.lmstudioBaseUrl);
  const tavilyApiKey = normalizeOptionalSecret(settings?.tavilyApiKey);
  const tavilyBaseUrl = normalizeOptionalSecret(settings?.tavilyBaseUrl);
  const tavilyProject = normalizeOptionalSecret(settings?.tavilyProject);
  const tavilyHttpProxy = normalizeOptionalSecret(settings?.tavilyHttpProxy);
  const tavilyHttpsProxy = normalizeOptionalSecret(settings?.tavilyHttpsProxy);
  const providerSelectionCompletedAt =
    typeof settings?.providerSelectionCompletedAt === "string" &&
    settings.providerSelectionCompletedAt.trim().length > 0
      ? settings.providerSelectionCompletedAt
      : undefined;
  const selectedProvider = normalizeProvider(settings?.selectedProvider);
  const databaseMode = normalizeDatabaseMode(settings?.databaseMode);
  const developerShellPath = normalizeOptionalSecret(
    settings?.developerShellPath,
  );
  const developerPath = normalizeOptionalSecret(settings?.developerPath);
  const developerShellEnvMode =
    settings?.developerShellEnvMode === "allowlist" ? "allowlist" : "inherit";
  const developerShellAllowedEnvNames = Array.isArray(
    settings?.developerShellAllowedEnvNames,
  )
    ? [
        ...new Set(
          settings.developerShellAllowedEnvNames.filter((name) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
          ),
        ),
      ].sort()
    : [];
  const approvalPolicyPackId =
    settings?.approvalPolicyPackId === "ci_bot" ||
    settings?.approvalPolicyPackId === "hosted_workspace" ||
    settings?.approvalPolicyPackId === "production"
      ? settings.approvalPolicyPackId
      : "dev";
  const hasAnyKey =
    openrouterApiKey !== undefined ||
    openrouterModel !== undefined ||
    openrouterBaseUrl !== undefined ||
    openrouterSiteUrl !== undefined ||
    openrouterAppName !== undefined ||
    openaiApiKey !== undefined ||
    openaiModel !== undefined ||
    openaiBaseUrl !== undefined ||
    openaiOrgId !== undefined ||
    openaiProjectId !== undefined ||
    anthropicApiKey !== undefined ||
    anthropicModel !== undefined ||
    anthropicBaseUrl !== undefined ||
    anthropicVersion !== undefined ||
    ollamaModel !== undefined ||
    ollamaBaseUrl !== undefined ||
    lmstudioModel !== undefined ||
    lmstudioBaseUrl !== undefined ||
    tavilyApiKey !== undefined ||
    tavilyBaseUrl !== undefined ||
    tavilyProject !== undefined ||
    tavilyHttpProxy !== undefined ||
    tavilyHttpsProxy !== undefined;
  const hasLegacyHostedProviderKey =
    openrouterApiKey !== undefined ||
    openaiApiKey !== undefined ||
    anthropicApiKey !== undefined;
  const hasProviderSpecificOverrides =
    openrouterModel !== undefined ||
    openrouterBaseUrl !== undefined ||
    openrouterSiteUrl !== undefined ||
    openrouterAppName !== undefined ||
    openaiModel !== undefined ||
    openaiBaseUrl !== undefined ||
    openaiOrgId !== undefined ||
    openaiProjectId !== undefined ||
    anthropicModel !== undefined ||
    anthropicBaseUrl !== undefined ||
    anthropicVersion !== undefined ||
    ollamaModel !== undefined ||
    ollamaBaseUrl !== undefined ||
    lmstudioModel !== undefined ||
    lmstudioBaseUrl !== undefined;
  const nextSetupCompletedAt =
    typeof settings?.setupCompletedAt === "string" &&
    settings.setupCompletedAt.trim().length > 0
      ? settings.setupCompletedAt
      : options.legacySetupCompletedFromKeys === true && hasAnyKey
        ? LEGACY_SETUP_COMPLETED_AT
        : undefined;
  const nextProviderSelectionCompletedAt =
    providerSelectionCompletedAt ??
    (options.backfillProviderSelection === true &&
    (nextSetupCompletedAt !== undefined ||
      normalizeDesktopProjects(settings?.projects).length > 0 ||
      hasLegacyHostedProviderKey ||
      hasProviderSpecificOverrides ||
      selectedProvider !== "openrouter")
      ? LEGACY_PROVIDER_SELECTION_COMPLETED_AT
      : undefined);
  const desktopOnboarding = normalizeDesktopOnboardingRecord(
    settings?.desktopOnboarding,
  );
  let modelConfigurations: DesktopSettings["modelConfigurations"];
  try {
    modelConfigurations =
      settings?.modelConfigurations === undefined
        ? [
            createDesktopModelConfiguration(
              options.fallbackModelPolicy ?? createDefaultModelPolicy(),
            ),
          ]
        : parseDesktopModelConfigurations(settings.modelConfigurations);
  } catch {
    modelConfigurations = [
      createDesktopModelConfiguration(
        options.fallbackModelPolicy ?? createDefaultModelPolicy(),
      ),
    ];
  }
  const requestedDefaultConfigurationId =
    typeof settings?.defaultModelConfigurationId === "string"
      ? settings.defaultModelConfigurationId.trim()
      : "";
  const defaultModelConfigurationId = modelConfigurations.some(
    (configuration) =>
      configuration.id === requestedDefaultConfigurationId &&
      configuration.archivedAt === undefined,
  )
    ? requestedDefaultConfigurationId
    : (modelConfigurations.find(
        (configuration) => configuration.archivedAt === undefined,
      )?.id ?? modelConfigurations[0]!.id);
  const persistedPlugins = normalizeDesktopPluginInstallations(settings?.plugins);
  const mcpServers = persistedPlugins === undefined
    ? normalizeDesktopMcpServers(settings?.mcpServers)
    : persistedPlugins.flatMap((plugin) => plugin.mcpServer === undefined ? [] : [plugin.mcpServer]);
  const legacyDefaultAppIds = Array.isArray(settings?.defaultEnabledAppIds)
    ? settings.defaultEnabledAppIds.flatMap((id) => typeof id === "string" ? [id] : [])
    : undefined;
  const defaultEnabledBuiltInAppIds = Array.isArray(settings?.defaultEnabledBuiltInAppIds)
    ? filterDesktopBuiltInAppIds(settings.defaultEnabledBuiltInAppIds)
    : legacyDefaultAppIds !== undefined
      ? filterDesktopBuiltInAppIds(legacyDefaultAppIds)
      : [...DESKTOP_DEFAULT_ENABLED_APP_IDS];
  const appearanceTheme =
    settings?.appearanceTheme === "light" ||
    settings?.appearanceTheme === "dark"
      ? settings.appearanceTheme
      : "system";
  const browserPersonalDomains = normalizeDesktopBrowserPersonalDomains(
    settings?.browserPersonalDomains,
  );

  const requestedCapabilityPacks =
    isLegacyGeneratedDesktopSelection({
      presetId: settings?.presetId,
      capabilityPacks: settings?.capabilityPacks,
    })
      ? DESKTOP_SAFE_CAPABILITY_PACKS
      : settings?.capabilityPacks;
  const capabilityPacks = normalizeDesktopCapabilityPacks(
    requestedCapabilityPacks,
  );
  return {
    selectedProvider,
    databaseMode,
    presetId: capabilityPacks.includes("dev_shell")
      ? "desktop_dev_local"
      : "desktop_safe_local",
    capabilityPacks,
    projectTombstones: normalizeDesktopProjectTombstones(
      settings?.projectTombstones,
    ),
    projects: normalizeDesktopProjects(
      settings?.projects,
      settings?.projectTombstones,
    ),
    mcpServers,
    plugins: persistedPlugins === undefined
      ? buildDesktopPluginInstallations(mcpServers, defaultEnabledBuiltInAppIds, tavilyApiKey)
      : mergeIncludedDesktopPlugins(persistedPlugins, defaultEnabledBuiltInAppIds),
    capabilityVerifications: normalizeCapabilityVerifications(
      settings?.capabilityVerifications,
    ),
    ...(developerShellPath !== undefined ? { developerShellPath } : {}),
    ...(developerPath !== undefined ? { developerPath } : {}),
    developerShellEnvMode,
    developerShellAllowedEnvNames,
    approvalPolicyPackId,
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    ...(openrouterApiKey !== undefined ? { openrouterApiKey } : {}),
    ...(openrouterModel !== undefined ? { openrouterModel } : {}),
    ...(openrouterBaseUrl !== undefined ? { openrouterBaseUrl } : {}),
    ...(openrouterSiteUrl !== undefined ? { openrouterSiteUrl } : {}),
    ...(openrouterAppName !== undefined ? { openrouterAppName } : {}),
    ...(openaiApiKey !== undefined ? { openaiApiKey } : {}),
    ...(openaiModel !== undefined ? { openaiModel } : {}),
    ...(openaiBaseUrl !== undefined ? { openaiBaseUrl } : {}),
    ...(openaiOrgId !== undefined ? { openaiOrgId } : {}),
    ...(openaiProjectId !== undefined ? { openaiProjectId } : {}),
    ...(anthropicApiKey !== undefined ? { anthropicApiKey } : {}),
    ...(anthropicModel !== undefined ? { anthropicModel } : {}),
    ...(anthropicBaseUrl !== undefined ? { anthropicBaseUrl } : {}),
    ...(anthropicVersion !== undefined ? { anthropicVersion } : {}),
    ...(ollamaModel !== undefined ? { ollamaModel } : {}),
    ...(ollamaBaseUrl !== undefined ? { ollamaBaseUrl } : {}),
    ...(lmstudioModel !== undefined ? { lmstudioModel } : {}),
    ...(lmstudioBaseUrl !== undefined ? { lmstudioBaseUrl } : {}),
    ...(tavilyApiKey !== undefined ? { tavilyApiKey } : {}),
    ...(tavilyBaseUrl !== undefined ? { tavilyBaseUrl } : {}),
    ...(tavilyProject !== undefined ? { tavilyProject } : {}),
    ...(tavilyHttpProxy !== undefined ? { tavilyHttpProxy } : {}),
    ...(tavilyHttpsProxy !== undefined ? { tavilyHttpsProxy } : {}),
    ...(nextProviderSelectionCompletedAt !== undefined
      ? { providerSelectionCompletedAt: nextProviderSelectionCompletedAt }
      : {}),
    ...(nextSetupCompletedAt !== undefined
      ? { setupCompletedAt: nextSetupCompletedAt }
      : {}),
    ...(desktopOnboarding !== undefined ? { desktopOnboarding } : {}),
    advancedWorkspaceEnabled:
      typeof settings?.advancedWorkspaceEnabled === "boolean"
        ? settings.advancedWorkspaceEnabled
        : options.legacyAdvancedWorkspaceEnabled === true,
    modelConfigurations,
    defaultModelConfigurationId,
    defaultEnabledBuiltInAppIds,
    appearanceTheme,
    browserPersonalDomains,
  };
}

export function buildDesktopRunnerProfile(
  modelPolicy: ResolvedModelPolicy,
  settings?: DesktopSettings | undefined,
) {
  const profile = resolveProfileWithModelPolicy(
    composeKestrelOneProfile({
      environmentPresetId: settings?.presetId ?? "desktop_safe_local",
    }).profile,
    modelPolicy,
  );
  if (settings === undefined) return profile;
  const enabledServers = settings.mcpServers.filter((server) => server.enabled);
  const mcpServers = enabledServers.filter(
    (server) =>
      server.appId === undefined ||
      (() => {
        const connection = getDesktopStandardAppConnection(server.appId!);
        return connection?.kind !== "authorization" || connection.runtime !== "native";
      })(),
  );
  return {
    ...profile,
    agentProfileId: KESTREL_ONE_POLICY_ID,
    approvalPolicyPackId: settings.approvalPolicyPackId,
    devShell: {
      ...(profile.devShell ?? { enabled: false }),
      enabled: settings.capabilityPacks.includes("dev_shell"),
      envMode: settings.developerShellEnvMode,
      allowedEnvNames: [...settings.developerShellAllowedEnvNames],
    },
    mcpServers: mcpServers.map(toRuntimeMcpServer),
    toolAllowlist: [
      ...(profile.toolAllowlist ?? []),
      ...enabledServers.flatMap(
        (server) => {
          const connection = server.appId === undefined
            ? undefined
            : getDesktopStandardAppConnection(server.appId);
          const native = connection?.kind === "authorization" && connection.runtime === "native";
          return server.tools?.map((tool) =>
            native ? tool.name : `mcp.${server.id}.${tool.name}`,
          ) ?? [];
        },
      ),
    ],
  };
}

export function buildDesktopExecutionProfile(
  modelPolicy: ResolvedModelPolicy,
  settings: DesktopSettings,
  selection: DesktopExecutionSelection,
) {
  const selectedAppTools = new Set<string>();
  for (const app of selection.apps) {
    const definition = getDesktopAppDefinition(
      app.id,
      app.contractVersion,
      settings.mcpServers,
    );
    if (definition === undefined) {
      return { missingApp: app } as const;
    }
    for (const toolName of definition.toolNames) {
      selectedAppTools.add(toolName);
    }
  }
  const allAppTools = new Set(
    listDesktopAppDefinitions(settings.mcpServers).flatMap(
      (definition) => definition.toolNames,
    ),
  );
  const baseProfile = buildDesktopRunnerProfile(modelPolicy, settings);
  const toolAllowlist = [
    ...(baseProfile.toolAllowlist ?? []).filter(
      (toolName) => allAppTools.has(toolName) === false,
    ),
    ...selectedAppTools,
  ];
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(selection))
    .digest("hex")
    .slice(0, 12);
  return {
    profile: {
      ...baseProfile,
      id: `${baseProfile.id}-${fingerprint}`,
      toolAllowlist: [...new Set(toolAllowlist)],
    },
  };
}

export function buildDesktopRunnerEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  settings: DesktopSettings,
  modelPolicy: ResolvedModelPolicy,
  runtimeHomePath: string,
  options: {
    databaseUrl?: string | undefined;
    databaseUrlSource?: DatabaseUrlSource | undefined;
  } = {},
): NodeJS.ProcessEnv {
  const env = buildDesktopModelEnvironment(baseEnv, settings, modelPolicy);
  env.KESTREL_HOME = runtimeHomePath;
  env.KESTREL_MODEL_PROMPT_DUMP = "1";
  env.KESTREL_ENABLE_MANAGED_WORKTREES = "1";
  if (
    typeof options.databaseUrl === "string" &&
    options.databaseUrl.trim().length > 0
  ) {
    env.DATABASE_URL = options.databaseUrl;
    env.KESTREL_DATABASE_URL_SOURCE =
      options.databaseUrlSource ?? "environment";
  } else if (settings.databaseMode === "external") {
    delete env.DATABASE_URL;
    env.KESTREL_DATABASE_URL_SOURCE = "desktop_external";
  } else {
    applyKestrelLocalEnvDefaults(env);
    env.KESTREL_DATABASE_URL_SOURCE = "desktop_default";
  }
  return env;
}

export async function readDesktopSettings(
  settingsPath: string,
): Promise<DesktopSettings> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version === 1) {
      return normalizeDesktopSettings(
        {
          selectedProvider: "openrouter",
          openrouterApiKey:
            typeof parsed.openrouterApiKey === "string"
              ? parsed.openrouterApiKey
              : undefined,
        },
        {
          legacySetupCompletedFromKeys: true,
          legacyAdvancedWorkspaceEnabled: true,
          backfillProviderSelection: true,
        },
      );
    }
    if (
      parsed.version !== 2 &&
      parsed.version !== 3 &&
      parsed.version !== 4 &&
      parsed.version !== 5 &&
      parsed.version !== 6 &&
      parsed.version !== 7 &&
      parsed.version !== 8 &&
      parsed.version !== 9 &&
      parsed.version !== 10 &&
      parsed.version !== 11 &&
      parsed.version !== 12 &&
      parsed.version !== 13
    ) {
      return createDefaultDesktopSettings();
    }
    const selectedProvider =
      parsed.selectedProvider === "openrouter" ||
      parsed.selectedProvider === "openai" ||
      parsed.selectedProvider === "anthropic" ||
      parsed.selectedProvider === "ollama" ||
      parsed.selectedProvider === "lmstudio"
        ? parsed.selectedProvider
        : undefined;
    const databaseMode =
      parsed.databaseMode === "default" || parsed.databaseMode === "external"
        ? parsed.databaseMode
        : undefined;
    const databaseUrl =
      typeof parsed.databaseUrl === "string" ? parsed.databaseUrl : undefined;
    const developerShellPath =
      typeof parsed.developerShellPath === "string"
        ? parsed.developerShellPath
        : undefined;
    const developerPath =
      typeof parsed.developerPath === "string"
        ? parsed.developerPath
        : undefined;
    const developerShellEnvMode =
      parsed.developerShellEnvMode === "allowlist"
        ? ("allowlist" as const)
        : parsed.developerShellEnvMode === "inherit"
          ? ("inherit" as const)
          : undefined;
    const developerShellAllowedEnvNames = Array.isArray(
      parsed.developerShellAllowedEnvNames,
    )
      ? parsed.developerShellAllowedEnvNames.filter(
          (name): name is string => typeof name === "string",
        )
      : undefined;
    const approvalPolicyPackId =
      parsed.approvalPolicyPackId === "dev" ||
      parsed.approvalPolicyPackId === "ci_bot" ||
      parsed.approvalPolicyPackId === "hosted_workspace" ||
      parsed.approvalPolicyPackId === "production"
        ? parsed.approvalPolicyPackId
        : undefined;
    const openrouterApiKey =
      typeof parsed.openrouterApiKey === "string"
        ? parsed.openrouterApiKey
        : undefined;
    const openrouterModel =
      typeof parsed.openrouterModel === "string"
        ? parsed.openrouterModel
        : undefined;
    const openrouterBaseUrl =
      typeof parsed.openrouterBaseUrl === "string"
        ? parsed.openrouterBaseUrl
        : undefined;
    const openrouterSiteUrl =
      typeof parsed.openrouterSiteUrl === "string"
        ? parsed.openrouterSiteUrl
        : undefined;
    const openrouterAppName =
      typeof parsed.openrouterAppName === "string"
        ? parsed.openrouterAppName
        : undefined;
    const openaiApiKey =
      typeof parsed.openaiApiKey === "string" ? parsed.openaiApiKey : undefined;
    const openaiModel =
      typeof parsed.openaiModel === "string" ? parsed.openaiModel : undefined;
    const openaiBaseUrl =
      typeof parsed.openaiBaseUrl === "string"
        ? parsed.openaiBaseUrl
        : undefined;
    const openaiOrgId =
      typeof parsed.openaiOrgId === "string" ? parsed.openaiOrgId : undefined;
    const openaiProjectId =
      typeof parsed.openaiProjectId === "string"
        ? parsed.openaiProjectId
        : undefined;
    const anthropicApiKey =
      typeof parsed.anthropicApiKey === "string"
        ? parsed.anthropicApiKey
        : undefined;
    const anthropicModel =
      typeof parsed.anthropicModel === "string"
        ? parsed.anthropicModel
        : undefined;
    const anthropicBaseUrl =
      typeof parsed.anthropicBaseUrl === "string"
        ? parsed.anthropicBaseUrl
        : undefined;
    const anthropicVersion =
      typeof parsed.anthropicVersion === "string"
        ? parsed.anthropicVersion
        : undefined;
    const ollamaModel =
      typeof parsed.ollamaModel === "string" ? parsed.ollamaModel : undefined;
    const ollamaBaseUrl =
      typeof parsed.ollamaBaseUrl === "string"
        ? parsed.ollamaBaseUrl
        : undefined;
    const lmstudioModel =
      typeof parsed.lmstudioModel === "string"
        ? parsed.lmstudioModel
        : undefined;
    const lmstudioBaseUrl =
      typeof parsed.lmstudioBaseUrl === "string"
        ? parsed.lmstudioBaseUrl
        : undefined;
    const tavilyApiKey =
      typeof parsed.tavilyApiKey === "string" ? parsed.tavilyApiKey : undefined;
    const tavilyBaseUrl =
      typeof parsed.tavilyBaseUrl === "string"
        ? parsed.tavilyBaseUrl
        : undefined;
    const tavilyProject =
      typeof parsed.tavilyProject === "string"
        ? parsed.tavilyProject
        : undefined;
    const tavilyHttpProxy =
      typeof parsed.tavilyHttpProxy === "string"
        ? parsed.tavilyHttpProxy
        : undefined;
    const tavilyHttpsProxy =
      typeof parsed.tavilyHttpsProxy === "string"
        ? parsed.tavilyHttpsProxy
        : undefined;
    const providerSelectionCompletedAt =
      typeof parsed.providerSelectionCompletedAt === "string"
        ? parsed.providerSelectionCompletedAt
        : undefined;
    const setupCompletedAt =
      typeof parsed.setupCompletedAt === "string"
        ? parsed.setupCompletedAt
        : undefined;
    const desktopOnboarding =
      (parsed.version === 10 || parsed.version === 11 || parsed.version === 12 || parsed.version === 13)
        ? normalizeDesktopOnboardingRecord(parsed.desktopOnboarding)
        : undefined;
    const advancedWorkspaceEnabled =
      parsed.advancedWorkspaceEnabled === true ||
      parsed.advancedWorkspaceEnabled === false
        ? parsed.advancedWorkspaceEnabled
        : undefined;
    const modelConfigurations =
      (parsed.version === 10 || parsed.version === 11 || parsed.version === 12 || parsed.version === 13) && Array.isArray(parsed.modelConfigurations)
        ? parsed.modelConfigurations
        : undefined;
    const defaultModelConfigurationId =
      (parsed.version === 10 || parsed.version === 11 || parsed.version === 12 || parsed.version === 13) &&
      typeof parsed.defaultModelConfigurationId === "string"
        ? parsed.defaultModelConfigurationId
        : undefined;
    const legacyDefaultAppIds =
      parsed.version === 10 && Array.isArray(parsed.defaultEnabledAppIds)
        ? parsed.defaultEnabledAppIds.flatMap((entry) => typeof entry === "string" ? [entry] : [])
        : [];
    const defaultEnabledBuiltInAppIds =
      (parsed.version === 11 || parsed.version === 12 || parsed.version === 13) && Array.isArray(parsed.defaultEnabledBuiltInAppIds)
        ? parsed.defaultEnabledBuiltInAppIds
        : parsed.version === 10
          ? filterDesktopBuiltInAppIds(legacyDefaultAppIds)
          : undefined;
    const appearanceTheme =
      (parsed.version === 10 || parsed.version === 11 || parsed.version === 12 || parsed.version === 13) &&
      (parsed.appearanceTheme === "system" ||
        parsed.appearanceTheme === "light" ||
        parsed.appearanceTheme === "dark")
        ? parsed.appearanceTheme
        : undefined;
    const presetId =
      parsed.presetId === "desktop_safe_local" ||
      parsed.presetId === "desktop_dev_local"
        ? parsed.presetId
        : undefined;
    const capabilityPacks =
      Array.isArray(parsed.capabilityPacks) &&
      parsed.capabilityPacks.every(
        (entry) =>
          entry === "balanced" ||
          entry === "filesystem" ||
          entry === "dev_shell" ||
          entry === "desktop_host" ||
          entry === "sandbox_code",
      )
        ? parsed.capabilityPacks
        : undefined;
    const projectTombstones = normalizeDesktopProjectTombstones(
      Array.isArray(parsed.projectTombstones)
        ? (parsed.projectTombstones as DesktopSettings["projectTombstones"])
        : undefined,
    );
    const projects = Array.isArray(parsed.projects)
      ? normalizeDesktopProjects(parsed.projects, projectTombstones)
      : undefined;
    const mcpServers = Array.isArray(parsed.mcpServers)
      ? normalizeDesktopMcpServers(parsed.mcpServers)
      : undefined;
    const plugins = normalizeDesktopPluginInstallations(parsed.plugins);
    const capabilityVerifications = normalizeCapabilityVerifications(
      parsed.capabilityVerifications,
    );
    if (parsed.version === 13 && !("browserPersonalDomains" in parsed)) {
      throw new Error(
        "Desktop schema 13 requires Browser personal-domain settings.",
      );
    }
    const browserPersonalDomains =
      parsed.version === 13
        ? normalizeDesktopBrowserPersonalDomains(parsed.browserPersonalDomains)
        : createEmptyDesktopBrowserPersonalDomains();
    return normalizeDesktopSettings(
      {
        ...(presetId !== undefined ? { presetId } : {}),
        ...(capabilityPacks !== undefined ? { capabilityPacks } : {}),
        ...(projects !== undefined ? { projects } : {}),
        projectTombstones,
        ...(mcpServers !== undefined ? { mcpServers } : {}),
        ...(plugins !== undefined ? { plugins } : {}),
        capabilityVerifications,
        ...(selectedProvider !== undefined ? { selectedProvider } : {}),
        ...(databaseMode !== undefined ? { databaseMode } : {}),
        ...(databaseUrl !== undefined ? { databaseUrl } : {}),
        ...(developerShellPath !== undefined ? { developerShellPath } : {}),
        ...(developerPath !== undefined ? { developerPath } : {}),
        ...(developerShellEnvMode !== undefined
          ? { developerShellEnvMode }
          : {}),
        ...(developerShellAllowedEnvNames !== undefined
          ? { developerShellAllowedEnvNames }
          : {}),
        ...(approvalPolicyPackId !== undefined ? { approvalPolicyPackId } : {}),
        ...(openrouterApiKey !== undefined ? { openrouterApiKey } : {}),
        ...(openrouterModel !== undefined ? { openrouterModel } : {}),
        ...(openrouterBaseUrl !== undefined ? { openrouterBaseUrl } : {}),
        ...(openrouterSiteUrl !== undefined ? { openrouterSiteUrl } : {}),
        ...(openrouterAppName !== undefined ? { openrouterAppName } : {}),
        ...(openaiApiKey !== undefined ? { openaiApiKey } : {}),
        ...(openaiModel !== undefined ? { openaiModel } : {}),
        ...(openaiBaseUrl !== undefined ? { openaiBaseUrl } : {}),
        ...(openaiOrgId !== undefined ? { openaiOrgId } : {}),
        ...(openaiProjectId !== undefined ? { openaiProjectId } : {}),
        ...(anthropicApiKey !== undefined ? { anthropicApiKey } : {}),
        ...(anthropicModel !== undefined ? { anthropicModel } : {}),
        ...(anthropicBaseUrl !== undefined ? { anthropicBaseUrl } : {}),
        ...(anthropicVersion !== undefined ? { anthropicVersion } : {}),
        ...(ollamaModel !== undefined ? { ollamaModel } : {}),
        ...(ollamaBaseUrl !== undefined ? { ollamaBaseUrl } : {}),
        ...(lmstudioModel !== undefined ? { lmstudioModel } : {}),
        ...(lmstudioBaseUrl !== undefined ? { lmstudioBaseUrl } : {}),
        ...(tavilyApiKey !== undefined ? { tavilyApiKey } : {}),
        ...(tavilyBaseUrl !== undefined ? { tavilyBaseUrl } : {}),
        ...(tavilyProject !== undefined ? { tavilyProject } : {}),
        ...(tavilyHttpProxy !== undefined ? { tavilyHttpProxy } : {}),
        ...(tavilyHttpsProxy !== undefined ? { tavilyHttpsProxy } : {}),
        ...(providerSelectionCompletedAt !== undefined
          ? { providerSelectionCompletedAt }
          : {}),
        ...(setupCompletedAt !== undefined ? { setupCompletedAt } : {}),
        ...(desktopOnboarding !== undefined ? { desktopOnboarding } : {}),
        ...(advancedWorkspaceEnabled !== undefined
          ? { advancedWorkspaceEnabled }
          : {}),
        ...(modelConfigurations !== undefined ? { modelConfigurations } : {}),
        ...(defaultModelConfigurationId !== undefined
          ? { defaultModelConfigurationId }
          : {}),
        ...(defaultEnabledBuiltInAppIds !== undefined ? { defaultEnabledBuiltInAppIds } : {}),
        ...(appearanceTheme !== undefined ? { appearanceTheme } : {}),
        browserPersonalDomains,
      },
      {
        backfillProviderSelection:
          parsed.version !== 9 && parsed.version !== 10 && parsed.version !== 11 && parsed.version !== 12 && parsed.version !== 13,
      },
    );
  } catch {
    return createDefaultDesktopSettings();
  }
}

export async function writeDesktopSettings(
  settingsPath: string,
  settings: DesktopSettings,
): Promise<DesktopSettings> {
  const normalized = normalizeDesktopSettings(settings);
  const payload: DesktopSettingsFileV13 = {
    version: 13,
    selectedProvider: normalized.selectedProvider,
    databaseMode: normalized.databaseMode,
    presetId: normalized.presetId,
    capabilityPacks: [...normalized.capabilityPacks],
    projects: [...normalized.projects],
    projectTombstones: normalized.projectTombstones.map((tombstone) => ({
      ...tombstone,
    })),
    plugins: normalized.plugins.map((plugin) => ({
      ...plugin,
      capabilityPacks: plugin.capabilityPacks !== undefined ? [...plugin.capabilityPacks] : undefined,
      credentialIds: plugin.credentialIds !== undefined ? [...plugin.credentialIds] : undefined,
      mcpServer: plugin.mcpServer === undefined ? undefined : { ...plugin.mcpServer },
    })),
    capabilityVerifications: { ...normalized.capabilityVerifications },
    ...(normalized.developerShellPath !== undefined
      ? { developerShellPath: normalized.developerShellPath }
      : {}),
    ...(normalized.developerPath !== undefined
      ? { developerPath: normalized.developerPath }
      : {}),
    developerShellEnvMode: normalized.developerShellEnvMode,
    developerShellAllowedEnvNames: [
      ...normalized.developerShellAllowedEnvNames,
    ],
    approvalPolicyPackId: normalized.approvalPolicyPackId,
    ...(normalized.openrouterModel !== undefined
      ? { openrouterModel: normalized.openrouterModel }
      : {}),
    ...(normalized.openrouterBaseUrl !== undefined
      ? { openrouterBaseUrl: normalized.openrouterBaseUrl }
      : {}),
    ...(normalized.openrouterSiteUrl !== undefined
      ? { openrouterSiteUrl: normalized.openrouterSiteUrl }
      : {}),
    ...(normalized.openrouterAppName !== undefined
      ? { openrouterAppName: normalized.openrouterAppName }
      : {}),
    ...(normalized.openaiModel !== undefined
      ? { openaiModel: normalized.openaiModel }
      : {}),
    ...(normalized.openaiBaseUrl !== undefined
      ? { openaiBaseUrl: normalized.openaiBaseUrl }
      : {}),
    ...(normalized.openaiOrgId !== undefined
      ? { openaiOrgId: normalized.openaiOrgId }
      : {}),
    ...(normalized.openaiProjectId !== undefined
      ? { openaiProjectId: normalized.openaiProjectId }
      : {}),
    ...(normalized.anthropicModel !== undefined
      ? { anthropicModel: normalized.anthropicModel }
      : {}),
    ...(normalized.anthropicBaseUrl !== undefined
      ? { anthropicBaseUrl: normalized.anthropicBaseUrl }
      : {}),
    ...(normalized.anthropicVersion !== undefined
      ? { anthropicVersion: normalized.anthropicVersion }
      : {}),
    ...(normalized.ollamaModel !== undefined
      ? { ollamaModel: normalized.ollamaModel }
      : {}),
    ...(normalized.ollamaBaseUrl !== undefined
      ? { ollamaBaseUrl: normalized.ollamaBaseUrl }
      : {}),
    ...(normalized.lmstudioModel !== undefined
      ? { lmstudioModel: normalized.lmstudioModel }
      : {}),
    ...(normalized.lmstudioBaseUrl !== undefined
      ? { lmstudioBaseUrl: normalized.lmstudioBaseUrl }
      : {}),
    ...(normalized.tavilyBaseUrl !== undefined
      ? { tavilyBaseUrl: normalized.tavilyBaseUrl }
      : {}),
    ...(normalized.tavilyProject !== undefined
      ? { tavilyProject: normalized.tavilyProject }
      : {}),
    ...(normalized.tavilyHttpProxy !== undefined
      ? { tavilyHttpProxy: normalized.tavilyHttpProxy }
      : {}),
    ...(normalized.tavilyHttpsProxy !== undefined
      ? { tavilyHttpsProxy: normalized.tavilyHttpsProxy }
      : {}),
    ...(normalized.providerSelectionCompletedAt !== undefined
      ? {
          providerSelectionCompletedAt: normalized.providerSelectionCompletedAt,
        }
      : {}),
    ...(normalized.setupCompletedAt !== undefined
      ? { setupCompletedAt: normalized.setupCompletedAt }
      : {}),
    ...(normalized.desktopOnboarding !== undefined
      ? { desktopOnboarding: normalized.desktopOnboarding }
      : {}),
    advancedWorkspaceEnabled: normalized.advancedWorkspaceEnabled,
    modelConfigurations: normalized.modelConfigurations,
    defaultModelConfigurationId: normalized.defaultModelConfigurationId,
    defaultEnabledBuiltInAppIds: normalized.defaultEnabledBuiltInAppIds,
    appearanceTheme: normalized.appearanceTheme,
    browserPersonalDomains: normalized.browserPersonalDomains,
  };
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await preservePreV12SettingsBackup(settingsPath);
  await writeFile(
    settingsPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  const {
    databaseUrl: _databaseUrl,
    openrouterApiKey: _openrouterApiKey,
    openaiApiKey: _openaiApiKey,
    anthropicApiKey: _anthropicApiKey,
    tavilyApiKey: _tavilyApiKey,
    ...sanitized
  } = normalized;
  return sanitized;
}

export interface DesktopBrowserPersonalDomainScope {
  /** Must come from LocalCoreKestrelOneAccountManager.account().projection.account.id. */
  accountId: string;
  /** Must be the Environment selected for the current signed-in account. */
  environmentId: string;
}

export interface RememberDesktopBrowserPersonalDomainInput
  extends DesktopBrowserPersonalDomainScope {
  destination: string;
  approvalId: string;
  approvedAt: string;
}

export interface RevokeDesktopBrowserPersonalDomainInput
  extends DesktopBrowserPersonalDomainScope {
  canonicalDomain: string;
  revokedAt: string;
}

export type DesktopBrowserPersonalDomainMutationResult = {
  settings: DesktopSettings;
  projection: DesktopBrowserPersonalDomainProjectionV1;
  disposition: "created" | "reactivated" | "revoked" | "unchanged";
};

export function createEmptyDesktopBrowserPersonalDomains(): DesktopBrowserPersonalDomainsV1 {
  return {
    version: DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION,
    partitions: [],
  };
}

/**
 * Returns only the caller's exact account and Environment partition. Callers
 * must obtain both IDs from trusted signed-in account state for every read.
 */
export function projectDesktopBrowserPersonalDomains(
  settings: Pick<DesktopSettings, "browserPersonalDomains">,
  scope: DesktopBrowserPersonalDomainScope,
): DesktopBrowserPersonalDomainProjectionV1 {
  const { accountId, environmentId } = parseDesktopBrowserScope(scope);
  const partition = settings.browserPersonalDomains.partitions.find(
    (candidate) =>
      candidate.accountId === accountId &&
      candidate.environmentId === environmentId,
  );
  const revision = partition?.revision ?? 0;
  const domains = (partition?.domains ?? []).map(cloneDesktopBrowserDomainRecord);
  return {
    accountId,
    environmentId,
    revision,
    authority: {
      version: BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION,
      userId: accountId,
      environmentId,
      revision: String(revision),
      activeDomains: domains
        .filter((record) => record.state === "active")
        .map((record) => ({ ...record.authority })),
    },
    domains,
  };
}

/** Idempotently creates or reactivates one canonical personal grant. */
export function rememberDesktopBrowserPersonalDomain(
  settings: DesktopSettings,
  input: RememberDesktopBrowserPersonalDomainInput,
): DesktopBrowserPersonalDomainMutationResult {
  const scope = parseDesktopBrowserScope(input);
  const approvalId = requireDesktopBrowserText(input.approvalId, "approvalId");
  const approvedAt = requireDesktopBrowserTimestamp(input.approvedAt, "approvedAt");
  const authority = canonicalizePublicBrowserDestination(input.destination);
  const existingPartition = settings.browserPersonalDomains.partitions.find(
    (partition) => partitionMatchesScope(partition, scope),
  );
  const existingRecord = existingPartition?.domains.find(
    (record) => record.authority.canonicalDomain === authority.canonicalDomain,
  );
  if (existingRecord?.state === "active") {
    return {
      settings,
      projection: projectDesktopBrowserPersonalDomains(settings, scope),
      disposition: "unchanged",
    };
  }
  if (
    existingRecord !== undefined &&
    Date.parse(approvedAt) < Date.parse(existingRecord.updatedAt)
  ) {
    throw new Error("approvedAt cannot precede the domain's current state.");
  }

  const nextRecord: DesktopBrowserPersonalDomainRecordV1 = {
    version: DESKTOP_BROWSER_PERSONAL_DOMAIN_RECORD_VERSION,
    authority,
    state: "active",
    provenance: {
      version: DESKTOP_BROWSER_PERSONAL_DOMAIN_PROVENANCE_VERSION,
      source: "browser.request_grant",
      approvalId,
      approvedAt,
    },
    createdAt: existingRecord?.createdAt ?? approvedAt,
    updatedAt: approvedAt,
  };
  const nextSettings = replaceDesktopBrowserPartition(
    settings,
    scope,
    nextPartition(
      existingPartition,
      scope,
      upsertDesktopBrowserDomain(existingPartition?.domains ?? [], nextRecord),
    ),
  );
  return {
    settings: nextSettings,
    projection: projectDesktopBrowserPersonalDomains(nextSettings, scope),
    disposition: existingRecord === undefined ? "created" : "reactivated",
  };
}

/** Idempotently revokes only one domain in the caller's exact partition. */
export function revokeDesktopBrowserPersonalDomain(
  settings: DesktopSettings,
  input: RevokeDesktopBrowserPersonalDomainInput,
): DesktopBrowserPersonalDomainMutationResult {
  const scope = parseDesktopBrowserScope(input);
  const revokedAt = requireDesktopBrowserTimestamp(input.revokedAt, "revokedAt");
  const authority = canonicalizePublicBrowserDestination(
    `https://${requireDesktopBrowserText(input.canonicalDomain, "canonicalDomain")}`,
  );
  if (authority.canonicalDomain !== input.canonicalDomain) {
    throw new Error("canonicalDomain must already be canonical.");
  }
  const existingPartition = settings.browserPersonalDomains.partitions.find(
    (partition) => partitionMatchesScope(partition, scope),
  );
  const existingRecord = existingPartition?.domains.find(
    (record) => record.authority.canonicalDomain === authority.canonicalDomain,
  );
  if (existingRecord === undefined || existingRecord.state === "revoked") {
    return {
      settings,
      projection: projectDesktopBrowserPersonalDomains(settings, scope),
      disposition: "unchanged",
    };
  }
  if (Date.parse(revokedAt) < Date.parse(existingRecord.updatedAt)) {
    throw new Error("revokedAt cannot precede the domain's current state.");
  }
  const nextRecord: DesktopBrowserPersonalDomainRecordV1 = {
    ...cloneDesktopBrowserDomainRecord(existingRecord),
    state: "revoked",
    updatedAt: revokedAt,
    revokedAt,
  };
  const nextSettings = replaceDesktopBrowserPartition(
    settings,
    scope,
    nextPartition(
      existingPartition,
      scope,
      upsertDesktopBrowserDomain(existingPartition?.domains ?? [], nextRecord),
    ),
  );
  return {
    settings: nextSettings,
    projection: projectDesktopBrowserPersonalDomains(nextSettings, scope),
    disposition: "revoked",
  };
}

function normalizeDesktopBrowserPersonalDomains(
  value: DesktopBrowserPersonalDomainsV1 | unknown | undefined,
): DesktopBrowserPersonalDomainsV1 {
  if (value === undefined) return createEmptyDesktopBrowserPersonalDomains();
  const root = requireDesktopBrowserRecord(value, "browserPersonalDomains");
  requireExactDesktopBrowserKeys(
    root,
    ["version", "partitions"],
    "browserPersonalDomains",
  );
  if (root.version !== DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION) {
    throw new Error("Desktop Browser personal-domain settings version is invalid.");
  }
  if (!Array.isArray(root.partitions)) {
    throw new Error("browserPersonalDomains.partitions must be an array.");
  }
  const partitionKeys = new Set<string>();
  const partitions = root.partitions.map((entry, partitionIndex) => {
    const label = `browserPersonalDomains.partitions[${partitionIndex}]`;
    const partition = requireDesktopBrowserRecord(entry, label);
    requireExactDesktopBrowserKeys(
      partition,
      ["version", "accountId", "environmentId", "revision", "domains"],
      label,
    );
    if (partition.version !== DESKTOP_BROWSER_PERSONAL_DOMAIN_PARTITION_VERSION) {
      throw new Error(`${label}.version is invalid.`);
    }
    const accountId = requireDesktopBrowserText(partition.accountId, `${label}.accountId`);
    const environmentId = requireDesktopBrowserText(
      partition.environmentId,
      `${label}.environmentId`,
    );
    const partitionKey = `${accountId}\u0000${environmentId}`;
    if (partitionKeys.has(partitionKey)) {
      throw new Error("Desktop Browser personal-domain partitions must be unique.");
    }
    partitionKeys.add(partitionKey);
    if (
      typeof partition.revision !== "number" ||
      !Number.isSafeInteger(partition.revision) ||
      partition.revision < 0
    ) {
      throw new Error(`${label}.revision must be a non-negative safe integer.`);
    }
    if (!Array.isArray(partition.domains)) {
      throw new Error(`${label}.domains must be an array.`);
    }
    const domainKeys = new Set<string>();
    const domains = partition.domains.map((domain, domainIndex) => {
      const parsed = parseDesktopBrowserDomainRecord(
        domain,
        `${label}.domains[${domainIndex}]`,
      );
      if (domainKeys.has(parsed.authority.canonicalDomain)) {
        throw new Error(`${label}.domains must contain unique canonical domains.`);
      }
      domainKeys.add(parsed.authority.canonicalDomain);
      return parsed;
    });
    return {
      version: DESKTOP_BROWSER_PERSONAL_DOMAIN_PARTITION_VERSION,
      accountId,
      environmentId,
      revision: partition.revision,
      domains: domains.sort(compareDesktopBrowserDomainRecords),
    } satisfies DesktopBrowserPersonalDomainPartitionV1;
  });
  return {
    version: DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION,
    partitions: partitions.sort(compareDesktopBrowserPartitions),
  };
}

function parseDesktopBrowserDomainRecord(
  value: unknown,
  label: string,
): DesktopBrowserPersonalDomainRecordV1 {
  const record = requireDesktopBrowserRecord(value, label);
  const allowedKeys = [
    "version",
    "authority",
    "state",
    "provenance",
    "createdAt",
    "updatedAt",
    ...(record.state === "revoked" ? ["revokedAt"] : []),
  ];
  requireExactDesktopBrowserKeys(record, allowedKeys, label);
  if (record.version !== DESKTOP_BROWSER_PERSONAL_DOMAIN_RECORD_VERSION) {
    throw new Error(`${label}.version is invalid.`);
  }
  if (record.state !== "active" && record.state !== "revoked") {
    throw new Error(`${label}.state is invalid.`);
  }
  const authorityRecord = requireDesktopBrowserRecord(record.authority, `${label}.authority`);
  requireExactDesktopBrowserKeys(
    authorityRecord,
    ["version", "scheme", "canonicalDomain", "includeSubdomains", "port"],
    `${label}.authority`,
  );
  if (
    authorityRecord.version !== BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION ||
    authorityRecord.scheme !== "https" ||
    authorityRecord.includeSubdomains !== true ||
    authorityRecord.port !== 443
  ) {
    throw new Error(`${label}.authority is invalid.`);
  }
  const canonicalDomain = requireDesktopBrowserText(
    authorityRecord.canonicalDomain,
    `${label}.authority.canonicalDomain`,
  );
  const canonical = canonicalizePublicBrowserDestination(`https://${canonicalDomain}`);
  if (canonical.canonicalDomain !== canonicalDomain) {
    throw new Error(`${label}.authority.canonicalDomain is not canonical.`);
  }
  const provenanceRecord = requireDesktopBrowserRecord(
    record.provenance,
    `${label}.provenance`,
  );
  requireExactDesktopBrowserKeys(
    provenanceRecord,
    ["version", "source", "approvalId", "approvedAt"],
    `${label}.provenance`,
  );
  if (
    provenanceRecord.version !== DESKTOP_BROWSER_PERSONAL_DOMAIN_PROVENANCE_VERSION ||
    provenanceRecord.source !== "browser.request_grant"
  ) {
    throw new Error(`${label}.provenance is invalid.`);
  }
  const createdAt = requireDesktopBrowserTimestamp(record.createdAt, `${label}.createdAt`);
  const updatedAt = requireDesktopBrowserTimestamp(record.updatedAt, `${label}.updatedAt`);
  const approvedAt = requireDesktopBrowserTimestamp(
    provenanceRecord.approvedAt,
    `${label}.provenance.approvedAt`,
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt) || Date.parse(updatedAt) < Date.parse(approvedAt)) {
    throw new Error(`${label} timestamps are out of order.`);
  }
  const revokedAt = record.state === "revoked"
    ? requireDesktopBrowserTimestamp(record.revokedAt, `${label}.revokedAt`)
    : undefined;
  if (revokedAt !== undefined && revokedAt !== updatedAt) {
    throw new Error(`${label}.revokedAt must equal updatedAt.`);
  }
  return {
    version: DESKTOP_BROWSER_PERSONAL_DOMAIN_RECORD_VERSION,
    authority: canonical,
    state: record.state,
    provenance: {
      version: DESKTOP_BROWSER_PERSONAL_DOMAIN_PROVENANCE_VERSION,
      source: "browser.request_grant",
      approvalId: requireDesktopBrowserText(
        provenanceRecord.approvalId,
        `${label}.provenance.approvalId`,
      ),
      approvedAt,
    },
    createdAt,
    updatedAt,
    ...(revokedAt !== undefined ? { revokedAt } : {}),
  };
}

function parseDesktopBrowserScope(
  value: DesktopBrowserPersonalDomainScope,
): DesktopBrowserPersonalDomainScope {
  return {
    accountId: requireDesktopBrowserText(value.accountId, "accountId"),
    environmentId: requireDesktopBrowserText(value.environmentId, "environmentId"),
  };
}

function replaceDesktopBrowserPartition(
  settings: DesktopSettings,
  scope: DesktopBrowserPersonalDomainScope,
  replacement: DesktopBrowserPersonalDomainPartitionV1,
): DesktopSettings {
  return {
    ...settings,
    browserPersonalDomains: {
      version: DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION,
      partitions: [
        ...settings.browserPersonalDomains.partitions.filter(
          (partition) => !partitionMatchesScope(partition, scope),
        ),
        replacement,
      ].sort(compareDesktopBrowserPartitions),
    },
  };
}

function nextPartition(
  existing: DesktopBrowserPersonalDomainPartitionV1 | undefined,
  scope: DesktopBrowserPersonalDomainScope,
  domains: DesktopBrowserPersonalDomainRecordV1[],
): DesktopBrowserPersonalDomainPartitionV1 {
  const revision = (existing?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new Error("Desktop Browser personal-domain revision is exhausted.");
  }
  return {
    version: DESKTOP_BROWSER_PERSONAL_DOMAIN_PARTITION_VERSION,
    accountId: scope.accountId,
    environmentId: scope.environmentId,
    revision,
    domains: domains.sort(compareDesktopBrowserDomainRecords),
  };
}

function upsertDesktopBrowserDomain(
  records: readonly DesktopBrowserPersonalDomainRecordV1[],
  replacement: DesktopBrowserPersonalDomainRecordV1,
): DesktopBrowserPersonalDomainRecordV1[] {
  return [
    ...records
      .filter(
        (record) =>
          record.authority.canonicalDomain !== replacement.authority.canonicalDomain,
      )
      .map(cloneDesktopBrowserDomainRecord),
    cloneDesktopBrowserDomainRecord(replacement),
  ];
}

function cloneDesktopBrowserDomainRecord(
  record: DesktopBrowserPersonalDomainRecordV1,
): DesktopBrowserPersonalDomainRecordV1 {
  return {
    ...record,
    authority: { ...record.authority },
    provenance: { ...record.provenance },
  };
}

function partitionMatchesScope(
  partition: DesktopBrowserPersonalDomainPartitionV1,
  scope: DesktopBrowserPersonalDomainScope,
): boolean {
  return (
    partition.accountId === scope.accountId &&
    partition.environmentId === scope.environmentId
  );
}

function compareDesktopBrowserPartitions(
  left: DesktopBrowserPersonalDomainPartitionV1,
  right: DesktopBrowserPersonalDomainPartitionV1,
): number {
  return (
    left.accountId.localeCompare(right.accountId) ||
    left.environmentId.localeCompare(right.environmentId)
  );
}

function compareDesktopBrowserDomainRecords(
  left: DesktopBrowserPersonalDomainRecordV1,
  right: DesktopBrowserPersonalDomainRecordV1,
): number {
  return left.authority.canonicalDomain.localeCompare(
    right.authority.canonicalDomain,
  );
}

function requireDesktopBrowserRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactDesktopBrowserKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedKeys = new Set(expected);
  const unexpected = Object.keys(record).find((key) => !expectedKeys.has(key));
  const missing = expected.find((key) => !(key in record));
  if (unexpected !== undefined || missing !== undefined) {
    throw new Error(`${label} has invalid fields.`);
  }
}

function requireDesktopBrowserText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty canonical string.`);
  }
  return value;
}

function requireDesktopBrowserTimestamp(value: unknown, label: string): string {
  const timestamp = requireDesktopBrowserText(value, label);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
}

async function preservePreV12SettingsBackup(settingsPath: string): Promise<void> {
  let source: Buffer;
  try {
    source = await readFile(settingsPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    return;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as { version?: unknown }).version !== "number" ||
    !Number.isInteger((parsed as { version: number }).version) ||
    (parsed as { version: number }).version < 1 ||
    (parsed as { version: number }).version > 11
  ) {
    return;
  }

  const backupPath = desktopPreV12SettingsBackupPath(settingsPath);
  try {
    await writeFile(backupPath, source, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (isFileSystemError(error, "EEXIST")) {
      try {
        const existing = await stat(backupPath);
        if (!existing.isFile()) {
          throw new Error("the existing backup path is not a file");
        }
        await chmod(backupPath, 0o600);
        return;
      } catch (existingError) {
        throw new Error("Desktop could not verify its pre-v12 settings backup.", {
          cause: existingError,
        });
      }
    }
    throw new Error("Desktop could not preserve pre-v12 settings before migration.", {
      cause: error,
    });
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function normalizeDesktopOnboardingRecord(
  value: unknown,
): DesktopSettings["desktopOnboarding"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    (record.status !== "in_progress" && record.status !== "complete") ||
    typeof record.startedAt !== "string" ||
    record.startedAt.trim().length === 0
  ) {
    return;
  }
  const provider = normalizeProvider(record.provider);
  const model = normalizeOptionalSecret(record.model);
  const projectPath = normalizeOptionalSecret(record.projectPath);
  const completedAt = normalizeOptionalSecret(record.completedAt);
  const handoffId = normalizeOptionalSecret(record.handoffId);
  const handoffAcknowledgedAt =
    handoffId === undefined
      ? undefined
      : normalizeOptionalSecret(record.handoffAcknowledgedAt);
  if (record.status === "complete" && completedAt === undefined) {
    return;
  }
  return {
    version: 1,
    status: record.status,
    startedAt: record.startedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(handoffId !== undefined ? { handoffId } : {}),
    ...(handoffAcknowledgedAt !== undefined
      ? { handoffAcknowledgedAt }
      : {}),
    ...(record.provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(projectPath !== undefined ? { projectPath } : {}),
  };
}

function normalizeOptionalSecret(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeProvider(value: unknown): DesktopModelProvider {
  if (
    value === "openai" ||
    value === "anthropic" ||
    value === "openrouter" ||
    value === "ollama" ||
    value === "lmstudio"
  ) {
    return value;
  }
  return "openrouter";
}

function normalizeDatabaseMode(value: unknown): DesktopDatabaseMode {
  if (value === "default" || value === "external") {
    return value;
  }
  return "default";
}

function normalizeDesktopProjects(
  projects: readonly DesktopProjectRegistration[] | undefined,
  tombstones:
    | DesktopSettings["projectTombstones"]
    | undefined = undefined,
): DesktopProjectRegistration[] {
  if (Array.isArray(projects) === false) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: DesktopProjectRegistration[] = [];
  for (const project of projects) {
    if (typeof project?.path !== "string") {
      continue;
    }
    const trimmedPath = project.path.trim();
    if (trimmedPath.length === 0) {
      continue;
    }
    const resolvedPath = path.resolve(trimmedPath);
    if (seen.has(resolvedPath)) {
      continue;
    }
    seen.add(resolvedPath);
    normalized.push({
      id:
        typeof project.id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          project.id,
        )
          ? project.id
          : normalizeDesktopProjectTombstones(tombstones).find(
                (tombstone) => tombstone.path === resolvedPath,
              )?.id ?? randomUUID(),
      path: resolvedPath,
      label:
        typeof project.label === "string" && project.label.trim().length > 0
          ? project.label.trim()
          : path.basename(resolvedPath),
      personalAppIds: filterDesktopPersonalAppIds(
        Array.isArray(project.personalAppIds)
          ? project.personalAppIds.filter(
              (appId: unknown): appId is string => typeof appId === "string",
            )
          : [],
      ),
    });
  }
  return normalized;
}

export function preserveDesktopProjectRegistrationIds(
  currentProjects: readonly DesktopProjectRegistration[],
  nextProjects: readonly DesktopProjectRegistration[],
): DesktopProjectRegistration[] {
  const currentByPath = new Map(
    currentProjects.map((project) => [path.resolve(project.path), project]),
  );
  return nextProjects.map((project) => {
    const current = currentByPath.get(path.resolve(project.path));
    return current?.id === undefined
      ? { ...project }
      : { ...project, id: current.id };
  });
}

function normalizeDesktopProjectTombstones(
  tombstones: DesktopSettings["projectTombstones"] | undefined,
): DesktopSettings["projectTombstones"] {
  if (!Array.isArray(tombstones)) return [];
  const normalized = new Map<string, DesktopSettings["projectTombstones"][number]>();
  for (const tombstone of tombstones) {
    if (
      typeof tombstone?.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        tombstone.id,
      ) ||
      typeof tombstone.path !== "string" ||
      !tombstone.path.trim() ||
      typeof tombstone.label !== "string" ||
      !tombstone.label.trim() ||
      typeof tombstone.removedAt !== "string" ||
      Number.isNaN(Date.parse(tombstone.removedAt))
    ) {
      continue;
    }
    const resolvedPath = path.resolve(tombstone.path);
    normalized.set(resolvedPath, {
      id: tombstone.id,
      path: resolvedPath,
      label: tombstone.label.trim(),
      removedAt: new Date(tombstone.removedAt).toISOString(),
    });
  }
  return [...normalized.values()];
}

function normalizeDesktopMcpServers(
  servers: readonly DesktopMcpServerConfig[] | undefined,
): DesktopMcpServerConfig[] {
  if (Array.isArray(servers) === false) return [];
  const normalized = new Map<string, DesktopMcpServerConfig>();
  const standardAppIds = new Set<string>();
  for (const candidate of servers) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (/^[a-zA-Z0-9._-]+$/u.test(id) === false) continue;
    const name =
      typeof candidate.name === "string" && candidate.name.trim().length > 0
        ? candidate.name.trim()
        : id;
    const enabled = candidate.enabled === true;
    const tools = Array.isArray(candidate.tools)
      ? candidate.tools
          .filter(
            (tool: { name?: unknown }) =>
              typeof tool?.name === "string" && tool.name.trim().length > 0,
          )
          .map(
            (tool: {
              name: string;
              description?: unknown;
              approvalMode?: unknown;
              allowedInteractionModes?: unknown;
            }) => ({
              name: tool.name.trim(),
              ...(typeof tool.description === "string"
                ? { description: tool.description }
                : {}),
              approvalMode:
                tool.approvalMode === "auto"
                  ? ("auto" as const)
                  : ("ask" as const),
              allowedInteractionModes: Array.isArray(
                tool.allowedInteractionModes,
              )
                ? [
                    ...new Set(
                      tool.allowedInteractionModes.filter(
                        (mode): mode is "chat" | "plan" | "build" =>
                          mode === "chat" ||
                          mode === "plan" ||
                          mode === "build",
                      ),
                    ),
                  ]
                : ["build" as const],
            }),
          )
      : [];
    const credentials = Array.isArray(candidate.credentials)
      ? candidate.credentials.flatMap((raw: unknown) => {
          if (typeof raw !== "object" || raw === null) return [];
          const binding = raw as Record<string, unknown>;
          if (
            (binding.kind !== "bearer" &&
              binding.kind !== "header" &&
              binding.kind !== "environment") ||
            typeof binding.credentialId !== "string" ||
            binding.credentialId.startsWith(`mcp.${id}.`) === false ||
            typeof binding.envKey !== "string" ||
            /^[A-Za-z_][A-Za-z0-9_]*$/u.test(binding.envKey) === false
          )
            return [];
          const name =
            typeof binding.name === "string" ? binding.name : undefined;
          if (binding.kind !== "bearer" && name === undefined) return [];
          return [
            {
              kind: binding.kind,
              ...(name !== undefined ? { name } : {}),
              credentialId: binding.credentialId as `mcp.${string}`,
              envKey: binding.envKey,
              configured: binding.configured === true,
            },
          ];
        })
      : [];
    const oauthCredentialPrefix =
      typeof candidate.oauthCredentialPrefix === "string" &&
      /^mcp\.[a-zA-Z0-9._-]+$/u.test(candidate.oauthCredentialPrefix) &&
      candidate.oauthCredentialPrefix.includes(".oauth.") === false
        ? (candidate.oauthCredentialPrefix as `mcp.${string}`)
        : undefined;
    const capabilityPacks: string[] = [];
    if (Array.isArray(candidate.capabilityPacks)) {
      for (const pack of candidate.capabilityPacks as unknown[]) {
        if (
          typeof pack === "string" &&
          /^[a-zA-Z0-9._-]+$/u.test(pack) &&
          capabilityPacks.includes(pack) === false
        ) {
          capabilityPacks.push(pack);
        }
      }
    }
    if (
      candidate.transport === "stdio" &&
      typeof candidate.command === "string" &&
      candidate.command.trim().length > 0
    ) {
      normalized.set(id, {
        id,
        name,
        transport: "stdio",
        command: candidate.command.trim(),
        ...(Array.isArray(candidate.args)
          ? {
              args: candidate.args.filter(
                (arg: unknown): arg is string => typeof arg === "string",
              ),
            }
          : {}),
        enabled,
        source: "Kestrel Desktop",
        sourceKind: "desktop-managed",
        tools,
        toolCount: tools.length,
        credentials,
        ...(typeof candidate.verifiedAt === "string" &&
        Number.isNaN(Date.parse(candidate.verifiedAt)) === false
          ? { verifiedAt: new Date(candidate.verifiedAt).toISOString() }
          : {}),
      });
    } else if (
      (candidate.transport === "http" || candidate.transport === "sse") &&
      typeof candidate.url === "string"
    ) {
      try {
        const url = new URL(candidate.url.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        const standardConnection =
          typeof candidate.appId === "string"
            ? getDesktopStandardAppConnection(candidate.appId)
            : undefined;
        const appId =
          standardConnection !== undefined &&
          candidate.transport === "http" &&
          url.toString() === new URL(standardConnection.url).toString() &&
          ((standardConnection.kind === "token" &&
            credentials.length === 1 &&
            credentials[0]?.kind === "bearer" &&
            oauthCredentialPrefix === undefined) ||
            (standardConnection.kind === "authorization" &&
              credentials.length === 0 &&
              oauthCredentialPrefix === standardConnection.credentialPrefix &&
              ((standardConnection.capabilityPackScopes === undefined &&
                capabilityPacks.length === 0) ||
                (standardConnection.capabilityPackScopes !== undefined &&
                  capabilityPacks.length > 0 &&
                  capabilityPacks.every(
                    (pack) =>
                      standardConnection.capabilityPackScopes?.[pack] !==
                      undefined,
                  ))) &&
              hasDesktopStandardAppRequiredTools(
                standardConnection.appId,
                capabilityPacks,
                tools.map((tool: { name: string }) => tool.name),
              ))) &&
          standardAppIds.has(standardConnection.appId) === false
            ? standardConnection.appId
            : undefined;
        const retainedTools =
          appId === undefined
            ? tools
            : selectDesktopStandardAppTools(appId, capabilityPacks, tools);
        normalized.set(id, {
          id,
          ...(appId !== undefined ? { appId } : {}),
          name,
          transport: candidate.transport,
          url: url.toString(),
          enabled,
          source: "Kestrel Desktop",
          sourceKind: "desktop-managed",
          tools: retainedTools,
          toolCount: retainedTools.length,
          credentials,
          ...(appId !== undefined && oauthCredentialPrefix !== undefined
            ? { oauthCredentialPrefix }
            : {}),
          ...(appId !== undefined && capabilityPacks.length > 0
            ? { capabilityPacks }
            : {}),
          ...(typeof candidate.verifiedAt === "string" &&
          Number.isNaN(Date.parse(candidate.verifiedAt)) === false
            ? { verifiedAt: new Date(candidate.verifiedAt).toISOString() }
            : {}),
        });
        if (appId !== undefined) standardAppIds.add(appId);
      } catch {
        // Ignore invalid remote URLs while retaining other managed servers.
      }
    }
  }
  return [...normalized.values()];
}

function normalizeCapabilityVerifications(
  value: unknown,
): DesktopSettings["capabilityVerifications"] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const normalized: DesktopSettings["capabilityVerifications"] = {};
  for (const [id, timestamp] of Object.entries(value)) {
    if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp)))
      continue;
    normalized[id as keyof DesktopSettings["capabilityVerifications"]] =
      new Date(timestamp).toISOString();
  }
  return normalized;
}

function buildDesktopPluginInstallations(
  servers: readonly DesktopMcpServerConfig[],
  enabledBuiltIns: readonly string[],
  tavilyApiKey?: string,
): DesktopPluginInstallation[] {
  const installed = new Map<string, DesktopPluginInstallation>();
  for (const manifest of KESTREL_STANDARD_APP_MANIFESTS) {
    if (!manifest.preinstalled) continue;
    installed.set(manifest.id, {
      id: manifest.id, pluginId: manifest.id, version: manifest.version,
      installScope: "desktop", driver: "builtin", source: "included", installed: true,
      configured: true, enabled: enabledBuiltIns.includes(manifest.id),
      capabilityPacks: manifest.capabilityPacks.map((pack) => pack.key),
    });
  }
  if (tavilyApiKey?.trim()) installed.set("tavily", {
    id: "tavily", pluginId: "tavily", version: 1, installScope: "desktop", driver: "api",
    source: "standard", installed: true, configured: true, verifiedAt: undefined, enabled: true,
    capabilityPacks: ["search"], credentialIds: ["tavily"],
  });
  for (const server of servers) {
    const pluginId = server.appId ?? `custom.${server.id}`;
    installed.set(pluginId, {
      id: server.id, pluginId, version: 1, installScope: "desktop",
      driver: server.transport === "stdio" ? "mcp-stdio" : "mcp-http",
      source: server.appId === undefined ? "custom" : "standard", installed: true,
      configured: Boolean(server.verifiedAt || server.credentials?.every((binding) => binding.configured) || server.oauthCredentialPrefix),
      ...(server.verifiedAt !== undefined ? { verifiedAt: server.verifiedAt } : {}), enabled: server.enabled,
      capabilityPacks: server.capabilityPacks, credentialIds: server.credentials?.flatMap((binding) => binding.credentialId ? [binding.credentialId] : []), mcpServer: { ...server },
    });
  }
  return [...installed.values()];
}

function mergeIncludedDesktopPlugins(
  persisted: readonly DesktopPluginInstallation[],
  enabledBuiltIns: readonly string[],
): DesktopPluginInstallation[] {
  const merged = new Map(persisted.map((plugin) => [plugin.pluginId, { ...plugin }]));
  for (const included of buildDesktopPluginInstallations([], enabledBuiltIns)) {
    if (!merged.has(included.pluginId)) merged.set(included.pluginId, included);
  }
  return [...merged.values()];
}

function normalizeDesktopPluginInstallations(
  value: unknown,
): DesktopPluginInstallation[] | undefined {
  if (!Array.isArray(value)) return;
  const plugins = new Map<string, DesktopPluginInstallation>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const plugin = candidate as Partial<DesktopPluginInstallation>;
    const version = plugin.version;
    if (typeof plugin.id !== "string" || typeof plugin.pluginId !== "string" ||
      typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 ||
      plugin.installScope !== "desktop" ||
      !["builtin", "cli", "mcp-stdio", "mcp-http", "api"].includes(plugin.driver ?? "") ||
      !["included", "standard", "custom"].includes(plugin.source ?? "") ||
      typeof plugin.installed !== "boolean" || typeof plugin.configured !== "boolean" || typeof plugin.enabled !== "boolean") continue;
    const mcpServer = plugin.mcpServer === undefined
      ? undefined
      : normalizeDesktopMcpServers([plugin.mcpServer])[0];
    plugins.set(plugin.pluginId, {
      id: plugin.id, pluginId: plugin.pluginId, version,
      installScope: "desktop", driver: plugin.driver!, source: plugin.source!,
      installed: plugin.installed, configured: plugin.configured, enabled: plugin.enabled,
      ...(typeof plugin.verifiedAt === "string" && !Number.isNaN(Date.parse(plugin.verifiedAt))
        ? { verifiedAt: new Date(plugin.verifiedAt).toISOString() } : {}),
      ...(Array.isArray(plugin.capabilityPacks) ? { capabilityPacks: plugin.capabilityPacks.filter((pack): pack is string => typeof pack === "string") } : {}),
      ...(Array.isArray(plugin.credentialIds) ? { credentialIds: plugin.credentialIds.filter((id): id is string => typeof id === "string") } : {}),
      ...(mcpServer !== undefined ? { mcpServer } : {}),
    });
  }
  return [...plugins.values()];
}

function toRuntimeMcpServer(server: DesktopMcpServerConfig): McpServerConfig {
  const toolMetadata = Object.fromEntries(
    (server.tools ?? []).map((tool) => [
      tool.name,
      {
        displayName: tool.name,
        aliases: [],
        keywords: [],
        provider: server.name,
        toolFamily: "mcp",
        capabilityClasses: ["mcp.invoke"],
        approvalMode: tool.approvalMode ?? "ask",
        allowedInteractionModes: tool.allowedInteractionModes ?? ["build"],
      },
    ]),
  );
  if (server.transport === "stdio") {
    return {
      id: server.id,
      transport: "stdio",
      command: server.command!,
      ...(server.args !== undefined ? { args: [...server.args] } : {}),
      enabled: true,
      ...(Object.keys(toolMetadata).length > 0 ? { toolMetadata } : {}),
    };
  }
  const bearer = server.credentials?.find(
    (binding) => binding.kind === "bearer",
  );
  const headers =
    server.credentials?.filter((binding) => binding.kind === "header") ?? [];
  return {
    id: server.id,
    transport: server.transport,
    url: server.url!,
    enabled: true,
    ...(server.oauthCredentialPrefix !== undefined
      ? { oauthCredentialPrefix: server.oauthCredentialPrefix }
      : {}),
    ...(bearer !== undefined ? { authTokenEnv: bearer.envKey } : {}),
    ...(headers.length > 0
      ? {
          headerEnvs: Object.fromEntries(
            headers.map((binding) => [binding.name!, binding.envKey]),
          ),
        }
      : {}),
    ...(Object.keys(toolMetadata).length > 0 ? { toolMetadata } : {}),
  };
}
