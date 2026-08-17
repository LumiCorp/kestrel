import { hasConfiguredDesktopProviderCredential } from "../../../src/desktopShell/onboarding.js";
import {
  desktopAppIdForServer,
  listDesktopAppDefinitions,
} from "../../../src/desktopShell/configuration.js";
import { KESTREL_APP_IDS } from "@kestrel-agents/protocol";
import type {
  DesktopRendererSettings,
  DesktopSettings,
} from "./contracts.js";

export function getEffectiveDesktopEnabledAppIds(
  settings: Pick<DesktopSettings, "defaultEnabledBuiltInAppIds" | "mcpServers" | "tavilyApiKey">,
): string[] {
  return [
    ...new Set([
      ...settings.defaultEnabledBuiltInAppIds,
      ...(settings.tavilyApiKey?.trim() ? [KESTREL_APP_IDS.TAVILY] : []),
      ...settings.mcpServers
        .filter((server) => server.enabled)
        .map((server) => desktopAppIdForServer(server)),
    ]),
  ];
}

export function toDesktopRendererSettings(
  settings: DesktopSettings,
  configuredProviders: ReadonlySet<DesktopSettings["selectedProvider"]> = new Set(
    hasConfiguredDesktopProviderCredential(settings) ? [settings.selectedProvider] : [],
  ),
): DesktopRendererSettings {
  const providers: DesktopSettings["selectedProvider"][] = [
    "openrouter", "openai", "anthropic", "ollama", "lmstudio",
  ];
  const defaultProjectPath =
    settings.desktopOnboarding?.status === "complete" &&
    settings.desktopOnboarding.projectPath !== undefined &&
    settings.projects.some(
      (project) => project.path === settings.desktopOnboarding?.projectPath,
    )
      ? settings.desktopOnboarding.projectPath
      : undefined;
  return {
    selectedProvider: settings.selectedProvider,
    databaseMode: settings.databaseMode,
    presetId: settings.presetId,
    capabilityPacks: [...settings.capabilityPacks],
    projects: settings.projects.map((project) => ({ ...project })),
    ...(defaultProjectPath !== undefined ? { defaultProjectPath } : {}),
    ...(settings.providerSelectionCompletedAt !== undefined
      ? { providerSelectionCompletedAt: settings.providerSelectionCompletedAt }
      : {}),
    ...(settings.setupCompletedAt !== undefined
      ? { setupCompletedAt: settings.setupCompletedAt }
      : {}),
    advancedWorkspaceEnabled: settings.advancedWorkspaceEnabled,
    modelConfigurations: settings.modelConfigurations.map((configuration) => ({
      ...configuration,
      revisions: configuration.revisions.map((revision) => ({
        ...revision,
        policy: {
          ...revision.policy,
          modelByStage: { ...revision.policy.modelByStage },
          modelCapabilities: { ...revision.policy.modelCapabilities },
        },
      })),
    })),
    defaultModelConfigurationId: settings.defaultModelConfigurationId,
    defaultEnabledBuiltInAppIds: [...settings.defaultEnabledBuiltInAppIds],
    ...(settings.legacyDefaultWorkflowAppIds !== undefined
      ? { legacyDefaultWorkflowAppIds: [...settings.legacyDefaultWorkflowAppIds] }
      : {}),
    enabledConnectedAppIds: getEffectiveDesktopEnabledAppIds(settings).filter(
      (id) => !settings.defaultEnabledBuiltInAppIds.includes(id),
    ),
    appearanceTheme: settings.appearanceTheme,
    apps: listDesktopAppDefinitions(settings.mcpServers),
    providerReadiness: providers.map((provider) => ({
      provider,
      requiresCredential: provider !== "ollama" && provider !== "lmstudio",
      configured:
        provider === "ollama" || provider === "lmstudio" || configuredProviders.has(provider),
    })),
  };
}
