import type { ModelRequest, ModelResponse } from "../../src/kestrel/contracts/model-io.js";

import type { AnthropicEnvConfig, AnthropicInvoker } from "../contracts.js";
import {
  createAnthropicBadResponseError,
  createAnthropicHttpError,
  mapAnthropicTransportError,
} from "./AnthropicErrors.js";
import { buildAnthropicHttpRequest, mapAnthropicResponse } from "./AnthropicMapper.js";

interface CreateAnthropicInvokerOptions {
  env: AnthropicEnvConfig;
  fetchImpl?: typeof fetch;
}

export function createAnthropicInvoker(options: CreateAnthropicInvokerOptions): AnthropicInvoker {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async <TOutput>(request: ModelRequest): Promise<ModelResponse<TOutput>> => {
    const mappedRequest = buildAnthropicHttpRequest(request, options.env);
    const url = `${trimTrailingSlash(options.env.baseUrl)}${mappedRequest.path}`;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "x-api-key": options.env.apiKey,
          "anthropic-version": options.env.version,
          "content-type": "application/json",
        },
        body: JSON.stringify(mappedRequest.body),
      });
      const requestId = response.headers.get("request-id") ?? undefined;
      if (response.ok === false) {
        throw createAnthropicHttpError(response.status, await safeReadText(response));
      }

      const payload = await safeReadJson(response);
      return mapAnthropicResponse<TOutput>(payload, {
        requestedModel: mappedRequest.model,
        requestId,
        structuredOutput: mappedRequest.structuredOutput,
      });
    } catch (error) {
      throw mapAnthropicTransportError(error);
    }
  };
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw createAnthropicBadResponseError(
      `Anthropic returned non-JSON response: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<failed to read response body>";
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
