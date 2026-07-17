import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";

import type { OpenAiEnvConfig } from "../contracts.js";
import { createOpenAiModelGatewayFromEnv, type OpenAiGatewayFactoryOptions } from "../openai/createOpenAiModelGateway.js";
import { loadOllamaEnv } from "./OllamaEnv.js";

export interface OllamaGatewayFactoryOptions extends Omit<OpenAiGatewayFactoryOptions, "envConfig"> {
  envConfig?: Partial<OpenAiEnvConfig> | undefined;
}

export function createOllamaModelGatewayFromEnv(
  options: OllamaGatewayFactoryOptions = {},
): ModelGateway {
  const loaded = loadOllamaEnv(options.env);
  const hasApiKeyOverride = Object.hasOwn(
    options.envConfig ?? {},
    "apiKey",
  );
  return createOpenAiModelGatewayFromEnv({
    ...options,
    envConfig: {
      ...loaded,
      ...options.envConfig,
      providerName: "ollama",
      providerLabel: "Ollama",
      model: options.envConfig?.model ?? loaded.model,
      baseUrl: options.envConfig?.baseUrl ?? loaded.baseUrl,
      apiKey: hasApiKeyOverride ? options.envConfig?.apiKey : loaded.apiKey,
    },
  });
}
