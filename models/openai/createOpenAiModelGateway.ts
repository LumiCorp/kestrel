import type { ModelGateway, ModelRequest } from "../../src/kestrel/contracts/model-io.js";

import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import type { OpenAiEnvConfig } from "../contracts.js";
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  loadOpenAiEnv,
} from "./OpenAiEnv.js";
import { createOpenAiInvoker } from "./OpenAiInvoker.js";

export interface OpenAiGatewayFactoryOptions {
  env?: NodeJS.ProcessEnv | undefined;
  envConfig?: Partial<OpenAiEnvConfig> | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  retryCount?: number | undefined;
}

export function createOpenAiModelGatewayFromEnv(
  options: OpenAiGatewayFactoryOptions = {},
): ModelGateway {
  const useOpenAiEnvLoader = options.envConfig?.providerName === undefined || options.envConfig.providerName === "openai";
  const loaded = useOpenAiEnvLoader
    ? loadOpenAiEnv(options.env)
    : undefined;
  const config: OpenAiEnvConfig = {
    ...(loaded ?? {}),
    ...options.envConfig,
    apiKey: options.envConfig?.apiKey ?? loaded?.apiKey,
    model: options.envConfig?.model ?? loaded?.model ?? DEFAULT_OPENAI_MODEL,
    baseUrl: options.envConfig?.baseUrl ?? loaded?.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    providerName: options.envConfig?.providerName ?? loaded?.providerName ?? "openai",
    providerLabel: options.envConfig?.providerLabel ?? loaded?.providerLabel ?? "OpenAI",
  };

  const invoker = createOpenAiInvoker({
    env: config,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });

  return new RetryingModelGateway(async <T>(request: ModelRequest) => {
    return (await invoker(request)) as unknown as T;
  }, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.retryCount !== undefined ? { retryCount: options.retryCount } : {}),
  });
}
