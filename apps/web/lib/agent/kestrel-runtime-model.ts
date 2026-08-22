import type { RunnerProfile } from "@kestrel-agents/sdk/runner";
import {
  type GatewayProtocolProvider,
  getGatewayLanguageProtocol,
  isKestrelRuntimeLanguageProvider,
} from "@/lib/ai/gateway-utils";
import {
  createGatewayModelEconomicsProfile,
  readGatewayModelEconomicsProfile,
  type GatewayModelEconomicsProfile,
} from "@/lib/ai/model-economics-profile";

type RunnerModelProvider = NonNullable<RunnerProfile["modelProvider"]>;

export type KestrelOneRuntimeModelSelection = {
  id: string;
  gatewayId: string;
  organizationId: string;
  environmentId: string;
  model: string;
  provider: RunnerModelProvider;
  economicsProfile?: GatewayModelEconomicsProfile | undefined;
};

export type DesktopLocalRuntimeModelSelection = {
  desktopLocal: true;
  id: string;
  organizationId: string;
  environmentId: string;
  model: string;
  provider: RunnerModelProvider;
};

export type DirectLocalRuntimeModelSelection = {
  directLocal: true;
  id: string;
  organizationId: string;
  environmentId: string;
  model: string;
  provider: RunnerModelProvider;
  economicsProfile?: GatewayModelEconomicsProfile | undefined;
};

export type EnvironmentRuntimeModelSelection =
  | KestrelOneRuntimeModelSelection
  | DesktopLocalRuntimeModelSelection
  | DirectLocalRuntimeModelSelection;

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
  const economicsProfile =
    readGatewayModelEconomicsProfile(input.metadata, {
      provider,
      model: input.rawModelId,
    }) ??
    createGatewayModelEconomicsProfile({
      provider,
      model: input.rawModelId,
      metadata: input.metadata,
    });

  return {
    id: input.id,
    gatewayId: input.gatewayId,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    model: input.rawModelId,
    provider: provider as RunnerModelProvider,
    ...(economicsProfile !== undefined ? { economicsProfile } : {}),
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
  const economicsProfile =
    "economicsProfile" in selection ? selection.economicsProfile : undefined;
  const profileEconomics = asEconomicsControl(profile.harnessEconomics);
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
    ...(economicsProfile !== undefined && profileEconomics !== undefined
      ? {
          harnessEconomics: {
            ...profileEconomics,
            modelProfiles: [
              ...profileEconomics.modelProfiles.filter(
                (candidate) =>
                  !(
                    candidate.provider === economicsProfile.provider &&
                    candidate.model === economicsProfile.model
                  ),
              ),
              economicsProfile,
            ],
          },
        }
      : {}),
    default: false,
  };
  if (!isKestrelOneManagedRuntimeModel(selection)) {
    const { modelCredential: _modelCredential, ...local } = selected;
    return local;
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
  };
}

export function isKestrelOneManagedRuntimeModel(
  selection: EnvironmentRuntimeModelSelection,
): selection is KestrelOneRuntimeModelSelection {
  return "gatewayId" in selection;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asEconomicsControl(value: unknown):
  | { modelProfiles: GatewayModelEconomicsProfile[]; [key: string]: unknown }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const modelProfiles = (value as { modelProfiles?: unknown }).modelProfiles;
  return Array.isArray(modelProfiles)
    ? {
        ...(value as Record<string, unknown>),
        modelProfiles: modelProfiles as GatewayModelEconomicsProfile[],
      }
    : undefined;
}
