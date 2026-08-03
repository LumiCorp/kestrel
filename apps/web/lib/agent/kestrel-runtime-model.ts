import type { RunnerProfile } from "@kestrel-agents/sdk/runner";
import {
  type GatewayProtocolProvider,
  getGatewayLanguageProtocol,
  isKestrelRuntimeLanguageProvider,
} from "@/lib/ai/gateway-utils";

type RunnerModelProvider = NonNullable<RunnerProfile["modelProvider"]>;

export type KestrelOneRuntimeModelSelection = {
  id: string;
  gatewayId: string;
  organizationId: string;
  environmentId: string;
  model: string;
  provider: RunnerModelProvider;
};

export type DesktopLocalRuntimeModelSelection = {
  desktopLocal: true;
  id: string;
  organizationId: string;
  environmentId: string;
  model: string;
  provider: RunnerModelProvider;
};

export type EnvironmentRuntimeModelSelection =
  | KestrelOneRuntimeModelSelection
  | DesktopLocalRuntimeModelSelection;

export function toKestrelOneRuntimeModelSelection(input: {
  id: string;
  gatewayId: string | null;
  rawModelId: string;
  gatewayProvider: GatewayProtocolProvider;
  metadata?: unknown;
  organizationId: string;
  environmentId: string;
}): KestrelOneRuntimeModelSelection {
  if (!isKestrelRuntimeLanguageProvider(input.gatewayProvider)) {
    throw new Error(
      `Approved ${input.gatewayProvider} model "${input.id}" cannot run through the external Kestrel runtime.`
    );
  }
  if (!input.gatewayId) {
    throw new Error(
      `Approved model "${input.id}" is missing its gateway reference.`
    );
  }
  const provider =
    input.gatewayProvider === "lumi" || input.gatewayProvider === "runpod"
      ? getGatewayLanguageProtocol({
          gatewayProvider: input.gatewayProvider,
          modality: "language",
          metadata: input.metadata,
        })
      : input.gatewayProvider;

  return {
    id: input.id,
    gatewayId: input.gatewayId,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    model: input.rawModelId,
    provider: provider as RunnerModelProvider,
  };
}

export function applyKestrelOneModelsToProfile(
  profile: RunnerProfile,
  selections: readonly [
    EnvironmentRuntimeModelSelection,
    ...EnvironmentRuntimeModelSelection[],
  ],
  runId: string
): RunnerProfile {
  const selection = selections[0];
  const agentStageConfig = asRecord(profile.agentStageConfig);
  const modelByStage = asRecord(agentStageConfig.modelByStage);

  const selected: RunnerProfile = {
    ...profile,
    id: `${profile.id}:model:${encodeURIComponent(selection.id)}:run:${encodeURIComponent(runId)}`,
    label: `${profile.label} · ${selection.id}`,
    modelProvider: selection.provider,
    model: selection.model,
    agentStageConfig: {
      ...agentStageConfig,
      modelByStage: {
        ...modelByStage,
        "agent.loop": selection.model,
      },
    },
    default: false,
  };
  if ("desktopLocal" in selection) {
    const { modelCredential: _modelCredential, ...local } = selected;
    return {
      ...local,
      ...(selections.length > 1
        ? {
            recoveryModelCandidates: selections
              .slice(1)
              .map((candidate, index) =>
                toRecoveryModelCandidate(candidate, index + 1, runId)),
          }
        : {}),
    };
  }
  return {
    ...selected,
    modelCredential: {
      source: "kestrel-one",
      runId,
      gatewayId: selection.gatewayId,
      organizationId: selection.organizationId,
      environmentId: selection.environmentId,
      rawModelId: selection.model,
      provider: selection.provider,
    },
    ...(selections.length > 1
      ? {
          recoveryModelCandidates: selections
            .slice(1)
            .map((candidate, index) =>
              toRecoveryModelCandidate(candidate, index + 1, runId)),
        }
      : {}),
  };
}

export function isKestrelOneManagedRuntimeModel(
  selection: EnvironmentRuntimeModelSelection,
): selection is KestrelOneRuntimeModelSelection {
  return !("desktopLocal" in selection);
}

export function toRecoveryModelCandidate(
  selection: EnvironmentRuntimeModelSelection,
  ordinal: number,
  runId: string
) {
  return {
    candidateId: `fallback.${ordinal}.${selection.id}`,
    provider: selection.provider,
    model: selection.model,
    capabilities: {
      visionInputEnabled: false,
      toolCallingEnabled: true,
      structuredOutputEnabled: true,
      reasoningModes:
        selection.provider === "ollama" || selection.provider === "lmstudio"
          ? (["off", "summary"] as const)
          : (["off", "summary", "provider_visible"] as const),
    },
    ...("desktopLocal" in selection
      ? {}
      : {
          credentialReference: {
            source: "kestrel-one" as const,
            runId,
            gatewayId: selection.gatewayId,
            organizationId: selection.organizationId,
            environmentId: selection.environmentId,
            rawModelId: selection.model,
            provider: selection.provider,
          },
        }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
