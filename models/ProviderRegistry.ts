import {
  MODEL_CAPABILITY_DESCRIPTOR_VERSION,
  MODEL_REQUEST_VERSION,
  parseModelCapabilityDescriptorV1,
  type ModelCapabilityDescriptorV1,
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
}

export interface ProviderAdapterRegistrationV1 {
  providerId: ModelProviderIdentityV1;
  protocol: ModelProviderProtocolV1;
  factoryId: string;
  factory: ProviderAdapterFactoryV1;
  capabilityDeclaration: ModelCapabilityDescriptorV1;
  conformanceFixture: ProviderConformanceFixtureV1;
}

const hostedCapabilities = capability({
  tools: { nativeToolCalling: true, parallelToolCalls: true },
  structuredOutput: { modes: ["json_object", "json_schema", "tool_contract"] },
  streaming: true,
  reasoningModes: ["off", "summary", "provider_visible"],
  inputModalities: ["text", "image"],
  contextLimit: { kind: "model_specific" },
  outputLimit: { kind: "model_specific" },
  cache: { read: true, write: true, scope: "provider" },
});

const anthropicCapabilities = capability({
  tools: { nativeToolCalling: true, parallelToolCalls: true },
  structuredOutput: { modes: ["tool_contract"] },
  streaming: true,
  reasoningModes: ["off", "summary", "provider_visible"],
  inputModalities: ["text", "image"],
  contextLimit: { kind: "model_specific" },
  outputLimit: { kind: "model_specific" },
  cache: { read: true, write: true, scope: "provider" },
});

const localCapabilities = capability({
  tools: { nativeToolCalling: true, parallelToolCalls: false },
  structuredOutput: { modes: ["json_object"] },
  streaming: true,
  reasoningModes: ["off"],
  inputModalities: ["text"],
  contextLimit: { kind: "model_specific" },
  outputLimit: { kind: "model_specific" },
  cache: { read: false, write: false, scope: "none" },
});

export const MODEL_PROVIDER_ADAPTERS_V1: readonly ProviderAdapterRegistrationV1[] =
  Object.freeze([
    registration(
      "openrouter",
      "openrouter",
      "openrouter.env.v1",
      createOpenRouterModelGatewayFromEnv,
      hostedCapabilities,
    ),
    registration(
      "openai",
      "openai",
      "openai.env.v1",
      createOpenAiModelGatewayFromEnv,
      hostedCapabilities,
    ),
    registration(
      "anthropic",
      "anthropic",
      "anthropic.env.v1",
      createAnthropicModelGatewayFromEnv,
      anthropicCapabilities,
    ),
    registration(
      "ollama",
      "openai",
      "ollama.env.v1",
      createOllamaModelGatewayFromEnv,
      localCapabilities,
    ),
    registration(
      "lmstudio",
      "openai",
      "lmstudio.env.v1",
      createLmStudioModelGatewayFromEnv,
      localCapabilities,
    ),
    registration(
      "lumi",
      "openai",
      "lumi.managed.v1",
      createLumiModelGateway,
      hostedCapabilities,
    ),
    registration(
      "runpod",
      "openai",
      "runpod.managed.v1",
      createRunPodModelGateway,
      hostedCapabilities,
    ),
  ]);

const REGISTRY_BY_ID = new Map(
  MODEL_PROVIDER_ADAPTERS_V1.map((entry) => [entry.providerId, entry]),
);

if (
  REGISTRY_BY_ID.size !== MODEL_PROVIDER_IDENTITIES_V1.length ||
  MODEL_PROVIDER_IDENTITIES_V1.some((providerId) => !REGISTRY_BY_ID.has(providerId))
) {
  throw new Error("model provider adapter registry does not match the exact identity set");
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
  capabilityDeclaration: ModelCapabilityDescriptorV1,
): ProviderAdapterRegistrationV1 {
  return Object.freeze({
    providerId,
    protocol,
    factoryId,
    factory,
    capabilityDeclaration,
    conformanceFixture: Object.freeze({
      fixtureId: `${providerId}.text.v1`,
      request: Object.freeze({
        version: MODEL_REQUEST_VERSION,
        model: `${providerId}-conformance-fixture`,
        input: "provider registry conformance",
        responseFormat: "text",
      }),
      expectedProviderId: providerId,
    }),
  });
}

function capability(
  value: Omit<ModelCapabilityDescriptorV1, "version">,
): ModelCapabilityDescriptorV1 {
  return parseModelCapabilityDescriptorV1({
    version: MODEL_CAPABILITY_DESCRIPTOR_VERSION,
    ...value,
  });
}
