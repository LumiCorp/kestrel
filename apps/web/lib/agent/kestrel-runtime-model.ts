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
import {
  createLegacyModelCredentialRouteBindingV2,
  type ModelCredentialRouteBindingV2,
} from "../../../../src/kestrel/contracts/model-route";
import {
  fingerprintModelRoutingPolicyV2,
  parseModelRegistrationV2,
  type ModelRegistrationV2,
} from "../../../../src/kestrel/contracts/model-registration";
import { readHostedOpenRouterRouteEvidence } from "../ai/hosted-model-registration";
import {
  currentHostedModelAdapterRevision,
  hostedModelRoleUnavailableReason,
  isHostedModelProvider,
  isHostedModelRoleReady,
  readHostedModelReadiness,
} from "../ai/hosted-model-readiness";
import type { OpenRouterQualifiedRouteEvidence } from "../../../../models/openrouter/OpenRouterV2Codec";

type RunnerModelProvider = NonNullable<RunnerProfile["modelProvider"]>;
type KestrelOneManagedModelProvider = Exclude<RunnerModelProvider, "lmstudio">;

export type KestrelOneRuntimeModelSelection = {
  id: string;
  gatewayId: string;
  organizationId: string;
  environmentId: string;
  model: string;
  provider: KestrelOneManagedModelProvider;
  routeBinding?: ModelCredentialRouteBindingV2 | undefined;
  registration?: ModelRegistrationV2 | undefined;
  openRouterRouteEvidence?: OpenRouterQualifiedRouteEvidence | undefined;
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
  credentialRevision?: number | undefined;
  requiredRole?: string | undefined;
}): KestrelOneRuntimeModelSelection {
  if (!isKestrelRuntimeLanguageProvider(input.gatewayProvider)) {
    throw new Error(
      `Approved ${input.gatewayProvider} model "${input.id}" cannot run through the external Kestrel runtime.`,
    );
  }
  if (!input.gatewayId) {
    throw new Error(
      `Approved model "${input.id}" is missing its gateway reference.`,
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
  if (economicsProfile === undefined) {
    const error = new Error(
      `Hosted model "${input.id}" is not runtime-eligible because its exact economics profile is missing or mismatched.`,
    );
    Object.assign(error, { code: "GATEWAY_MODEL_RUNTIME_INELIGIBLE" });
    throw error;
  }

  const requiredRole = input.requiredRole ?? "agent.loop";
  const usesHostedRegistration = isHostedModelProvider(input.gatewayProvider);
  const readiness = readHostedModelReadiness({
    approved: true,
    provider,
    modelId: input.rawModelId,
    metadata: input.metadata,
    credentialRevision: input.credentialRevision,
  });
  if (
    usesHostedRegistration &&
    !isHostedModelRoleReady(readiness, requiredRole)
  ) {
    const error = new Error(
      hostedModelRoleUnavailableReason(readiness, requiredRole) ??
        `Hosted model \"${input.id}\" is not eligible for runtime role \"${requiredRole}\".`,
    );
    Object.assign(error, { code: "HOSTED_MODEL_ROLE_UNAVAILABLE" });
    throw error;
  }

  const qualifiedRoute = readQualifiedRoute({
    metadata: input.metadata,
    provider: provider as ModelCredentialRouteBindingV2["provider"],
    rawModelId: input.rawModelId,
    credentialRevision: input.credentialRevision,
    requiredRole,
  });
  if (usesHostedRegistration && qualifiedRoute === undefined) {
    throw new Error(
      `Hosted model \"${input.id}\" has no current exact route binding for runtime role \"${requiredRole}\".`,
    );
  }

  return {
    id: input.id,
    gatewayId: input.gatewayId,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    model: input.rawModelId,
    provider: provider as KestrelOneManagedModelProvider,
    ...(qualifiedRoute === undefined
      ? {}
      : {
          routeBinding: qualifiedRoute.routeBinding,
          registration: qualifiedRoute.registration,
          ...(qualifiedRoute.openRouterRouteEvidence === undefined
            ? {}
            : { openRouterRouteEvidence: qualifiedRoute.openRouterRouteEvidence }),
        }),
    economicsProfile,
  };
}

export function applyKestrelOneModelsToProfile(
  profile: RunnerProfile,
  selections: readonly [
    EnvironmentRuntimeModelSelection,
    ...EnvironmentRuntimeModelSelection[],
  ],
  runId: string,
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
      routeBinding:
        selection.routeBinding ??
        createLegacyModelCredentialRouteBindingV2({
          provider: selection.provider,
          rawModelId: selection.model,
        }),
      ...(selection.registration === undefined
        ? {}
        : { registration: selection.registration }),
      ...(selection.openRouterRouteEvidence === undefined
        ? {}
        : { openRouterRouteEvidence: selection.openRouterRouteEvidence }),
    },
  };
}

function readQualifiedRoute(input: {
  metadata: unknown;
  provider: ModelCredentialRouteBindingV2["provider"];
  rawModelId: string;
  credentialRevision: number | undefined;
  requiredRole: string;
}):
  | {
      routeBinding: ModelCredentialRouteBindingV2;
      registration: ModelRegistrationV2;
      openRouterRouteEvidence?: OpenRouterQualifiedRouteEvidence | undefined;
    }
  | undefined {
  if (
    !(input.metadata && typeof input.metadata === "object") ||
    Array.isArray(input.metadata) ||
    input.credentialRevision === undefined
  ) {
    return;
  }
  const registration = (input.metadata as Record<string, unknown>)
    .kestrelModelRegistrationV2;
  if (registration === undefined) return;
  const parsed = parseModelRegistrationV2(registration);
  if (
    parsed.providerId !== input.provider ||
    parsed.modelId !== input.rawModelId ||
    parsed.qualification.state !== "qualified" ||
    parsed.qualification.revision === undefined ||
    parsed.credentialRevision !== String(input.credentialRevision) ||
    parsed.adapterRevision !== currentHostedModelAdapterRevision(parsed.providerId)
  ) {
    // Existing registrations that are pending, stale, or from an older
    // adapter revision remain reachable only through the explicit legacy
    // compatibility route. They cannot acquire qualified capabilities.
    return;
  }
  return {
    registration: parsed,
    ...(parsed.providerId !== "openrouter"
      ? {}
      : (() => {
          const openRouterRouteEvidence = readHostedOpenRouterRouteEvidence({
            metadata: input.metadata,
            registration: parsed,
          });
          if (openRouterRouteEvidence === undefined) {
            throw new Error("Qualified OpenRouter registrations require retained exact route evidence.");
          }
          return { openRouterRouteEvidence };
        })()),
    routeBinding: {
      version: "model_credential_route_binding_v2",
      status: "qualified",
      provider: input.provider,
      rawModelId: input.rawModelId,
      registrationId: parsed.registrationId,
      registrationRevision: parsed.revision,
      registrationFingerprint: parsed.fingerprint,
      qualificationRevision: parsed.qualification.revision,
      apiEndpoint: parsed.route.apiEndpoint,
      endpointCodec: parsed.route.endpointCodec,
      routingPolicyFingerprint: fingerprintModelRoutingPolicyV2(
        parsed.route.routing,
      ),
      requiredRole: input.requiredRole,
      credentialRevision: input.credentialRevision,
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

function asEconomicsControl(
  value: unknown,
):
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
