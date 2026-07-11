import { hasConfiguredDesktopProviderCredential } from "../../../src/desktopShell/onboarding.js";
import type {
  DesktopRendererSettings,
  DesktopSettings,
} from "./contracts.js";

export function toDesktopRendererSettings(
  settings: DesktopSettings,
): DesktopRendererSettings {
  return {
    selectedProvider: settings.selectedProvider,
    databaseMode: settings.databaseMode,
    presetId: settings.presetId,
    capabilityPacks: [...settings.capabilityPacks],
    projects: settings.projects.map((project) => ({ ...project })),
    providerCredentialConfigured: hasConfiguredDesktopProviderCredential(settings),
    ...(settings.providerSelectionCompletedAt !== undefined
      ? { providerSelectionCompletedAt: settings.providerSelectionCompletedAt }
      : {}),
    ...(settings.setupCompletedAt !== undefined
      ? { setupCompletedAt: settings.setupCompletedAt }
      : {}),
    advancedWorkspaceEnabled: settings.advancedWorkspaceEnabled,
  };
}
