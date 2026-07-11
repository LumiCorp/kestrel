export const DEFAULT_CHAT_MODEL = "openai/gpt-5-mini";

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

function titleCase(value: string) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getModelProvider(modelId: string) {
  const [provider] = modelId.split("/");
  return provider || "openai";
}

export function buildChatModel(modelId: string): ChatModel {
  const provider = getModelProvider(modelId);
  const modelName = modelId.includes("/")
    ? modelId.split("/").slice(1).join("/")
    : modelId;

  return {
    id: modelId,
    name: titleCase(modelName),
    provider,
    description: "Configured AI model",
  };
}

export function resolveChatModelId(
  modelId: string | null | undefined,
  fallbackModelId = DEFAULT_CHAT_MODEL
) {
  return modelId || fallbackModelId;
}

export const chatModels: ChatModel[] = [buildChatModel(DEFAULT_CHAT_MODEL)];

// Group models by provider for UI
export const allowedModelIds = new Set(chatModels.map((m) => m.id));

export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);
