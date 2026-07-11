import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";

import type { OpenAiEnvConfig } from "../contracts.js";
import { createOpenAiModelGatewayFromEnv, type OpenAiGatewayFactoryOptions } from "../openai/createOpenAiModelGateway.js";
import { loadLmStudioEnv } from "./LmStudioEnv.js";

export interface LmStudioGatewayFactoryOptions extends Omit<OpenAiGatewayFactoryOptions, "envConfig"> {
  envConfig?: Partial<OpenAiEnvConfig> | undefined;
}

export function createLmStudioModelGatewayFromEnv(
  options: LmStudioGatewayFactoryOptions = {},
): ModelGateway {
  const loaded = loadLmStudioEnv(options.env);
  return createOpenAiModelGatewayFromEnv({
    ...options,
    envConfig: {
      ...loaded,
      ...options.envConfig,
      providerName: "lmstudio",
      providerLabel: "LM Studio",
      model: options.envConfig?.model ?? loaded.model,
      baseUrl: options.envConfig?.baseUrl ?? loaded.baseUrl,
      apiKey: options.envConfig?.apiKey ?? loaded.apiKey,
    },
  });
}
