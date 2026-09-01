import type {
  ModelGatewayCallOptions,
  ModelRequest,
  ModelResponse,
} from "../../src/kestrel/contracts/model-io.js";
import { parseModelRequestV2 } from "../../src/kestrel/contracts/model-registration.js";

import type { AnthropicEnvConfig, AnthropicInvoker } from "../contracts.js";
import {
  createAnthropicBadResponseError,
  createAnthropicHttpError,
  mapAnthropicTransportError,
} from "./AnthropicErrors.js";
import {
  buildAnthropicHttpRequest,
  buildAnthropicHttpRequestV2,
  mapAnthropicResponse,
  mapAnthropicResponseV2,
} from "./AnthropicMapper.js";
import { readServerSentEvents } from "../SseStream.js";
import { parseRetryAfterMs } from "../../src/io/RetryAfter.js";

interface CreateAnthropicInvokerOptions {
  env: AnthropicEnvConfig;
  fetchImpl?: typeof fetch;
}

export function createAnthropicInvoker(
  options: CreateAnthropicInvokerOptions,
): AnthropicInvoker {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async <TOutput>(
    request: ModelRequest,
    callOptions: ModelGatewayCallOptions = {},
  ): Promise<ModelResponse<TOutput>> => {
    const requestV2 =
      request.version === "model_request_v2"
        ? parseModelRequestV2(request)
        : undefined;
    const mappedRequest =
      requestV2 === undefined
        ? buildAnthropicHttpRequest(request, options.env)
        : buildAnthropicHttpRequestV2(requestV2, options.env);
    const url = `${trimTrailingSlash(options.env.baseUrl)}${mappedRequest.path}`;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "x-api-key": options.env.apiKey,
          "anthropic-version": options.env.version,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...mappedRequest.body,
          ...(callOptions.onEvent !== undefined ? { stream: true } : {}),
        }),
        ...(callOptions.signal !== undefined
          ? { signal: callOptions.signal }
          : {}),
      });
      const requestId = response.headers.get("request-id") ?? undefined;
      if (response.ok === false) {
        throw createAnthropicHttpError(
          response.status,
          await safeReadText(response),
          parseRetryAfterMs(response.headers.get("retry-after")),
        );
      }

      const streamed =
        callOptions.onEvent === undefined
          ? undefined
          : await readAnthropicStream(response, callOptions);
      const payload = streamed?.payload ?? (await safeReadJson(response));
      const context = {
        requestedModel: mappedRequest.model,
        requestId,
        structuredOutput: mappedRequest.structuredOutput,
        ...(streamed?.terminalEvent !== undefined
          ? { streamTerminalEvent: streamed.terminalEvent }
          : {}),
        ...(streamed?.visibleOutputStarted !== undefined
          ? { visibleOutputStarted: streamed.visibleOutputStarted }
          : {}),
      };
      const mapped =
        requestV2 === undefined
          ? mapAnthropicResponse<TOutput>(payload, context)
          : mapAnthropicResponseV2<TOutput>(payload, context);
      if (
        callOptions.onEvent !== undefined &&
        request.reasoning !== undefined &&
        request.reasoning.mode !== "off" &&
        (mapped.reasoning?.visible.length ?? 0) === 0
      ) {
        await callOptions.onEvent({
          type: "reasoning.unavailable",
          attempt: 1,
          format: "provider_thinking",
        });
      }
      return mapped;
    } catch (error) {
      throw mapAnthropicTransportError(error);
    }
  };
}

async function readAnthropicStream(
  response: Response,
  options: ModelGatewayCallOptions,
): Promise<{
  payload: unknown;
  terminalEvent: "message_stop";
  visibleOutputStarted: boolean;
}> {
  let message: Record<string, unknown> = { content: [] };
  const blocks = new Map<number, Record<string, unknown>>();
  let reasoningStarted = false;
  let stopped = false;
  let visibleOutputStarted = false;
  await readServerSentEvents(response, async ({ data }) => {
    const event = parseJsonRecord(data);
    const type = typeof event?.type === "string" ? event.type : undefined;
    if (type === "error" && event !== undefined) {
      throw createAnthropicBadResponseError(
        readErrorMessage(event) ?? "Anthropic stream failed.",
      );
    }
    if (type === "message_start") {
      message = { ...(asRecord(event?.message) ?? {}), content: [] };
      return;
    }
    const index = typeof event?.index === "number" ? event.index : undefined;
    if (type === "content_block_start" && index !== undefined) {
      blocks.set(index, { ...(asRecord(event?.content_block) ?? {}) });
      return;
    }
    if (type === "content_block_delta" && index !== undefined) {
      const delta = asRecord(event?.delta);
      const deltaType =
        typeof delta?.type === "string" ? delta.type : undefined;
      const current = blocks.get(index) ?? {};
      if (
        deltaType === "thinking_delta" &&
        typeof delta?.thinking === "string"
      ) {
        if (!reasoningStarted) {
          reasoningStarted = true;
          await options.onEvent?.({
            type: "reasoning.started",
            attempt: 1,
            format: "provider_thinking",
          });
        }
        current.thinking = `${typeof current.thinking === "string" ? current.thinking : ""}${delta.thinking}`;
        await options.onEvent?.({
          type: "reasoning.delta",
          attempt: 1,
          format: "provider_thinking",
          delta: delta.thinking,
        });
      } else if (
        deltaType === "signature_delta" &&
        typeof delta?.signature === "string"
      ) {
        current.signature = `${typeof current.signature === "string" ? current.signature : ""}${delta.signature}`;
      } else if (
        deltaType === "text_delta" &&
        typeof delta?.text === "string"
      ) {
        current.text = `${typeof current.text === "string" ? current.text : ""}${delta.text}`;
        visibleOutputStarted = true;
        await options.onEvent?.({
          type: "output.delta",
          attempt: 1,
          delta: delta.text,
        });
      } else if (
        deltaType === "input_json_delta" &&
        typeof delta?.partial_json === "string"
      ) {
        current.__partialInput = `${typeof current.__partialInput === "string" ? current.__partialInput : ""}${delta.partial_json}`;
      }
      blocks.set(index, current);
      return;
    }
    if (type === "content_block_stop" && index !== undefined) {
      const block = blocks.get(index);
      if (block?.__partialInput !== undefined) {
        const input = parseJsonValue(String(block.__partialInput));
        if (asRecord(input) === undefined) {
          throw createAnthropicBadResponseError(
            "Anthropic stream returned malformed tool input JSON.",
          );
        }
        block.input = input;
        delete block.__partialInput;
      }
      if (block?.type === "thinking" && reasoningStarted) {
        await options.onEvent?.({
          type: "reasoning.completed",
          attempt: 1,
          format: "provider_thinking",
        });
        reasoningStarted = false;
      }
      return;
    }
    if (type === "message_delta") {
      message = {
        ...message,
        ...(asRecord(event?.delta) ?? {}),
        usage: {
          ...(asRecord(message.usage) ?? {}),
          ...(asRecord(event?.usage) ?? {}),
        },
      };
      return;
    }
    if (type === "message_stop") stopped = true;
  });
  if (!stopped) {
    throw createAnthropicBadResponseError(
      "Anthropic stream ended without message_stop.",
    );
  }
  message.content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => block);
  return {
    payload: message,
    terminalEvent: "message_stop",
    visibleOutputStarted,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  return asRecord(parseJsonValue(value));
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readErrorMessage(event: Record<string, unknown>): string | undefined {
  const error = asRecord(event.error);
  return typeof error?.message === "string" ? error.message : undefined;
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
