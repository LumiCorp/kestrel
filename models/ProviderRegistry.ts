import {
  MODEL_REQUEST_VERSION,
  PROVIDER_CODEC_ENVELOPE_VERSION,
  type ModelProviderIdentityV1,
  type ModelProviderProtocolV1,
  type ModelRequestV1,
} from "../src/kestrel/contracts/model-registration.js";
import {
  createAnthropicModelGatewayFromEnv,
  type AnthropicGatewayFactoryOptions,
} from "./anthropic/createAnthropicModelGateway.js";
import {
  createLmStudioModelGatewayFromEnv,
  type LmStudioGatewayFactoryOptions,
} from "./lmstudio/createLmStudioModelGateway.js";
import {
  createLumiModelGateway,
  type LumiGatewayFactoryOptions,
} from "./lumi/createLumiModelGateway.js";
import {
  createOllamaModelGatewayFromEnv,
  type OllamaGatewayFactoryOptions,
} from "./ollama/createOllamaModelGateway.js";
import {
  createOpenAiModelGatewayFromEnv,
  type OpenAiGatewayFactoryOptions,
} from "./openai/createOpenAiModelGateway.js";
import {
  createOpenRouterModelGatewayFromEnv,
  type OpenRouterGatewayFactoryOptions,
} from "./openrouter/createOpenRouterModelGateway.js";
import {
  createRunPodModelGateway,
  type RunPodGatewayFactoryOptions,
} from "./runpod/createRunPodModelGateway.js";

export const MODEL_PROVIDER_IDENTITIES_V1 = Object.freeze([
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
  "lumi",
  "runpod",
] as const satisfies readonly ModelProviderIdentityV1[]);

export type ProviderAdapterFactoryOptionsV1 =
  | OpenRouterGatewayFactoryOptions
  | OpenAiGatewayFactoryOptions
  | AnthropicGatewayFactoryOptions
  | OllamaGatewayFactoryOptions
  | LmStudioGatewayFactoryOptions
  | LumiGatewayFactoryOptions
  | RunPodGatewayFactoryOptions;

/** Exact shipped factory identities; P1 does not introduce a generic factory. */
export type ProviderAdapterFactoryV1 =
  | typeof createOpenRouterModelGatewayFromEnv
  | typeof createOpenAiModelGatewayFromEnv
  | typeof createAnthropicModelGatewayFromEnv
  | typeof createOllamaModelGatewayFromEnv
  | typeof createLmStudioModelGatewayFromEnv
  | typeof createLumiModelGateway
  | typeof createRunPodModelGateway;

export interface ProviderConformanceFixtureV1 {
  fixtureId: string;
  request: ModelRequestV1;
  expectedProviderId: ModelProviderIdentityV1;
  reasoningProbe: {
    modes: readonly ["summary", "provider_visible"];
    requestBodyField: "reasoning" | "thinking";
  };
}

export interface ProviderAdapterRegistrationV1 {
  providerId: ModelProviderIdentityV1;
  protocol: ModelProviderProtocolV1;
  factoryId: string;
  factory: ProviderAdapterFactoryV1;
  codecEnvelope: ProviderCodecEnvelopeV1;
  conformanceFixture: ProviderConformanceFixtureV1;
}

/**
 * This is a declaration of code Kestrel can encode and decode. It is not a
 * claim about any particular provider model or routed endpoint.
 */
export interface ProviderCodecEnvelopeV1 {
  version: typeof PROVIDER_CODEC_ENVELOPE_VERSION;
  requestEndpoints: readonly ("chat" | "responses" | "messages")[];
  responseEndpoints: readonly ("chat" | "responses" | "messages")[];
  reasoningRequestField: "reasoning" | "thinking";
  reasoningModes: readonly ("summary" | "provider_visible")[];
  streamingTerminalEvents: readonly string[];
}

const openAiStyleEnvelope = codecEnvelope({
  requestEndpoints: ["chat", "responses"],
  responseEndpoints: ["chat", "responses"],
  reasoningRequestField: "reasoning",
  reasoningModes: ["summary", "provider_visible"],
  streamingTerminalEvents: ["[DONE]", "response.completed"],
});

const anthropicEnvelope = codecEnvelope({
  requestEndpoints: ["messages"],
  responseEndpoints: ["messages"],
  reasoningRequestField: "thinking",
  reasoningModes: ["summary", "provider_visible"],
  streamingTerminalEvents: ["message_stop"],
});

const openAiCompatibleEnvelope = codecEnvelope({
  requestEndpoints: ["chat", "responses"],
  responseEndpoints: ["chat", "responses"],
  reasoningRequestField: "reasoning",
  reasoningModes: [],
  streamingTerminalEvents: ["[DONE]"],
});

export const MODEL_PROVIDER_ADAPTERS_V1: readonly ProviderAdapterRegistrationV1[] =
  Object.freeze([
    registration(
      "openrouter",
      "openrouter",
      "openrouter.env.v1",
      createOpenRouterModelGatewayFromEnv,
      openAiStyleEnvelope,
    ),
    registration(
      "openai",
      "openai",
      "openai.env.v1",
      createOpenAiModelGatewayFromEnv,
      openAiStyleEnvelope,
    ),
    registration(
      "anthropic",
      "anthropic",
      "anthropic.env.v1",
      createAnthropicModelGatewayFromEnv,
      anthropicEnvelope,
    ),
    registration(
      "ollama",
      "openai",
      "ollama.env.v1",
      createOllamaModelGatewayFromEnv,
      openAiCompatibleEnvelope,
    ),
    registration(
      "lmstudio",
      "openai",
      "lmstudio.env.v1",
      createLmStudioModelGatewayFromEnv,
      openAiCompatibleEnvelope,
    ),
    registration(
      "lumi",
      "openai",
      "lumi.managed.v1",
      createLumiModelGateway,
      openAiCompatibleEnvelope,
    ),
    registration(
      "runpod",
      "openai",
      "runpod.managed.v1",
      createRunPodModelGateway,
      openAiCompatibleEnvelope,
    ),
  ]);

const REGISTRY_BY_ID = new Map(
  MODEL_PROVIDER_ADAPTERS_V1.map((entry) => [entry.providerId, entry]),
);

if (
  REGISTRY_BY_ID.size !== MODEL_PROVIDER_IDENTITIES_V1.length ||
  MODEL_PROVIDER_IDENTITIES_V1.some(
    (providerId) => !REGISTRY_BY_ID.has(providerId),
  )
) {
  throw new Error(
    "model provider adapter registry does not match the exact identity set",
  );
}

export function getModelProviderAdapterV1(
  providerId: ModelProviderIdentityV1,
): ProviderAdapterRegistrationV1 {
  const registration = REGISTRY_BY_ID.get(providerId);
  if (registration === undefined) {
    throw new Error(`model provider '${providerId}' is not registered`);
  }
  return registration;
}

export function listModelProviderAdaptersV1(): readonly ProviderAdapterRegistrationV1[] {
  return MODEL_PROVIDER_ADAPTERS_V1;
}

function registration(
  providerId: ModelProviderIdentityV1,
  protocol: ModelProviderProtocolV1,
  factoryId: string,
  factory: ProviderAdapterFactoryV1,
  codecEnvelope: ProviderCodecEnvelopeV1,
): ProviderAdapterRegistrationV1 {
  return Object.freeze({
    providerId,
    protocol,
    factoryId,
    factory,
    codecEnvelope,
    conformanceFixture: Object.freeze({
      fixtureId: `${providerId}.text.v1`,
      request: Object.freeze({
        version: MODEL_REQUEST_VERSION,
        model: `${providerId}-conformance-fixture`,
        input: "provider registry conformance",
        responseFormat: "text",
      }),
      expectedProviderId: providerId,
      reasoningProbe: Object.freeze({
        modes: Object.freeze(["summary", "provider_visible"] as const),
        requestBodyField: codecEnvelope.reasoningRequestField,
      }),
    }),
  });
}

function codecEnvelope(
  value: Omit<ProviderCodecEnvelopeV1, "version">,
): ProviderCodecEnvelopeV1 {
  return Object.freeze({
    version: PROVIDER_CODEC_ENVELOPE_VERSION,
    requestEndpoints: Object.freeze([...value.requestEndpoints]),
    responseEndpoints: Object.freeze([...value.responseEndpoints]),
    reasoningRequestField: value.reasoningRequestField,
    reasoningModes: Object.freeze([...value.reasoningModes]),
    streamingTerminalEvents: Object.freeze([...value.streamingTerminalEvents]),
  });
}
