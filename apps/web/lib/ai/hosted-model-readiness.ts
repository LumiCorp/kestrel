import {
  ANTHROPIC_MODELS_API_TRANSLATOR_REVISION,
} from "../../../../models/anthropic/AnthropicModelManifest";
import {
  OPENAI_MODEL_MANIFEST_REVISION,
} from "../../../../models/openai/OpenAiModelManifest";
import {
  parseModelRegistrationV2,
  type ModelCapabilityStateV2,
  type ModelRegistrationV2,
} from "../../../../src/kestrel/contracts/model-registration";
import type { ModelQualificationCapability } from "../../../../src/kestrel/model-qualification";
import { OPENROUTER_MODEL_DETAIL_TRANSLATOR_REVISION } from "./openrouter-model-resolution";
import { readHostedModelRegistrationState, type HostedModelRegistrationProvider } from "./hosted-model-registration";

/**
 * Product-owned role contract. A role is available only when every capability
 * named here has current, response-backed qualification evidence.
 */
export const HOSTED_RUNTIME_ROLE_REQUIREMENTS = {
  "agent.loop": [
    "provider_strict_schema",
    "native_tools",
    "required_tool_choice",
    "strict_tool_inputs",
  ],
} as const satisfies Record<string, readonly ModelQualificationCapability[]>;

export type HostedRuntimeRole = keyof typeof HOSTED_RUNTIME_ROLE_REQUIREMENTS;
type HostedRuntimeRoleCapability =
  (typeof HOSTED_RUNTIME_ROLE_REQUIREMENTS)[HostedRuntimeRole][number];

export type HostedModelReadiness = {
  version: 1;
  approval: "approved" | "unapproved";
  reachability: "reachable" | "unreachable" | "unknown";
  identity: "exact" | "stale" | "legacy" | "invalid";
  declaration: "present" | "missing";
  qualification: "pending" | "qualified" | "failed" | "stale" | "legacy_unqualified";
  freshness: "current" | "stale" | "unknown";
  registration?: {
    revision: string;
    fingerprint: string;
    evidenceSource?: string | undefined;
    evidenceObservedAt?: string | undefined;
    qualificationCheckedAt?: string | undefined;
  } | undefined;
  capabilities: ReadonlyArray<{
    capability: ModelQualificationCapability;
    state: ModelCapabilityStateV2 | "unknown";
  }>;
  eligibleRoles: HostedRuntimeRole[];
  unavailableRoles: Array<{
    role: HostedRuntimeRole;
    reason: string;
    missingCapabilities: ModelQualificationCapability[];
  }>;
};

const CAPABILITY_CLAIM_BY_QUALIFICATION_CAPABILITY = {
  provider_strict_schema: "providerStrictSchema",
  native_tools: "nativeTools",
  required_tool_choice: "requiredToolChoice",
  strict_tool_inputs: "strictToolInputs",
} as const satisfies Record<
  HostedRuntimeRoleCapability,
  keyof ModelRegistrationV2["capabilities"]
>;

export function readHostedModelReadiness(input: {
  approved: boolean;
  gatewayEnabled?: boolean | undefined;
  gatewayReachable?: boolean | undefined;
  provider: string;
  modelId: string;
  metadata: unknown;
  credentialRevision?: number | string | undefined;
}): HostedModelReadiness {
  const provider = toHostedProvider(input.provider);
  const credentialRevision =
    input.credentialRevision === undefined
      ? undefined
      : String(input.credentialRevision);
  const registration = readExactRegistration({
    metadata: input.metadata,
    provider,
    modelId: input.modelId,
  });
  const qualification = provider
    ? readHostedModelRegistrationState({
        metadata: input.metadata,
        provider,
        modelId: input.modelId,
        credentialRevision,
      })
    : "legacy_unqualified";
  const identity = identityFor({ registration, provider, modelId: input.modelId, credentialRevision });
  const freshness =
    identity === "exact" &&
    qualification === "qualified" &&
    registration !== undefined &&
    currentHostedModelAdapterRevision(registration.providerId) === registration.adapterRevision
      ? "current"
      : identity === "stale" || qualification === "stale"
        ? "stale"
        : "unknown";
  const requiredCapabilities = [
    ...HOSTED_RUNTIME_ROLE_REQUIREMENTS["agent.loop"],
  ] as const;
  const capabilities: HostedModelReadiness["capabilities"] =
    requiredCapabilities.map((capability) => ({
      capability,
      state:
        registration === undefined
          ? "unknown"
          : (registration.capabilities[
              CAPABILITY_CLAIM_BY_QUALIFICATION_CAPABILITY[capability]
            ].state as ModelCapabilityStateV2),
    }));
  const unavailableRoles = (Object.entries(HOSTED_RUNTIME_ROLE_REQUIREMENTS) as Array<
    [HostedRuntimeRole, readonly HostedRuntimeRoleCapability[]]
  >).flatMap(([role, required]) => {
    const missingCapabilities = required.filter(
      (capability) =>
        registration?.capabilities[
          CAPABILITY_CLAIM_BY_QUALIFICATION_CAPABILITY[capability]
        ].state !== "qualified",
    );
    const reason = readinessFailureReason({
      approved: input.approved,
      gatewayEnabled: input.gatewayEnabled,
      gatewayReachable: input.gatewayReachable,
      provider,
      identity,
      qualification,
      freshness,
      missingCapabilities,
    });
    return reason === undefined ? [] : [{ role, reason, missingCapabilities: [...missingCapabilities] }];
  });
  return {
    version: 1,
    approval: input.approved ? "approved" : "unapproved",
    reachability:
      input.gatewayEnabled === false || input.gatewayReachable === false
        ? "unreachable"
        : input.gatewayReachable === true
          ? "reachable"
          : "unknown",
    identity,
    declaration: registration === undefined ? "missing" : "present",
    qualification,
    freshness,
    ...(registration === undefined
      ? {}
      : {
          registration: {
            revision: registration.revision,
            fingerprint: registration.fingerprint,
            evidenceSource: registration.providerEvidence[0]?.source,
            evidenceObservedAt: registration.providerEvidence[0]?.observedAt,
            qualificationCheckedAt: registration.qualification.checkedAt,
          },
        }),
    capabilities,
    eligibleRoles: (Object.keys(HOSTED_RUNTIME_ROLE_REQUIREMENTS) as HostedRuntimeRole[]).filter(
      (role) => !unavailableRoles.some((entry) => entry.role === role),
    ),
    unavailableRoles,
  };
}

export function isHostedModelRoleReady(
  readiness: HostedModelReadiness,
  role: string = "agent.loop",
) {
  return isHostedRuntimeRole(role) && readiness.eligibleRoles.includes(role);
}

export function isHostedModelProvider(
  value: string,
): value is HostedModelRegistrationProvider {
  return toHostedProvider(value) !== undefined;
}

export function isHostedRuntimeRole(value: string): value is HostedRuntimeRole {
  return Object.hasOwn(HOSTED_RUNTIME_ROLE_REQUIREMENTS, value);
}

export function hostedModelRoleUnavailableReason(
  readiness: HostedModelReadiness,
  role: string,
) {
  if (!isHostedRuntimeRole(role)) {
    return `Kestrel has no product-owned capability contract for runtime role '${role}'.`;
  }
  return readiness.unavailableRoles.find((entry) => entry.role === role)?.reason;
}

export function currentHostedModelAdapterRevision(
  provider: ModelRegistrationV2["providerId"],
): string | undefined {
  switch (provider) {
    case "openai":
      return OPENAI_MODEL_MANIFEST_REVISION;
    case "openrouter":
      return OPENROUTER_MODEL_DETAIL_TRANSLATOR_REVISION;
    case "anthropic":
      return ANTHROPIC_MODELS_API_TRANSLATOR_REVISION;
    default:
      return;
  }
}

function readExactRegistration(input: {
  metadata: unknown;
  provider: HostedModelRegistrationProvider | undefined;
  modelId: string;
}) {
  if (!input.provider || !input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
    return;
  }
  try {
    const registration = parseModelRegistrationV2(
      (input.metadata as Record<string, unknown>).kestrelModelRegistrationV2,
    );
    return registration.providerId === input.provider && registration.modelId === input.modelId
      ? registration
      : undefined;
  } catch {
    return;
  }
}

function identityFor(input: {
  registration: ModelRegistrationV2 | undefined;
  provider: HostedModelRegistrationProvider | undefined;
  modelId: string;
  credentialRevision: string | undefined;
}): HostedModelReadiness["identity"] {
  if (!input.provider) return "legacy";
  if (!input.registration) return "legacy";
  if (
    input.registration.providerId !== input.provider ||
    input.registration.modelId !== input.modelId
  ) return "invalid";
  if (
    (input.credentialRevision !== undefined &&
      input.registration.credentialRevision !== input.credentialRevision) ||
    currentHostedModelAdapterRevision(input.registration.providerId) !== input.registration.adapterRevision
  ) return "stale";
  return "exact";
}

function readinessFailureReason(input: {
  approved: boolean;
  gatewayEnabled?: boolean | undefined;
  gatewayReachable?: boolean | undefined;
  provider: HostedModelRegistrationProvider | undefined;
  identity: HostedModelReadiness["identity"];
  qualification: HostedModelReadiness["qualification"];
  freshness: HostedModelReadiness["freshness"];
  missingCapabilities: readonly ModelQualificationCapability[];
}) {
  if (!input.approved) return "The model is not approved.";
  if (input.gatewayEnabled === false) return "The provider is disabled.";
  if (input.gatewayReachable === false) return "The provider credential is not reachable.";
  if (!input.provider) return "This provider has no exact hosted model registration.";
  if (input.identity === "legacy") return "The model needs an exact registration and qualification.";
  if (input.identity === "invalid") return "The retained registration does not match this exact provider and model.";
  if (input.identity === "stale" || input.freshness === "stale") return "The exact registration or qualification is stale. Refresh the model.";
  if (input.qualification !== "qualified") return `The last qualification is ${input.qualification}. Refresh the model.`;
  if (input.missingCapabilities.length > 0) {
    return `Missing current qualification for ${input.missingCapabilities.join(", ")}.`;
  }
  return;
}

function toHostedProvider(value: string): HostedModelRegistrationProvider | undefined {
  return value === "openai" || value === "openrouter" || value === "anthropic"
    ? value
    : undefined;
}
