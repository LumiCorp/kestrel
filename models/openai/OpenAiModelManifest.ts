import {
  MODEL_REGISTRATION_V2_VERSION,
  createModelRegistrationV2,
  type ModelCapabilityEvidenceV2,
  type ModelRegistrationV2,
  type ProviderRuntimeConfigurationV1,
} from "../../src/kestrel/contracts/model-registration.js";
import { hashCanonical } from "../../src/kestrel/contracts/tool-contract.js";

/**
 * Reviewed adapter declarations, not provider API discovery. OpenAI's Models
 * API identifies a model but does not publish the endpoint capability matrix
 * needed for admission, so every entry is exact-model and exact-endpoint.
 * These declarations deliberately remain unqualified until a live probe
 * records capability-specific evidence.
 */
export const OPENAI_MODEL_MANIFEST_REVISION = "openai-model-manifest-v1";
export const OPENAI_MODEL_MANIFEST_OBSERVED_AT = "2026-08-26T00:00:00.000Z";

export interface OpenAiModelManifestEntry {
  modelId: string;
  endpoint: "chat" | "responses";
  endpointCodec: "openai.chat.v2" | "openai.responses.v2";
  reasoning: boolean;
  continuation: boolean;
  imageInput: boolean;
}

export const OPENAI_MODEL_MANIFEST: readonly OpenAiModelManifestEntry[] =
  Object.freeze([
    {
      modelId: "gpt-4.1-mini",
      endpoint: "chat",
      endpointCodec: "openai.chat.v2",
      reasoning: false,
      continuation: false,
      imageInput: true,
    },
    {
      modelId: "gpt-4.1-mini",
      endpoint: "responses",
      endpointCodec: "openai.responses.v2",
      reasoning: false,
      continuation: false,
      imageInput: true,
    },
    {
      modelId: "gpt-5.4-2026-03-05",
      endpoint: "responses",
      endpointCodec: "openai.responses.v2",
      reasoning: true,
      continuation: true,
      imageInput: true,
    },
  ]);

export function translateOpenAiManifestModel(input: {
  registrationId: string;
  revision: string;
  modelId: string;
  endpoint: "chat" | "responses";
  providerConfiguration: ProviderRuntimeConfigurationV1;
  credentialRevision?: string | undefined;
}): ModelRegistrationV2 {
  const entry = OPENAI_MODEL_MANIFEST.find(
    (candidate) =>
      candidate.modelId === input.modelId &&
      candidate.endpoint === input.endpoint,
  );
  if (entry === undefined) {
    throw new Error(
      `OpenAI model manifest has no exact ${input.endpoint} entry for '${input.modelId}'.`,
    );
  }
  const evidence: ModelCapabilityEvidenceV2 = {
    source: "adapter_manifest",
    observedRevision: input.revision,
    observedAt: OPENAI_MODEL_MANIFEST_OBSERVED_AT,
    adapterRevision: OPENAI_MODEL_MANIFEST_REVISION,
    ...(input.credentialRevision !== undefined
      ? { credentialRevision: input.credentialRevision }
      : {}),
    retainedPayloadHash: hashCanonical(entry),
  };
  const declared = () => ({ state: "declared" as const, evidence: [evidence] });
  const unsupported = () => ({
    state: "unsupported" as const,
    evidence: [evidence],
  });

  return createModelRegistrationV2({
    version: MODEL_REGISTRATION_V2_VERSION,
    registrationId: input.registrationId,
    providerId: "openai",
    modelId: entry.modelId,
    providerConfiguration: input.providerConfiguration,
    route: {
      apiEndpoint: input.providerConfiguration.endpoint,
      endpointCodec: entry.endpointCodec,
      routing: {
        kind: "fixed",
        policyId: `openai:${entry.modelId}:${entry.endpoint}`,
        requireParameters: true,
      },
    },
    revision: input.revision,
    adapterRevision: OPENAI_MODEL_MANIFEST_REVISION,
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
      reasoning: entry.reasoning
        ? { ...declared(), modes: ["off", "summary"] }
        : { ...unsupported(), modes: ["off"] },
      continuation: entry.continuation
        ? { ...declared(), kinds: ["encrypted_content"] }
        : { ...unsupported(), kinds: [] },
      streaming: {
        ...declared(),
        terminalEvents:
          entry.endpoint === "chat" ? ["[DONE]"] : ["response.completed"],
      },
      inputModalities: {
        text: declared(),
        image: entry.imageInput ? declared() : unsupported(),
      },
      limits: {
        context: { kind: "model_specific" },
        output: { kind: "model_specific" },
        evidence: [evidence],
      },
      cache: { ...unsupported(), read: false, write: false, scope: "none" },
    },
  });
}
