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

export function applyKestrelOneModelToProfile(
  profile: RunnerProfile,
  selection: KestrelOneRuntimeModelSelection
): RunnerProfile {
  const agentStageConfig = asRecord(profile.agentStageConfig);
  const modelByStage = asRecord(agentStageConfig.modelByStage);

  return {
    ...profile,
    id: `${profile.id}:model:${encodeURIComponent(selection.id)}`,
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
    modelCredential: {
      source: "kestrel-one",
      gatewayId: selection.gatewayId,
      organizationId: selection.organizationId,
      environmentId: selection.environmentId,
      rawModelId: selection.model,
    },
    default: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
