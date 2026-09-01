import {
  MODEL_REGISTRATION_V2_VERSION,
  createModelRegistrationV2,
  type ModelCapabilityEvidenceV2,
  type ModelRegistrationV2,
  type ProviderRuntimeConfigurationV1,
} from "../../src/kestrel/contracts/model-registration.js";
import { hashCanonical } from "../../src/kestrel/contracts/tool-contract.js";

/**
 * A Models API record proves only the exact provider identity observed at a
 * revision. It deliberately creates declared, not qualified, capability
 * claims: capability-specific probing remains the admission authority.
 */
export const ANTHROPIC_MODELS_API_TRANSLATOR_REVISION =
  "anthropic-models-api-translator-v1";

export function translateAnthropicModelsApiModel(input: {
  registrationId: string;
  revision: string;
  observedAt: string;
  modelId: string;
  modelsApiRecord: unknown;
  providerConfiguration: ProviderRuntimeConfigurationV1;
  credentialRevision?: string | undefined;
}): ModelRegistrationV2 {
  const record = requireRecord(input.modelsApiRecord);
  const returnedId = typeof record.id === "string" ? record.id : undefined;
  if (returnedId !== input.modelId) {
    throw new Error(
      "Anthropic Models API evidence does not match the requested exact model identity.",
    );
  }
  if (input.providerConfiguration.providerId !== "anthropic") {
    throw new Error(
      "Anthropic Models API evidence requires an Anthropic provider configuration.",
    );
  }
  const evidence: ModelCapabilityEvidenceV2 = {
    source: "provider",
    observedRevision: input.revision,
    observedAt: input.observedAt,
    adapterRevision: ANTHROPIC_MODELS_API_TRANSLATOR_REVISION,
    ...(input.credentialRevision !== undefined
      ? { credentialRevision: input.credentialRevision }
      : {}),
    retainedPayloadHash: hashCanonical(record),
  };
  const declared = () => ({ state: "declared" as const, evidence: [evidence] });
  const unsupported = () => ({
    state: "unsupported" as const,
    evidence: [evidence],
  });

  return createModelRegistrationV2({
    version: MODEL_REGISTRATION_V2_VERSION,
    registrationId: input.registrationId,
    providerId: "anthropic",
    modelId: returnedId,
    providerConfiguration: input.providerConfiguration,
    route: {
      apiEndpoint: input.providerConfiguration.endpoint,
      endpointCodec: "anthropic.messages.v2",
      routing: {
        kind: "fixed",
        policyId: `anthropic:${returnedId}:messages`,
        requireParameters: true,
      },
    },
    revision: input.revision,
    adapterRevision: ANTHROPIC_MODELS_API_TRANSLATOR_REVISION,
    ...(input.credentialRevision !== undefined
      ? { credentialRevision: input.credentialRevision }
      : {}),
    providerEvidence: [evidence],
    qualification: { state: "pending" },
    capabilities: {
      jsonSyntax: declared(),
      localSchemaValidation: declared(),
      providerStrictSchema: declared(),
      nativeTools: declared(),
      requiredToolChoice: declared(),
      strictToolInputs: declared(),
      parallelToolCalls: declared(),
      reasoning: {
        ...declared(),
        modes: ["off", "summary", "provider_visible"],
      },
      continuation: { ...declared(), kinds: ["signature"] },
      streaming: { ...declared(), terminalEvents: ["message_stop"] },
      inputModalities: { text: declared(), image: declared() },
      limits: {
        context: { kind: "model_specific" },
        output: { kind: "model_specific" },
        evidence: [evidence],
      },
      cache: { ...unsupported(), read: false, write: false, scope: "none" },
    },
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Anthropic Models API evidence must be an object.");
  }
  return value as Record<string, unknown>;
}
