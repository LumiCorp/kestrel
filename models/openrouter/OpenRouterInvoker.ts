import type { ModelRequest, ModelResponse } from "../../src/kestrel/contracts/model-io.js";

import type { OpenRouterEnvConfig, OpenRouterInvoker } from "../contracts.js";
import {
  createOpenRouterBadResponseError,
  createOpenRouterHttpError,
  mapOpenRouterTransportError,
} from "./OpenRouterErrors.js";
import { buildOpenRouterHttpRequest, mapOpenRouterResponse } from "./OpenRouterMapper.js";

interface CreateOpenRouterInvokerOptions {
  env: OpenRouterEnvConfig;
  fetchImpl?: typeof fetch;
}

export function createOpenRouterInvoker(options: CreateOpenRouterInvokerOptions): OpenRouterInvoker {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async <TOutput>(request: ModelRequest): Promise<ModelResponse<TOutput>> => {
    return invokeWithDiagnostics<TOutput>(fetchImpl, options.env, request);
  };
}

async function invokeWithDiagnostics<TOutput>(
  fetchImpl: typeof fetch,
  env: OpenRouterEnvConfig,
  request: ModelRequest,
): Promise<ModelResponse<TOutput>> {
  return invokeOnce<TOutput>(fetchImpl, env, request);
}

async function invokeOnce<TOutput>(
  fetchImpl: typeof fetch,
  env: OpenRouterEnvConfig,
  request: ModelRequest,
): Promise<ModelResponse<TOutput>> {
  const mappedRequest = buildOpenRouterHttpRequest(request, env);
  const url = `${trimTrailingSlash(env.baseUrl)}${mappedRequest.path}`;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: createHeaders(env),
      body: JSON.stringify(mappedRequest.body),
    });

    const requestId = response.headers.get("x-request-id") ?? undefined;
    if (response.ok === false) {
      const bodyText = await safeReadText(response);
      throw createOpenRouterHttpError(response.status, bodyText, {
        retryAfter: response.headers.get("retry-after") ?? undefined,
      });
    }

    const payload = await safeReadJson(response);
    const payloadError = readOpenRouterPayloadError(payload);
    if (payloadError !== undefined) {
      throw createOpenRouterHttpError(payloadError.status, JSON.stringify(payload), {});
    }
    const mapped = mapOpenRouterResponse<TOutput>(payload, {
      endpoint: mappedRequest.endpoint,
      requestedModel: mappedRequest.model,
      requestId,
      structuredOutput: mappedRequest.structuredOutput,
    });
    return {
      ...mapped,
      rawResponse: payload,
    };
  } catch (error) {
    throw mapOpenRouterTransportError(error);
  }
}

function readOpenRouterPayloadError(payload: unknown): { status: number } | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return { status: typeof code === "number" ? code : 400 };
}

function createHeaders(env: OpenRouterEnvConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.apiKey}`,
    "Content-Type": "application/json",
  };

  if (env.siteUrl !== undefined) {
    headers["HTTP-Referer"] = env.siteUrl;
  }

  if (env.appName !== undefined) {
    headers["X-Title"] = env.appName;
    headers["X-OpenRouter-Title"] = env.appName;
  }

  return headers;
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw createOpenRouterBadResponseError(
      `OpenRouter returned non-JSON response: ${error instanceof Error ? error.message : "unknown"}`,
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
