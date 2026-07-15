import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import type {
  ModelGateway,
  ModelGatewayCallOptions,
  ModelRequest,
} from "../../src/kestrel/contracts/model-io.js";
import type { AnthropicEnvConfig } from "../contracts.js";
import { loadAnthropicEnv } from "./AnthropicEnv.js";
import { createAnthropicInvoker } from "./AnthropicInvoker.js";

export interface AnthropicGatewayFactoryOptions {
  env?: NodeJS.ProcessEnv | undefined;
  envConfig?: Partial<AnthropicEnvConfig> | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  retryCount?: number | undefined;
}

export function createAnthropicModelGatewayFromEnv(
  options: AnthropicGatewayFactoryOptions = {}
): ModelGateway {
  const loaded = loadAnthropicEnv({
    ...(options.env ?? process.env),
    ...(options.envConfig?.apiKey !== undefined
      ? { ANTHROPIC_API_KEY: options.envConfig.apiKey }
      : {}),
  });
  const config: AnthropicEnvConfig = {
    ...loaded,
    ...options.envConfig,
    apiKey: options.envConfig?.apiKey ?? loaded.apiKey,
    model: options.envConfig?.model ?? loaded.model,
    baseUrl: options.envConfig?.baseUrl ?? loaded.baseUrl,
    version: options.envConfig?.version ?? loaded.version,
  };

  const invoker = createAnthropicInvoker({
    env: config,
    ...(options.fetchImpl !== undefined
      ? { fetchImpl: options.fetchImpl }
      : {}),
  });

  return new RetryingModelGateway(
    async <T>(request: ModelRequest, callOptions?: ModelGatewayCallOptions) =>
      (await invoker(request, callOptions)) as unknown as T,
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
