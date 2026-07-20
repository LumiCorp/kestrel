import {
  getDesktopCapabilityRegistration,
  type DesktopCapabilityRegistration,
} from "../../../src/desktopShell/capabilityRegistry.js";
import type { LocalCoreCredentialId } from "../../../src/localCore/credentialStore.js";
import type { ModelPolicyV1 } from "../../../src/profile/modelPolicy.js";
import { DEFAULT_MODEL_BY_PROVIDER, type ModelProviderId } from "../../../src/profile/runtimeProfile.js";
import type {
  DesktopCapabilityConfigurationInput,
  DesktopCapabilityPackId,
  DesktopSettings,
} from "./contracts.js";

export interface DesktopCapabilityConfigurationPlan {
  registration: DesktopCapabilityRegistration;
  settings: DesktopSettings;
  modelPolicy: ModelPolicyV1;
  credential?: { id: LocalCoreCredentialId; value: string | null } | undefined;
  requiresVerification: boolean;
  restartRuntime: boolean;
}

export function buildDesktopCapabilityConfigurationPlan(input: {
  currentSettings: DesktopSettings;
  currentModelPolicy: ModelPolicyV1;
  configuration: DesktopCapabilityConfigurationInput;
}): DesktopCapabilityConfigurationPlan {
  const registration = getDesktopCapabilityRegistration(input.configuration.capabilityId);
  validateSettingKeys(registration, input.configuration.settings);
  let settings: DesktopSettings = structuredClone(input.currentSettings);
  let modelPolicy: ModelPolicyV1 = structuredClone(input.currentModelPolicy);

  if (registration.modelProvider !== undefined) {
    ({ settings, modelPolicy } = applyModelConfiguration({
      settings,
      modelPolicy,
      provider: registration.modelProvider,
      configuration: input.configuration,
    }));
  } else if (input.configuration.capabilityId === "tools.internet.tavily") {
    settings = applyTavilyConfiguration(settings, input.configuration.settings);
  } else if (input.configuration.capabilityId === "data.database") {
    settings = applyDatabaseMode(settings, input.configuration.settings);
  } else if (input.configuration.capabilityId === "local.developer_shell") {
    settings = applyDeveloperShellConfiguration(settings, input.configuration.settings);
  }

  if (supportsPackToggle(input.configuration.capabilityId)) {
    settings = applyCapabilityPackToggle(settings, registration, input.configuration.enabled);
  } else if (input.configuration.enabled !== undefined && registration.modelProvider === undefined) {
    throw new Error(`Capability '${registration.id}' does not support direct enablement.`);
  }

  const credential = input.configuration.credential !== undefined
    ? registration.credentialId !== undefined
      ? { id: registration.credentialId, value: input.configuration.credential }
      : (() => { throw new Error(`Capability '${registration.id}' does not accept a credential.`); })()
    : undefined;
  const hasConfigurationChange = input.configuration.enabled !== undefined
    || Object.keys(input.configuration.settings ?? {}).length > 0;
  const verificationNeedsCredential = registration.verification === "hosted_model"
    || registration.verification === "tavily"
    || (registration.verification === "external_database" && settings.databaseMode === "external");
  if (
    hasConfigurationChange
    && verificationNeedsCredential
    && input.configuration.credential === undefined
  ) {
    throw new Error("Re-enter the credential so Desktop can verify the complete replacement configuration before applying it.");
  }
  const verificationApplies = registration.verification !== "external_database"
    || settings.databaseMode === "external";
  const requiresVerification = input.configuration.credential !== null
    && registration.verification !== "none"
    && verificationApplies
    && (input.configuration.credential !== undefined || hasConfigurationChange);

  return {
    registration,
    settings,
    modelPolicy,
    ...(credential !== undefined ? { credential } : {}),
    requiresVerification,
    restartRuntime: registration.restartRuntime,
  };
}

function validateSettingKeys(
  registration: DesktopCapabilityRegistration,
  settings: DesktopCapabilityConfigurationInput["settings"],
): void {
  const supported = new Set(registration.settingKeys);
  const unsupported = Object.keys(settings ?? {}).find((key) => supported.has(key) === false);
  if (unsupported !== undefined) {
    throw new Error(`Capability '${registration.id}' does not support setting '${unsupported}'.`);
  }
}

function applyModelConfiguration(input: {
  settings: DesktopSettings;
  modelPolicy: ModelPolicyV1;
  provider: ModelProviderId;
  configuration: DesktopCapabilityConfigurationInput;
}): { settings: DesktopSettings; modelPolicy: ModelPolicyV1 } {
  if (input.configuration.enabled === false && input.settings.selectedProvider === input.provider) {
    throw new Error("The active model provider cannot be disabled until another provider is enabled.");
  }
  const values = input.configuration.settings;
  const model = readStringSetting(values, "model")
    ?? providerModel(input.settings, input.provider)
    ?? DEFAULT_MODEL_BY_PROVIDER[input.provider];
  let settings: DesktopSettings = {
    ...input.settings,
    ...(input.configuration.enabled === true ? { selectedProvider: input.provider } : {}),
  };
  if (input.provider === "openrouter") {
    settings = {
      ...settings,
      openrouterModel: model,
      ...settingPatch(values, "baseUrl", "openrouterBaseUrl"),
      ...settingPatch(values, "siteUrl", "openrouterSiteUrl"),
      ...settingPatch(values, "appName", "openrouterAppName"),
    };
  } else if (input.provider === "openai") {
    settings = {
      ...settings,
      openaiModel: model,
      ...settingPatch(values, "baseUrl", "openaiBaseUrl"),
      ...settingPatch(values, "organizationId", "openaiOrgId"),
      ...settingPatch(values, "projectId", "openaiProjectId"),
    };
  } else if (input.provider === "anthropic") {
    settings = {
      ...settings,
      anthropicModel: model,
      ...settingPatch(values, "baseUrl", "anthropicBaseUrl"),
      ...settingPatch(values, "apiVersion", "anthropicVersion"),
    };
  } else if (input.provider === "ollama") {
    settings = { ...settings, ollamaModel: model, ...settingPatch(values, "baseUrl", "ollamaBaseUrl") };
  } else {
    settings = { ...settings, lmstudioModel: model, ...settingPatch(values, "baseUrl", "lmstudioBaseUrl") };
  }
  const shouldApplyPolicy = input.configuration.enabled === true
    || input.modelPolicy.provider === input.provider;
  return {
    settings,
    modelPolicy: shouldApplyPolicy
      ? { ...input.modelPolicy, provider: input.provider, model }
      : input.modelPolicy,
  };
}

function applyTavilyConfiguration(
  settings: DesktopSettings,
  values: DesktopCapabilityConfigurationInput["settings"],
): DesktopSettings {
  return {
    ...settings,
    ...settingPatch(values, "baseUrl", "tavilyBaseUrl"),
    ...settingPatch(values, "projectId", "tavilyProject"),
    ...settingPatch(values, "httpProxy", "tavilyHttpProxy"),
    ...settingPatch(values, "httpsProxy", "tavilyHttpsProxy"),
  };
}

function applyDatabaseMode(
  settings: DesktopSettings,
  values: DesktopCapabilityConfigurationInput["settings"],
): DesktopSettings {
  const mode = values?.mode;
  if (mode === undefined) return settings;
  if (mode !== "default" && mode !== "external") throw new Error("Desktop database mode is invalid.");
  return { ...settings, databaseMode: mode };
}

function applyDeveloperShellConfiguration(
  settings: DesktopSettings,
  values: DesktopCapabilityConfigurationInput["settings"],
): DesktopSettings {
  const shellPath = readStringSetting(values, "shellPath");
  const developerPath = readStringSetting(values, "path");
  const envMode = values?.envMode;
  const approvalPolicy = values?.approvalPolicy;
  if (envMode !== undefined && envMode !== "inherit" && envMode !== "allowlist") throw new Error("Developer shell environment policy is invalid.");
  if (approvalPolicy !== undefined && approvalPolicy !== "dev" && approvalPolicy !== "production" && approvalPolicy !== "ci_bot") throw new Error("Developer shell approval policy is invalid.");
  const allowedEnvNames = readStringSetting(values, "allowedEnvNames")
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0) ?? settings.developerShellAllowedEnvNames;
  if (allowedEnvNames.some((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) === false)) throw new Error("Developer shell allowed environment names are invalid.");
  return {
    ...settings,
    developerShellPath: shellPath,
    developerPath,
    developerShellEnvMode: envMode ?? settings.developerShellEnvMode,
    developerShellAllowedEnvNames: [...new Set(allowedEnvNames)].sort(),
    approvalPolicyPackId: approvalPolicy ?? settings.approvalPolicyPackId,
  };
}

function supportsPackToggle(id: DesktopCapabilityConfigurationInput["capabilityId"]): boolean {
  return id === "tools.network.free"
    || id === "local.filesystem"
    || id === "local.developer_shell"
    || id === "local.sandbox_code";
}

function applyCapabilityPackToggle(
  settings: DesktopSettings,
  registration: DesktopCapabilityRegistration,
  enabled: boolean | undefined,
): DesktopSettings {
  if (enabled === undefined) return settings;
  const pack = registration.capabilityPack;
  if (pack === undefined) throw new Error(`Capability '${registration.id}' has no capability pack.`);
  const next = new Set<DesktopCapabilityPackId>(settings.capabilityPacks);
  if (enabled) next.add(pack);
  else next.delete(pack);
  return { ...settings, capabilityPacks: [...next] };
}

function settingPatch<K extends keyof DesktopSettings>(
  values: DesktopCapabilityConfigurationInput["settings"],
  inputKey: string,
  outputKey: K,
): Partial<DesktopSettings> {
  if (values === undefined || Object.hasOwn(values, inputKey) === false) return {};
  const value = readStringSetting(values, inputKey);
  return { [outputKey]: value } as Partial<DesktopSettings>;
}

function readStringSetting(
  values: DesktopCapabilityConfigurationInput["settings"],
  key: string,
): string | undefined {
  const value = values?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Capability setting '${key}' must be text.`);
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function providerModel(settings: DesktopSettings, provider: ModelProviderId): string | undefined {
  if (provider === "openrouter") return settings.openrouterModel;
  if (provider === "openai") return settings.openaiModel;
  if (provider === "anthropic") return settings.anthropicModel;
  if (provider === "ollama") return settings.ollamaModel;
  return settings.lmstudioModel;
}
