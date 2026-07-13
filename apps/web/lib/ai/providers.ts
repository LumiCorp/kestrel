import { createOpenAI } from "@ai-sdk/openai";
import {
  customProvider,
  experimental_generateSpeech,
  extractReasoningMiddleware,
  generateImage,
  wrapLanguageModel,
} from "ai";
import { isDevelopmentEnvironment, isTestEnvironment } from "../constants";
import { getDefaultAIModel } from "./config";
import {
  listApprovedModels,
  resolveImageModelHandle,
  resolveLanguageModelHandle,
  resolveSpeechModelHandle,
} from "./gateways";
import {
  type LanguageModelUsage,
  resolveLanguageModelTransport,
} from "./model-transport";
import {
  type AISurface,
  getAISurfacePolicy,
  getDirectRuntimeConfig,
  getGatewayResolutionFailureMessage,
  warnIfPlaceholderRuntimeConfig,
} from "./surface-policy";

const THINKING_SUFFIX_REGEX = /-thinking$/;
const directRuntimeConfig = getDirectRuntimeConfig("runtime-direct");
const hasProviderKey = directRuntimeConfig.mode === "live";
const shouldUseMockProvider =
  isTestEnvironment || (isDevelopmentEnvironment && !hasProviderKey);

function createMockLanguageModels() {
  const defaultModelId = getDefaultAIModel();

  const { artifactModel, chatModel, reasoningModel, titleModel } =
    require("./models.mock");

  return customProvider({
    languageModels: {
      "chat-model": chatModel,
      "chat-model-reasoning": reasoningModel,
      "title-model": titleModel,
      "artifact-model": artifactModel,
      [defaultModelId]: chatModel,
      [`${defaultModelId}-thinking`]: reasoningModel,
    },
  });
}

export const myProvider = isTestEnvironment ? createMockLanguageModels() : null;

const localDevProvider =
  !isTestEnvironment && isDevelopmentEnvironment && !hasProviderKey
    ? createMockLanguageModels()
    : null;

function getDirectRuntimeProvider() {
  if (shouldUseMockProvider) {
    const mockProvider = myProvider ?? localDevProvider;

    if (!mockProvider) {
      throw new Error("Mock AI provider is unavailable.");
    }

    return mockProvider;
  }

  warnIfPlaceholderRuntimeConfig(directRuntimeConfig);

  if (!directRuntimeConfig.apiKey) {
    throw new Error("Missing AI_AGENT_API_KEY for direct AI runtime.");
  }

  return createOpenAI({
    apiKey: directRuntimeConfig.apiKey,
    baseURL: directRuntimeConfig.baseURL,
    headers: directRuntimeConfig.headers,
    name: directRuntimeConfig.provider,
  });
}

function getDirectRuntimeBaseLanguageModel(input: {
  modelId: string;
  usage?: LanguageModelUsage;
}) {
  const provider = getDirectRuntimeProvider();
  const transport = resolveLanguageModelTransport({
    provider: directRuntimeConfig.provider,
    usage: input.usage,
  });

  if (
    !shouldUseMockProvider &&
    transport === "chat" &&
    "chat" in provider &&
    typeof provider.chat === "function"
  ) {
    return provider.chat(input.modelId);
  }

  return provider.languageModel(input.modelId);
}

export function getDirectRuntimeLanguageModel(input: {
  modelId: string;
  surface?: "runtime-direct";
  usage?: LanguageModelUsage;
}) {
  const isReasoningModel =
    input.modelId.endsWith("-thinking") ||
    (input.modelId.includes("reasoning") &&
      !input.modelId.includes("non-reasoning"));

  if (isReasoningModel) {
    const baseModelId = input.modelId.replace(THINKING_SUFFIX_REGEX, "");

    return wrapLanguageModel({
      model: getDirectRuntimeBaseLanguageModel({
        modelId: baseModelId,
        usage: input.usage,
      }),
      middleware: extractReasoningMiddleware({ tagName: "thinking" }),
    });
  }

  return getDirectRuntimeBaseLanguageModel({
    modelId: input.modelId,
    usage: input.usage,
  });
}

type ResolvedLanguageModel = {
  model: ReturnType<typeof getDirectRuntimeLanguageModel>;
  resolvedModelId: string;
  provider: string;
};

function matchesApprovedGatewayModel(input: {
  requestedModelId?: string | null;
  approvedModels: Awaited<ReturnType<typeof listApprovedModels>>;
}) {
  if (!input.requestedModelId) {
    return input.approvedModels.length > 0;
  }

  return input.approvedModels.some(
    (model) =>
      model.id === input.requestedModelId ||
      model.alias === input.requestedModelId ||
      `${model.gatewayProvider}/${model.rawModelId}` === input.requestedModelId
  );
}

export async function resolveOptionalLanguageModel(input: {
  modelId?: string | null;
  usage?: LanguageModelUsage;
  surface: AISurface;
  organizationId?: string;
}): Promise<ResolvedLanguageModel | null> {
  if (getAISurfacePolicy(input.surface) !== "gateway-required") {
    throw new Error(
      `resolveOptionalLanguageModel cannot be used for ${input.surface} surface policy.`
    );
  }

  const resolved = await resolveLanguageModelHandle({
    selection: input.modelId,
    usage: input.usage,
    organizationId: input.organizationId,
  });

  if (!resolved) {
    return null;
  }

  return {
    model: resolved.model as ReturnType<typeof getDirectRuntimeLanguageModel>,
    resolvedModelId: resolved.resolvedModelId,
    provider: resolved.provider,
  };
}

export async function resolveRequiredLanguageModel(input: {
  modelId?: string | null;
  usage?: LanguageModelUsage;
  surface: AISurface;
  organizationId?: string;
}): Promise<ResolvedLanguageModel> {
  const resolved = await resolveOptionalLanguageModel(input);

  if (resolved) {
    return resolved;
  }

  const approvedLanguageModels = await listApprovedModels(
    "language",
    input.organizationId
  );

  console.warn("Gateway model resolution failed", {
    surface: input.surface,
    requestedModelId: input.modelId ?? null,
    gatewayRecordFound: matchesApprovedGatewayModel({
      requestedModelId: input.modelId,
      approvedModels: approvedLanguageModels,
    }),
    approvedModelCount: approvedLanguageModels.length,
  });

  throw new Error(
    getGatewayResolutionFailureMessage({
      surface: input.surface,
      modelId: input.modelId,
    })
  );
}

export async function generateSpeechForModel(input: {
  modelId?: string | null;
  text: string;
  voice?: string;
}) {
  const resolved = await resolveSpeechModelHandle(input.modelId);

  if (!resolved) {
    return null;
  }

  const result = await experimental_generateSpeech({
    model: resolved.model,
    text: input.text,
    voice: input.voice || "alloy",
    outputFormat: "mp3",
  });

  return {
    audio: result.audio,
    resolvedModelId: resolved.resolvedModelId,
    provider: resolved.provider,
  };
}

export async function generateImageForModel(input: {
  modelId?: string | null;
  prompt: string;
  size?: `${number}x${number}`;
}) {
  const resolved = await resolveImageModelHandle(input.modelId);

  if (!resolved) {
    return null;
  }

  const result = await generateImage({
    model: resolved.model,
    prompt: input.prompt,
    size: input.size,
  });

  return {
    image: result.images[0],
    resolvedModelId: resolved.resolvedModelId,
    provider: resolved.provider,
  };
}
