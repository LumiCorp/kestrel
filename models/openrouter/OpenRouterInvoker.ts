import type { ModelGatewayCallOptions, ModelRequest, ModelResponse } from "../../src/kestrel/contracts/model-io.js";
import {
  parseModelRequestV2,
  type ModelRequestV2,
} from "../../src/kestrel/contracts/model-registration.js";

import type { OpenRouterEnvConfig, OpenRouterInvoker } from "../contracts.js";
import {
  createOpenRouterBadResponseError,
  createOpenRouterHttpError,
  mapOpenRouterTransportError,
} from "./OpenRouterErrors.js";
import { buildOpenRouterHttpRequest, mapOpenRouterResponse } from "./OpenRouterMapper.js";
import {
  buildOpenRouterHttpRequestV2,
  mapOpenRouterResponseV2,
  type OpenRouterQualifiedRouteEvidence,
} from "./OpenRouterV2Codec.js";
import { readServerSentEvents } from "../SseStream.js";

interface CreateOpenRouterInvokerOptions {
  env: OpenRouterEnvConfig;
  fetchImpl?: typeof fetch;
  routeEvidence?: OpenRouterQualifiedRouteEvidence | undefined;
}

export function createOpenRouterInvoker(options: CreateOpenRouterInvokerOptions): OpenRouterInvoker {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async <TOutput>(request: ModelRequest, callOptions: ModelGatewayCallOptions = {}): Promise<ModelResponse<TOutput>> => invokeWithDiagnostics<TOutput>(fetchImpl, options.env, request, callOptions, options.routeEvidence);
}

async function invokeWithDiagnostics<TOutput>(
  fetchImpl: typeof fetch,
  env: OpenRouterEnvConfig,
  request: ModelRequest,
  callOptions: ModelGatewayCallOptions,
  routeEvidence: OpenRouterQualifiedRouteEvidence | undefined,
): Promise<ModelResponse<TOutput>> {
  return invokeOnce<TOutput>(fetchImpl, env, request, callOptions, routeEvidence);
}

async function invokeOnce<TOutput>(
  fetchImpl: typeof fetch,
  env: OpenRouterEnvConfig,
  request: ModelRequest,
  callOptions: ModelGatewayCallOptions,
  routeEvidence: OpenRouterQualifiedRouteEvidence | undefined,
): Promise<ModelResponse<TOutput>> {
  const requestV2 = request.version === "model_request_v2"
    ? parseModelRequestV2(request)
    : undefined;
  if (requestV2 !== undefined && routeEvidence === undefined) {
    throw createOpenRouterBadResponseError(
      "OpenRouter V2 requests require exact qualified route evidence.",
    );
  }
  const mappedRequest = requestV2 === undefined
    ? buildOpenRouterHttpRequest(request, env)
    : buildOpenRouterHttpRequestV2(requestV2, env, routeEvidence!);
  const url = `${trimTrailingSlash(env.baseUrl)}${mappedRequest.path}`;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: createHeaders(env),
      body: JSON.stringify({
        ...mappedRequest.body,
        ...(callOptions.onEvent !== undefined ? { stream: true } : {}),
      }),
      ...(callOptions.signal !== undefined ? { signal: callOptions.signal } : {}),
    });

    const requestId = response.headers.get("x-request-id") ?? undefined;
    if (response.ok === false) {
      const bodyText = await safeReadText(response);
      throw createOpenRouterHttpError(response.status, bodyText, {
        retryAfter: response.headers.get("retry-after") ?? undefined,
      });
    }

    const payload = callOptions.onEvent === undefined
      ? await safeReadJson(response)
      : await readOpenRouterStream(response, mappedRequest.endpoint, callOptions);
    const payloadError = readOpenRouterPayloadError(payload);
    if (payloadError !== undefined) {
      throw createOpenRouterHttpError(payloadError.status, JSON.stringify(payload), {});
    }
    const context = {
      endpoint: mappedRequest.endpoint,
      requestedModel: mappedRequest.model,
      requestId,
      structuredOutput: mappedRequest.structuredOutput,
    };
    const mapped = requestV2 === undefined
      ? mapOpenRouterResponse<TOutput>(payload, context)
      : mapOpenRouterResponseV2<TOutput>(payload, context);
    if (
      callOptions.onEvent !== undefined &&
      request.reasoning !== undefined &&
      request.reasoning.mode !== "off" &&
      (mapped.reasoning?.visible.length ?? 0) === 0
    ) {
      await callOptions.onEvent({ type: "reasoning.unavailable", attempt: 1, format: "provider_reasoning_text" });
    }
    return mapped;
  } catch (error) {
    throw mapOpenRouterTransportError(error);
  }
}

async function readOpenRouterStream(
  response: Response,
  endpoint: "chat" | "responses",
  options: ModelGatewayCallOptions,
): Promise<unknown> {
  if (endpoint === "responses") {
    return readOpenRouterResponsesStream(response, options);
  }
  const message: Record<string, unknown> = { role: "assistant", content: "", reasoning_details: [], tool_calls: [] };
  const root: Record<string, unknown> = { choices: [{ message }] };
  const startedFormats = new Set<"summary" | "provider_reasoning_text">();
  let terminalReceived = false;
  await readServerSentEvents(response, async ({ data }) => {
    if (data === "[DONE]") {
      terminalReceived = true;
      return;
    }
    const chunk = parseJsonRecord(data);
    if (chunk === undefined) return;
    const payloadError = readOpenRouterPayloadError(chunk);
    if (payloadError !== undefined) {
      throw createOpenRouterHttpError(payloadError.status, data, {});
    }
    if (typeof chunk.model === "string") root.model = chunk.model;
    if (chunk.usage !== undefined) root.usage = chunk.usage;
    const choice = asRecord(asArray(chunk.choices)[0]);
    const delta = asRecord(choice?.delta);
    if (typeof delta?.content === "string") {
      message.content = `${String(message.content ?? "")}${delta.content}`;
      await options.onEvent?.({ type: "output.delta", attempt: 1, delta: delta.content });
    }
    const plainReasoning = typeof delta?.reasoning === "string" ? delta.reasoning : undefined;
    const details = asArray(delta?.reasoning_details);
    const visibleDeltas: Array<{ format: "summary" | "provider_reasoning_text"; text: string }> = [];
    const visibleDeltaKeys = new Set<string>();
    const addVisibleDelta = (visible: { format: "summary" | "provider_reasoning_text"; text: string }) => {
      const key = `${visible.format}\u0000${visible.text}`;
      if (visibleDeltaKeys.has(key)) return;
      visibleDeltaKeys.add(key);
      visibleDeltas.push(visible);
    };
    if (plainReasoning !== undefined) {
      addVisibleDelta({ format: "provider_reasoning_text", text: plainReasoning });
    }
    for (const item of details) {
      const detail = asRecord(item);
      if (detail?.type === "reasoning.text" && typeof detail.text === "string") {
        addVisibleDelta({ format: "provider_reasoning_text", text: detail.text });
      } else if (detail?.type === "reasoning.summary" && typeof detail.summary === "string") {
        addVisibleDelta({ format: "summary", text: detail.summary });
      }
    }
    for (const visible of visibleDeltas) {
      if (!startedFormats.has(visible.format)) {
        startedFormats.add(visible.format);
        await options.onEvent?.({ type: "reasoning.started", attempt: 1, format: visible.format });
      }
      await options.onEvent?.({ type: "reasoning.delta", attempt: 1, format: visible.format, delta: visible.text });
    }
    if (details.length > 0) {
      (message.reasoning_details as unknown[]).push(...details);
    } else if (plainReasoning !== undefined) {
      message.reasoning = `${typeof message.reasoning === "string" ? message.reasoning : ""}${plainReasoning}`;
    }
    mergeStreamingToolCalls(message, asArray(delta?.tool_calls));
  });
  for (const format of startedFormats) {
    await options.onEvent?.({ type: "reasoning.completed", attempt: 1, format });
  }
  if (terminalReceived) root.__openRouterTerminalEvent = "[DONE]";
  return root;
}

async function readOpenRouterResponsesStream(
  response: Response,
  options: ModelGatewayCallOptions,
): Promise<unknown> {
  let completed: unknown;
  let started = false;
  const functionCalls = new Map<string, Record<string, unknown>>();
  await readServerSentEvents(response, async ({ data }) => {
    if (data === "[DONE]") return;
    const event = parseJsonRecord(data);
    if (event === undefined) return;
    const error = readOpenRouterPayloadError(event);
    if (error !== undefined) throw createOpenRouterHttpError(error.status, data, {});
    if (event.type === "response.reasoning.delta" && typeof event.delta === "string") {
      if (!started) {
        started = true;
        await options.onEvent?.({ type: "reasoning.started", attempt: 1, format: "provider_reasoning_text" });
      }
      await options.onEvent?.({ type: "reasoning.delta", attempt: 1, format: "provider_reasoning_text", delta: event.delta });
    } else if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      await options.onEvent?.({ type: "output.delta", attempt: 1, delta: event.delta });
    } else if (event.type === "response.function_call_arguments.delta") {
      mergeResponsesFunctionCallDelta(functionCalls, event);
    } else if (event.type === "response.completed") {
      completed = event.response;
    }
  });
  if (started) await options.onEvent?.({ type: "reasoning.completed", attempt: 1, format: "provider_reasoning_text" });
  if (completed === undefined) throw createOpenRouterBadResponseError("OpenRouter stream ended without response.completed.");
  const root = asRecord(completed);
  if (root === undefined) {
    throw createOpenRouterBadResponseError("OpenRouter response.completed did not contain an OpenResponses object.");
  }
  const output = asArray(root.output);
  const completeCallIds = new Set(
    output
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item?.type === "function_call")
      .map((item) => asString(item.call_id) ?? asString(item.id))
      .filter((id): id is string => id !== undefined),
  );
  const streamedCalls = [...functionCalls.values()].filter((item) => {
    const id = asString(item.call_id) ?? asString(item.id);
    return id !== undefined && !completeCallIds.has(id);
  });
  return {
    ...root,
    ...(streamedCalls.length > 0 ? { output: [...output, ...streamedCalls] } : {}),
    __openRouterTerminalEvent: "response.completed",
  };
}

function mergeResponsesFunctionCallDelta(
  calls: Map<string, Record<string, unknown>>,
  event: Record<string, unknown>,
): void {
  const callId = asString(event.call_id) ?? asString(event.item_id);
  if (callId === undefined) {
    throw createOpenRouterBadResponseError(
      "OpenRouter function-argument stream event did not include a call ID.",
    );
  }
  const delta = asString(event.delta);
  if (delta === undefined) {
    throw createOpenRouterBadResponseError(
      "OpenRouter function-argument stream event did not include an argument delta.",
    );
  }
  const current = calls.get(callId) ?? {
    type: "function_call",
    call_id: callId,
    ...(asString(event.name) !== undefined ? { name: event.name } : {}),
    arguments: "",
  };
  if (asString(event.name) !== undefined && asString(current.name) === undefined) {
    current.name = event.name;
  }
  current.arguments = `${asString(current.arguments) ?? ""}${delta}`;
  calls.set(callId, current);
}

function mergeStreamingToolCalls(message: Record<string, unknown>, chunks: unknown[]): void {
  const target = message.tool_calls as Array<Record<string, unknown>>;
  for (const item of chunks) {
    const chunk = asRecord(item);
    const index = typeof chunk?.index === "number" ? chunk.index : target.length;
    const current = target[index] ?? { type: "function", function: { name: "", arguments: "" } };
    const fn = asRecord(chunk?.function);
    const currentFn = asRecord(current.function) ?? {};
    target[index] = {
      ...current,
      ...(typeof chunk?.id === "string" ? { id: chunk.id } : {}),
      function: {
        ...currentFn,
        ...(typeof fn?.name === "string" ? { name: `${String(currentFn.name ?? "")}${fn.name}` } : {}),
        ...(typeof fn?.arguments === "string" ? { arguments: `${String(currentFn.arguments ?? "")}${fn.arguments}` } : {}),
      },
    };
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try { return asRecord(JSON.parse(value)); } catch { return ; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOpenRouterPayloadError(payload: unknown): { status: number } | undefined {
  if (typeof payload !== "object" || payload === null) {
    return ;
  }
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return ;
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
