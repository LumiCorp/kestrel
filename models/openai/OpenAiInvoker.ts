import type { ModelRequest, ModelResponse } from "../../src/kestrel/contracts/model-io.js";

import type { OpenAiEnvConfig, OpenAiInvoker } from "../contracts.js";
import {
  createOpenAiBadResponseError,
  createOpenAiHttpError,
  mapOpenAiTransportError,
} from "./OpenAiErrors.js";
import { buildOpenAiHttpRequest, mapOpenAiResponse } from "./OpenAiMapper.js";

interface CreateOpenAiInvokerOptions {
  env: OpenAiEnvConfig;
  fetchImpl?: typeof fetch;
}

export function createOpenAiInvoker(options: CreateOpenAiInvokerOptions): OpenAiInvoker {
  const fetchImpl = options.fetchImpl ?? fetch;
  const providerLabel = options.env.providerLabel;

  return async <TOutput>(request: ModelRequest): Promise<ModelResponse<TOutput>> => {
    const mappedRequest = buildOpenAiHttpRequest(request, options.env);
    const url = `${trimTrailingSlash(options.env.baseUrl)}${mappedRequest.path}`;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: createHeaders(options.env),
        body: JSON.stringify(mappedRequest.body),
      });

      const requestId = response.headers.get("x-request-id") ?? undefined;
      if (response.ok === false) {
        const bodyText = await safeReadText(response);
        throw createOpenAiHttpError(response.status, bodyText, providerLabel);
      }

      const payload = await safeReadJson(response, providerLabel);
      return mapOpenAiResponse<TOutput>(payload, {
        providerName: options.env.providerName,
        requestedModel: mappedRequest.model,
        requestId,
        structuredOutput: mappedRequest.structuredOutput,
      });
    } catch (error) {
      throw mapOpenAiTransportError(error, providerLabel);
    }
  };
}

function createHeaders(env: OpenAiEnvConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.apiKey !== undefined && env.apiKey.length > 0) {
    headers.Authorization = `Bearer ${env.apiKey}`;
  }
  if (env.organization !== undefined) {
    headers["OpenAI-Organization"] = env.organization;
  }
  if (env.project !== undefined) {
    headers["OpenAI-Project"] = env.project;
  }
  return headers;
}

async function safeReadJson(response: Response, providerLabel: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw createOpenAiBadResponseError(
      `${providerLabel} returned non-JSON response: ${error instanceof Error ? error.message : "unknown"}`,
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
