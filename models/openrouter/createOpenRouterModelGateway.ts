import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import type {
  ModelGateway,
  ModelRequest,
} from "../../src/kestrel/contracts/model-io.js";
import type { OpenRouterEnvConfig } from "../contracts.js";
import { loadOpenRouterEnv } from "./OpenRouterEnv.js";
import { createOpenRouterInvoker } from "./OpenRouterInvoker.js";

export interface OpenRouterGatewayFactoryOptions {
  env?: NodeJS.ProcessEnv | undefined;
  envConfig?: Partial<OpenRouterEnvConfig> | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  retryCount?: number | undefined;
}

export function createOpenRouterModelGatewayFromEnv(
  options: OpenRouterGatewayFactoryOptions = {}
): ModelGateway {
  const loaded = loadOpenRouterEnv({
    ...(options.env ?? process.env),
    ...(options.envConfig?.apiKey !== undefined
      ? { OPENROUTER_API_KEY: options.envConfig.apiKey }
      : {}),
  });
  const config: OpenRouterEnvConfig = {
    ...loaded,
    ...options.envConfig,
    apiKey: options.envConfig?.apiKey ?? loaded.apiKey,
    model: options.envConfig?.model ?? loaded.model,
    baseUrl: options.envConfig?.baseUrl ?? loaded.baseUrl,
  };

  const invoker = createOpenRouterInvoker({
    env: config,
    ...(options.fetchImpl !== undefined
      ? { fetchImpl: options.fetchImpl }
      : {}),
  });

  return new RetryingModelGateway(
    async <T>(request: ModelRequest) =>
      (await invoker(request)) as unknown as T,
    {
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options.retryCount !== undefined
        ? { retryCount: options.retryCount }
        : {}),
    }
  );
}
