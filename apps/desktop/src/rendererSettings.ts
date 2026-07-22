import { hasConfiguredDesktopProviderCredential } from "../../../src/desktopShell/onboarding.js";
import {
  desktopAppIdForServer,
  listDesktopAppDefinitions,
} from "../../../src/desktopShell/configuration.js";
import type {
  DesktopRendererSettings,
  DesktopSettings,
} from "./contracts.js";

export function toDesktopRendererSettings(
  settings: DesktopSettings,
  configuredProviders: ReadonlySet<DesktopSettings["selectedProvider"]> = new Set(
    hasConfiguredDesktopProviderCredential(settings) ? [settings.selectedProvider] : [],
  ),
): DesktopRendererSettings {
  const providers: DesktopSettings["selectedProvider"][] = [
    "openrouter", "openai", "anthropic", "ollama", "lmstudio",
  ];
  return {
    selectedProvider: settings.selectedProvider,
    databaseMode: settings.databaseMode,
    presetId: settings.presetId,
    capabilityPacks: [...settings.capabilityPacks],
    projects: settings.projects.map((project) => ({ ...project })),
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
    defaultEnabledAppIds: [
      ...new Set([
        ...settings.defaultEnabledAppIds,
        ...settings.mcpServers
          .filter((server) => server.enabled)
          .map((server) => desktopAppIdForServer(server)),
      ]),
    ],
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
