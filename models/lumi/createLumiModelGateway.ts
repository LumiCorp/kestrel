import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import type { OpenAiEnvConfig } from "../contracts.js";
import {
  createOpenAiModelGatewayFromEnv,
  type OpenAiGatewayFactoryOptions,
} from "../openai/createOpenAiModelGateway.js";

export interface LumiGatewayFactoryOptions
  extends Omit<OpenAiGatewayFactoryOptions, "envConfig"> {
  envConfig: Partial<OpenAiEnvConfig> & {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
}

export function createLumiModelGateway(
  options: LumiGatewayFactoryOptions,
): ModelGateway {
  return createOpenAiModelGatewayFromEnv({
    ...options,
    envConfig: {
      ...options.envConfig,
      providerName: "lumi",
      providerLabel: "Lumi",
    },
  });
}
