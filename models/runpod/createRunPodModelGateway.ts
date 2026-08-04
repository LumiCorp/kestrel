import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import type { OpenAiEnvConfig } from "../contracts.js";
import {
  createOpenAiModelGatewayFromEnv,
  type OpenAiGatewayFactoryOptions,
} from "../openai/createOpenAiModelGateway.js";

export interface RunPodGatewayFactoryOptions
  extends Omit<OpenAiGatewayFactoryOptions, "envConfig"> {
  envConfig: Partial<OpenAiEnvConfig> & {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
}

export function createRunPodModelGateway(
  options: RunPodGatewayFactoryOptions,
): ModelGateway {
  return createOpenAiModelGatewayFromEnv({
    ...options,
    envConfig: {
      ...options.envConfig,
      providerName: "runpod",
      providerLabel: "RunPod",
    },
  });
}
