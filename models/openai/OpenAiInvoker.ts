import type { ModelGatewayCallOptions, ModelRequest, ModelResponse } from "../../src/kestrel/contracts/model-io.js";

import type { OpenAiEnvConfig, OpenAiInvoker } from "../contracts.js";
import {
  createOpenAiBadResponseError,
  createOpenAiHttpError,
  mapOpenAiTransportError,
} from "./OpenAiErrors.js";
import { buildOpenAiHttpRequest, mapOpenAiResponse } from "./OpenAiMapper.js";
import { readServerSentEvents } from "../SseStream.js";

interface CreateOpenAiInvokerOptions {
  env: OpenAiEnvConfig;
  fetchImpl?: typeof fetch;
}

export function createOpenAiInvoker(options: CreateOpenAiInvokerOptions): OpenAiInvoker {
  const fetchImpl = options.fetchImpl ?? fetch;
  const providerLabel = options.env.providerLabel;

  return async <TOutput>(request: ModelRequest, callOptions: ModelGatewayCallOptions = {}): Promise<ModelResponse<TOutput>> => {
    const mappedRequest = buildOpenAiHttpRequest(request, options.env);
    if (
      callOptions.onEvent !== undefined &&
      request.reasoning !== undefined &&
      request.reasoning.mode !== "off" &&
      mappedRequest.endpoint === "chat"
    ) {
      await callOptions.onEvent({ type: "reasoning.unavailable", attempt: 1, format: "summary" });
    }
    const url = `${trimTrailingSlash(options.env.baseUrl)}${mappedRequest.path}`;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: createHeaders(options.env),
        body: JSON.stringify({
          ...mappedRequest.body,
          ...(callOptions.onEvent !== undefined ? { stream: true } : {}),
        }),
        ...(callOptions.signal !== undefined ? { signal: callOptions.signal } : {}),
      });

      const requestId = response.headers.get("x-request-id") ?? undefined;
      if (response.ok === false) {
        const bodyText = await safeReadText(response);
        throw createOpenAiHttpError(response.status, bodyText, providerLabel);
      }

      const payload = callOptions.onEvent === undefined
        ? await safeReadJson(response, providerLabel)
        : await readOpenAiStream(response, mappedRequest.endpoint, callOptions);
      const mapped = mapOpenAiResponse<TOutput>(payload, {
        providerName: options.env.providerName,
        endpoint: mappedRequest.endpoint,
        requestedModel: mappedRequest.model,
        requestId,
        structuredOutput: mappedRequest.structuredOutput,
      });
      if (
        callOptions.onEvent !== undefined &&
        mappedRequest.endpoint === "responses" &&
        request.reasoning !== undefined &&
        request.reasoning.mode !== "off" &&
        (mapped.reasoning?.visible.length ?? 0) === 0
      ) {
        await callOptions.onEvent({ type: "reasoning.unavailable", attempt: 1, format: "summary" });
      }
      return mapped;
    } catch (error) {
      throw mapOpenAiTransportError(error, providerLabel);
    }
  };
}

async function readOpenAiStream(
  response: Response,
  endpoint: "chat" | "responses",
  options: ModelGatewayCallOptions,
): Promise<unknown> {
  if (endpoint === "chat") {
    return readOpenAiChatStream(response, options);
  }
  let completed: unknown;
  let reasoningStarted = false;
  await readServerSentEvents(response, async ({ data }) => {
    if (data === "[DONE]") return;
    const event = parseJsonRecord(data);
    const type = typeof event?.type === "string" ? event.type : undefined;
    if (type === "response.reasoning_summary_text.delta") {
      const delta = typeof event?.delta === "string" ? event.delta : undefined;
      if (delta === undefined) return;
      if (!reasoningStarted) {
        reasoningStarted = true;
        await options.onEvent?.({ type: "reasoning.started", attempt: 1, format: "summary" });
      }
      await options.onEvent?.({ type: "reasoning.delta", attempt: 1, format: "summary", delta });
      return;
    }
    if (type === "response.reasoning_summary_text.done" && reasoningStarted) {
      await options.onEvent?.({ type: "reasoning.completed", attempt: 1, format: "summary" });
      reasoningStarted = false;
      return;
    }
    if (type === "response.output_text.delta" && typeof event?.delta === "string") {
      await options.onEvent?.({ type: "output.delta", attempt: 1, delta: event.delta });
      return;
    }
    if (type === "response.completed") {
      completed = event?.response;
    }
  });
  if (reasoningStarted) {
    await options.onEvent?.({ type: "reasoning.completed", attempt: 1, format: "summary" });
  }
  if (completed === undefined) {
    throw createOpenAiBadResponseError("OpenAI stream ended without response.completed.");
  }
  return completed;
}

async function readOpenAiChatStream(
  response: Response,
  options: ModelGatewayCallOptions,
): Promise<unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: "", tool_calls: [] };
  const root: Record<string, unknown> = { choices: [{ message }] };
  await readServerSentEvents(response, async ({ data }) => {
    if (data === "[DONE]") return;
    const chunk = parseJsonRecord(data);
    if (chunk === undefined) return;
    if (typeof chunk.model === "string") root.model = chunk.model;
    if (chunk.usage !== undefined) root.usage = chunk.usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : undefined;
    const delta = isRecord(choice?.delta) ? choice.delta : undefined;
    if (typeof delta?.content === "string") {
      message.content = `${String(message.content ?? "")}${delta.content}`;
      await options.onEvent?.({ type: "output.delta", attempt: 1, delta: delta.content });
    }
    mergeChatToolCalls(message, Array.isArray(delta?.tool_calls) ? delta.tool_calls : []);
  });
  return root;
}

function mergeChatToolCalls(message: Record<string, unknown>, chunks: unknown[]): void {
  const target = message.tool_calls as Array<Record<string, unknown>>;
  for (const item of chunks) {
    if (!isRecord(item)) continue;
    const index = typeof item.index === "number" ? item.index : target.length;
    const current = target[index] ?? { type: "function", function: { name: "", arguments: "" } };
    const fn = isRecord(item.function) ? item.function : {};
    const currentFn = isRecord(current.function) ? current.function : {};
    target[index] = {
      ...current,
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      function: {
        ...currentFn,
        ...(typeof fn.name === "string" ? { name: `${String(currentFn.name ?? "")}${fn.name}` } : {}),
        ...(typeof fn.arguments === "string" ? { arguments: `${String(currentFn.arguments ?? "")}${fn.arguments}` } : {}),
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
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
