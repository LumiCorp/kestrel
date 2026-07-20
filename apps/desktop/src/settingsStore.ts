import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import {
  createDesktopModelConfiguration,
  DESKTOP_DEFAULT_MODEL_CONFIGURATION_ID,
  DESKTOP_WEATHER_APP_ID,
  getDesktopAppDefinition,
  parseDesktopModelConfigurations,
} from "../../../src/desktopShell/configuration.js";
import { createWebDemoProfile } from "../../../src/web/profile.js";
import type {
  DesktopCapabilityPackId,
  DesktopDatabaseMode,
  DesktopModelProvider,
  DesktopProjectRegistration,
  DesktopSettings,
} from "./contracts.js";

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
  advancedWorkspaceEnabled?: boolean | undefined;
  modelConfigurations?: DesktopSettings["modelConfigurations"] | undefined;
  defaultModelConfigurationId?: string | undefined;
  defaultEnabledAppIds?: string[] | undefined;
  appearanceTheme?: DesktopSettings["appearanceTheme"] | undefined;
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

const LEGACY_SETUP_COMPLETED_AT = "1970-01-01T00:00:00.000Z";
const LEGACY_PROVIDER_SELECTION_COMPLETED_AT = "1970-01-01T00:00:00.000Z";
const DESKTOP_PRESET_CAPABILITY_PACKS: DesktopCapabilityPackId[] = [
  "balanced",
  "filesystem",
  "dev_shell",
  "desktop_host",
  "sandbox_code",
];

function normalizeDesktopCapabilityPacks(
  capabilityPacks: readonly DesktopCapabilityPackId[] | undefined,
): DesktopCapabilityPackId[] {
  const next = new Set<DesktopCapabilityPackId>();
  const source = capabilityPacks ?? DESKTOP_PRESET_CAPABILITY_PACKS;
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
  return next.size > 0 ? [...next] : [...DESKTOP_PRESET_CAPABILITY_PACKS];
}

export function createDefaultDesktopSettings(
  fallbackModelPolicy: ModelPolicyV1 = createDefaultModelPolicy(),
): DesktopSettings {
  return {
    selectedProvider: "openrouter",
    databaseMode: "default",
    presetId: "desktop_dev_local",
    capabilityPacks: [...DESKTOP_PRESET_CAPABILITY_PACKS],
    projects: [],
    advancedWorkspaceEnabled: false,
    modelConfigurations: [createDesktopModelConfiguration(fallbackModelPolicy)],
    defaultModelConfigurationId: DESKTOP_DEFAULT_MODEL_CONFIGURATION_ID,
    defaultEnabledAppIds: [DESKTOP_WEATHER_APP_ID],
    appearanceTheme: "system",
  };
}

export function hasConfiguredDesktopProviderCredential(settings: DesktopSettings): boolean {
  return sharedHasConfiguredDesktopProviderCredential(settings);
}

export function describeDesktopProviderCredentialRequirement(
  settings: DesktopSettings,
): string | undefined {
  return describeDesktopProviderRequirement(settings)?.detail;
}

export function normalizeDesktopSettings(
  settings: Partial<DesktopSettings> | undefined,
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
  const openrouterBaseUrl = normalizeOptionalSecret(settings?.openrouterBaseUrl);
  const openrouterSiteUrl = normalizeOptionalSecret(settings?.openrouterSiteUrl);
  const openrouterAppName = normalizeOptionalSecret(settings?.openrouterAppName);
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
  const nextSetupCompletedAt = typeof settings?.setupCompletedAt === "string" && settings.setupCompletedAt.trim().length > 0
    ? settings.setupCompletedAt
    : options.legacySetupCompletedFromKeys === true && hasAnyKey
      ? LEGACY_SETUP_COMPLETED_AT
      : undefined;
  const nextProviderSelectionCompletedAt =
    providerSelectionCompletedAt ??
    (options.backfillProviderSelection === true &&
    (
      nextSetupCompletedAt !== undefined ||
      normalizeDesktopProjects(settings?.projects).length > 0 ||
      hasLegacyHostedProviderKey ||
      hasProviderSpecificOverrides ||
      selectedProvider !== "openrouter"
    )
      ? LEGACY_PROVIDER_SELECTION_COMPLETED_AT
      : undefined);
  let modelConfigurations: DesktopSettings["modelConfigurations"];
  try {
    modelConfigurations = settings?.modelConfigurations === undefined
      ? [createDesktopModelConfiguration(options.fallbackModelPolicy ?? createDefaultModelPolicy())]
      : parseDesktopModelConfigurations(settings.modelConfigurations);
  } catch {
    modelConfigurations = [createDesktopModelConfiguration(options.fallbackModelPolicy ?? createDefaultModelPolicy())];
  }
  const requestedDefaultConfigurationId = typeof settings?.defaultModelConfigurationId === "string"
    ? settings.defaultModelConfigurationId.trim()
    : "";
  const defaultModelConfigurationId = modelConfigurations.some(
    (configuration) => configuration.id === requestedDefaultConfigurationId && configuration.archivedAt === undefined,
  )
    ? requestedDefaultConfigurationId
    : modelConfigurations.find((configuration) => configuration.archivedAt === undefined)?.id
      ?? modelConfigurations[0]!.id;
  const defaultEnabledAppIds = Array.isArray(settings?.defaultEnabledAppIds)
    ? [...new Set(settings.defaultEnabledAppIds.filter(
        (id): id is string => typeof id === "string" && getDesktopAppDefinition(id.trim()) !== undefined,
      ).map((id) => id.trim()))].sort()
    : [DESKTOP_WEATHER_APP_ID];
  const appearanceTheme = settings?.appearanceTheme === "light" || settings?.appearanceTheme === "dark"
    ? settings.appearanceTheme
    : "system";

  return {
    selectedProvider,
    databaseMode,
    presetId: "desktop_dev_local",
    capabilityPacks: normalizeDesktopCapabilityPacks(settings?.capabilityPacks),
    projects: normalizeDesktopProjects(settings?.projects),
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
    ...(nextSetupCompletedAt !== undefined ? { setupCompletedAt: nextSetupCompletedAt } : {}),
    advancedWorkspaceEnabled:
      typeof settings?.advancedWorkspaceEnabled === "boolean"
        ? settings.advancedWorkspaceEnabled
        : options.legacyAdvancedWorkspaceEnabled === true,
    modelConfigurations,
    defaultModelConfigurationId,
    defaultEnabledAppIds,
    appearanceTheme,
  };
}

export function buildDesktopRunnerProfile(modelPolicy: ResolvedModelPolicy) {
  return resolveProfileWithModelPolicy(
    createWebDemoProfile("desktop"),
    modelPolicy,
  );
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
  if (typeof options.databaseUrl === "string" && options.databaseUrl.trim().length > 0) {
    env.DATABASE_URL = options.databaseUrl;
    env.KESTREL_DATABASE_URL_SOURCE = options.databaseUrlSource ?? "environment";
  } else if (settings.databaseMode === "external") {
    delete env.DATABASE_URL;
    env.KESTREL_DATABASE_URL_SOURCE = "desktop_external";
  } else {
    applyKestrelLocalEnvDefaults(env);
    env.KESTREL_DATABASE_URL_SOURCE = "desktop_default";
  }
  return env;
}

export async function readDesktopSettings(settingsPath: string): Promise<DesktopSettings> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version === 1) {
      return normalizeDesktopSettings(
        {
          selectedProvider: "openrouter",
          openrouterApiKey: typeof parsed.openrouterApiKey === "string" ? parsed.openrouterApiKey : undefined,
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
      parsed.version !== 9 && parsed.version !== 10
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
    const databaseUrl = typeof parsed.databaseUrl === "string" ? parsed.databaseUrl : undefined;
    const openrouterApiKey = typeof parsed.openrouterApiKey === "string" ? parsed.openrouterApiKey : undefined;
    const openrouterModel = typeof parsed.openrouterModel === "string" ? parsed.openrouterModel : undefined;
    const openrouterBaseUrl = typeof parsed.openrouterBaseUrl === "string" ? parsed.openrouterBaseUrl : undefined;
    const openrouterSiteUrl = typeof parsed.openrouterSiteUrl === "string" ? parsed.openrouterSiteUrl : undefined;
    const openrouterAppName = typeof parsed.openrouterAppName === "string" ? parsed.openrouterAppName : undefined;
    const openaiApiKey = typeof parsed.openaiApiKey === "string" ? parsed.openaiApiKey : undefined;
    const openaiModel = typeof parsed.openaiModel === "string" ? parsed.openaiModel : undefined;
    const openaiBaseUrl = typeof parsed.openaiBaseUrl === "string" ? parsed.openaiBaseUrl : undefined;
    const openaiOrgId = typeof parsed.openaiOrgId === "string" ? parsed.openaiOrgId : undefined;
    const openaiProjectId = typeof parsed.openaiProjectId === "string" ? parsed.openaiProjectId : undefined;
    const anthropicApiKey = typeof parsed.anthropicApiKey === "string" ? parsed.anthropicApiKey : undefined;
    const anthropicModel = typeof parsed.anthropicModel === "string" ? parsed.anthropicModel : undefined;
    const anthropicBaseUrl = typeof parsed.anthropicBaseUrl === "string" ? parsed.anthropicBaseUrl : undefined;
    const anthropicVersion = typeof parsed.anthropicVersion === "string" ? parsed.anthropicVersion : undefined;
    const ollamaModel = typeof parsed.ollamaModel === "string" ? parsed.ollamaModel : undefined;
    const ollamaBaseUrl = typeof parsed.ollamaBaseUrl === "string" ? parsed.ollamaBaseUrl : undefined;
    const lmstudioModel = typeof parsed.lmstudioModel === "string" ? parsed.lmstudioModel : undefined;
    const lmstudioBaseUrl = typeof parsed.lmstudioBaseUrl === "string" ? parsed.lmstudioBaseUrl : undefined;
    const tavilyApiKey = typeof parsed.tavilyApiKey === "string" ? parsed.tavilyApiKey : undefined;
    const tavilyBaseUrl = typeof parsed.tavilyBaseUrl === "string" ? parsed.tavilyBaseUrl : undefined;
    const tavilyProject = typeof parsed.tavilyProject === "string" ? parsed.tavilyProject : undefined;
    const tavilyHttpProxy = typeof parsed.tavilyHttpProxy === "string" ? parsed.tavilyHttpProxy : undefined;
    const tavilyHttpsProxy = typeof parsed.tavilyHttpsProxy === "string" ? parsed.tavilyHttpsProxy : undefined;
    const providerSelectionCompletedAt =
      typeof parsed.providerSelectionCompletedAt === "string"
        ? parsed.providerSelectionCompletedAt
        : undefined;
    const setupCompletedAt = typeof parsed.setupCompletedAt === "string" ? parsed.setupCompletedAt : undefined;
    const advancedWorkspaceEnabled =
      parsed.advancedWorkspaceEnabled === true || parsed.advancedWorkspaceEnabled === false
        ? parsed.advancedWorkspaceEnabled
        : undefined;
    const modelConfigurations = parsed.version === 10 && Array.isArray(parsed.modelConfigurations)
      ? parsed.modelConfigurations
      : undefined;
    const defaultModelConfigurationId = parsed.version === 10 && typeof parsed.defaultModelConfigurationId === "string"
      ? parsed.defaultModelConfigurationId
      : undefined;
    const defaultEnabledAppIds = parsed.version === 10 && Array.isArray(parsed.defaultEnabledAppIds)
      ? parsed.defaultEnabledAppIds
      : undefined;
    const appearanceTheme = parsed.version === 10
      && (parsed.appearanceTheme === "system" || parsed.appearanceTheme === "light" || parsed.appearanceTheme === "dark")
      ? parsed.appearanceTheme
      : undefined;
    const presetId = parsed.presetId === "desktop_dev_local" ? parsed.presetId : undefined;
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
    const projects = Array.isArray(parsed.projects) ? normalizeDesktopProjects(parsed.projects) : undefined;
    return normalizeDesktopSettings({
      ...(presetId !== undefined ? { presetId } : {}),
      ...(capabilityPacks !== undefined ? { capabilityPacks } : {}),
      ...(projects !== undefined ? { projects } : {}),
      ...(selectedProvider !== undefined ? { selectedProvider } : {}),
      ...(databaseMode !== undefined ? { databaseMode } : {}),
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
      ...(providerSelectionCompletedAt !== undefined
        ? { providerSelectionCompletedAt }
        : {}),
      ...(setupCompletedAt !== undefined ? { setupCompletedAt } : {}),
      ...(advancedWorkspaceEnabled !== undefined ? { advancedWorkspaceEnabled } : {}),
      ...(modelConfigurations !== undefined ? { modelConfigurations } : {}),
      ...(defaultModelConfigurationId !== undefined ? { defaultModelConfigurationId } : {}),
      ...(defaultEnabledAppIds !== undefined ? { defaultEnabledAppIds } : {}),
      ...(appearanceTheme !== undefined ? { appearanceTheme } : {}),
    }, {
      backfillProviderSelection: parsed.version !== 9 && parsed.version !== 10,
    });
  } catch {
    return createDefaultDesktopSettings();
  }
}

export async function writeDesktopSettings(settingsPath: string, settings: DesktopSettings): Promise<DesktopSettings> {
  const normalized = normalizeDesktopSettings(settings);
  const payload: DesktopSettingsFileV10 = {
    version: 10,
    selectedProvider: normalized.selectedProvider,
    databaseMode: normalized.databaseMode,
    presetId: normalized.presetId,
    capabilityPacks: [...normalized.capabilityPacks],
    projects: [...normalized.projects],
    ...(normalized.databaseUrl !== undefined ? { databaseUrl: normalized.databaseUrl } : {}),
    ...(normalized.openrouterApiKey !== undefined ? { openrouterApiKey: normalized.openrouterApiKey } : {}),
    ...(normalized.openrouterModel !== undefined ? { openrouterModel: normalized.openrouterModel } : {}),
    ...(normalized.openrouterBaseUrl !== undefined ? { openrouterBaseUrl: normalized.openrouterBaseUrl } : {}),
    ...(normalized.openrouterSiteUrl !== undefined ? { openrouterSiteUrl: normalized.openrouterSiteUrl } : {}),
    ...(normalized.openrouterAppName !== undefined ? { openrouterAppName: normalized.openrouterAppName } : {}),
    ...(normalized.openaiApiKey !== undefined ? { openaiApiKey: normalized.openaiApiKey } : {}),
    ...(normalized.openaiModel !== undefined ? { openaiModel: normalized.openaiModel } : {}),
    ...(normalized.openaiBaseUrl !== undefined ? { openaiBaseUrl: normalized.openaiBaseUrl } : {}),
    ...(normalized.openaiOrgId !== undefined ? { openaiOrgId: normalized.openaiOrgId } : {}),
    ...(normalized.openaiProjectId !== undefined ? { openaiProjectId: normalized.openaiProjectId } : {}),
    ...(normalized.anthropicApiKey !== undefined ? { anthropicApiKey: normalized.anthropicApiKey } : {}),
    ...(normalized.anthropicModel !== undefined ? { anthropicModel: normalized.anthropicModel } : {}),
    ...(normalized.anthropicBaseUrl !== undefined ? { anthropicBaseUrl: normalized.anthropicBaseUrl } : {}),
    ...(normalized.anthropicVersion !== undefined ? { anthropicVersion: normalized.anthropicVersion } : {}),
    ...(normalized.ollamaModel !== undefined ? { ollamaModel: normalized.ollamaModel } : {}),
    ...(normalized.ollamaBaseUrl !== undefined ? { ollamaBaseUrl: normalized.ollamaBaseUrl } : {}),
    ...(normalized.lmstudioModel !== undefined ? { lmstudioModel: normalized.lmstudioModel } : {}),
    ...(normalized.lmstudioBaseUrl !== undefined ? { lmstudioBaseUrl: normalized.lmstudioBaseUrl } : {}),
    ...(normalized.tavilyApiKey !== undefined ? { tavilyApiKey: normalized.tavilyApiKey } : {}),
    ...(normalized.tavilyBaseUrl !== undefined ? { tavilyBaseUrl: normalized.tavilyBaseUrl } : {}),
    ...(normalized.tavilyProject !== undefined ? { tavilyProject: normalized.tavilyProject } : {}),
    ...(normalized.tavilyHttpProxy !== undefined ? { tavilyHttpProxy: normalized.tavilyHttpProxy } : {}),
    ...(normalized.tavilyHttpsProxy !== undefined ? { tavilyHttpsProxy: normalized.tavilyHttpsProxy } : {}),
    ...(normalized.providerSelectionCompletedAt !== undefined
      ? { providerSelectionCompletedAt: normalized.providerSelectionCompletedAt }
      : {}),
    ...(normalized.setupCompletedAt !== undefined ? { setupCompletedAt: normalized.setupCompletedAt } : {}),
    advancedWorkspaceEnabled: normalized.advancedWorkspaceEnabled,
    modelConfigurations: normalized.modelConfigurations,
    defaultModelConfigurationId: normalized.defaultModelConfigurationId,
    defaultEnabledAppIds: normalized.defaultEnabledAppIds,
    appearanceTheme: normalized.appearanceTheme,
  };
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return normalized;
}

function normalizeOptionalSecret(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
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
      path: resolvedPath,
      label:
        typeof project.label === "string" && project.label.trim().length > 0
          ? project.label.trim()
          : path.basename(resolvedPath),
    });
  }
  return normalized;
}
