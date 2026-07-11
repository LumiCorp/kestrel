import { DEFAULT_ACT_SUBMODE, DEFAULT_INTERACTION_MODE } from "../mode/contracts.js";
import type { TuiProfile } from "../../cli/contracts.js";
import {
  buildRuntimeIdentityMetadata,
  DEFAULT_MODEL_BY_PROVIDER,
  resolveRuntimeProfileSelection,
  type ShellKind,
} from "../profile/runtimeProfile.js";

export const DEFAULT_WEB_PROFILE_ID = "reference-web";
export const DEFAULT_WEB_PROFILE_LABEL = "Reference React (Web)";
export const DEFAULT_WEB_AGENT_PROFILE_LABEL = "Reference React";

export function createWebDemoProfile(shellKind: ShellKind = "web"): TuiProfile {
  const resolved = resolveRuntimeProfileSelection({
    shellKind,
  });
  const runtimeIdentity = buildRuntimeIdentityMetadata({
    agentProfileId: DEFAULT_WEB_PROFILE_ID,
    agentProfileLabel: DEFAULT_WEB_AGENT_PROFILE_LABEL,
    legacyProfileLabel: DEFAULT_WEB_PROFILE_LABEL,
    shellKind: resolved.shellKind,
    presetId: resolved.presetId,
    capabilityPacks: resolved.capabilityPacks,
  });
  return {
    id: DEFAULT_WEB_PROFILE_ID,
    label:
      shellKind === "desktop"
        ? "Reference React (Desktop)"
        : DEFAULT_WEB_PROFILE_LABEL,
    agent: "reference-react",
    sessionPrefix: DEFAULT_WEB_PROFILE_ID,
    agentProfileId: runtimeIdentity.agentProfileId,
    agentProfileLabel: runtimeIdentity.agentProfileLabel,
    shellKind: resolved.shellKind,
    presetId: resolved.presetId,
    capabilityPacks: [...resolved.capabilityPacks],
    environmentShellKind: runtimeIdentity.environmentShellKind,
    environmentPresetId: runtimeIdentity.environmentPresetId,
    environmentCapabilityPackIds: [...runtimeIdentity.environmentCapabilityPackIds],
    modelProvider: "openrouter",
    model: DEFAULT_MODEL_BY_PROVIDER.openrouter,
    modelCapabilities: {
      visionInputEnabled: false,
    },
    agentStageConfig: {
      modelByStage: {},
    },
    modelTimeoutMs: undefined,
    modeSystemV2Enabled: true,
    defaultInteractionMode: DEFAULT_INTERACTION_MODE,
    defaultActSubmode: DEFAULT_ACT_SUBMODE,
    toolAllowlist: [...resolved.toolAllowlist],
    mcpServers: [],
    toolQueue: {
      perRunConcurrency: 8,
      globalConcurrency: 24,
      maxQueuedJobsPerRun: 50,
      checkpointSize: 10,
      retryCount: 1,
    },
    guardrails: {
      maxStepVisits: 80,
    },
    codeMode: resolved.codeMode,
    devShell: resolved.devShell,
    default: true,
  };
}
