import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolIntent,
  ModelToolSpec,
} from "../../src/kestrel/contracts/model-io.js";
import {
  MODEL_RESPONSE_V2_VERSION,
  type ModelRequestV2,
  type ModelResponseV2,
} from "../../src/kestrel/contracts/model-registration.js";

import { createAnthropicBadResponseError } from "./AnthropicErrors.js";
import type { AnthropicEnvConfig } from "../contracts.js";

export function buildAnthropicHttpRequest(
  request: ModelRequest,
  env: AnthropicEnvConfig,
): {
  model: string;
  path: string;
  body: Record<string, unknown>;
  structuredOutput?:
    | {
        mode: "constrained" | "json_object";
        schemaName?: string | undefined;
      }
    | undefined;
} {
  const provider = request.providerOptions?.anthropic;
  const fallback = request.providerOptions?.openrouter;
  const requestedToolChoice = provider?.toolChoice ?? fallback?.toolChoice;
  const parallelToolCalls =
    provider?.parallelToolCalls ?? fallback?.parallelToolCalls;
  const model = request.model ?? env.model;
  const useEphemeralCache = provider?.cacheControl === "ephemeral";
  const system = toSystemPrompt(request.messages, useEphemeralCache);
  const messages = toAnthropicMessages(request);
  const structuredOutput = resolveStructuredOutput(request);
  const tools = toAnthropicTools(request.tools, useEphemeralCache);

  const body: Record<string, unknown> = {
    model,
    messages,
  };
  const outputConfig: Record<string, unknown> = {};
  if (request.reasoning !== undefined && request.reasoning.mode !== "off") {
    body.thinking = {
      type: "adaptive",
      display: "summarized",
    };
    if (request.reasoning.effort !== undefined) {
      outputConfig.effort = request.reasoning.effort;
    }
  }
  if (structuredOutput?.schema !== undefined) {
    outputConfig.format = {
      type: "json_schema",
      schema: structuredOutput.schema,
    };
  }
  if (Object.keys(outputConfig).length > 0) {
    body.output_config = outputConfig;
  }
  if (system !== undefined) {
    body.system = system;
  }
  const temperature = provider?.temperature ?? fallback?.temperature;
  if (typeof temperature === "number") {
    body.temperature = temperature;
  }
  const maxTokens = provider?.maxTokens ?? fallback?.maxTokens;
  body.max_tokens = typeof maxTokens === "number" ? maxTokens : 2048;
  const topP = provider?.topP ?? fallback?.topP;
  if (typeof topP === "number") {
    body.top_p = topP;
  }
  if (tools.length > 0) {
    body.tools = tools;
  }
  const toolChoice = requestedToolChoice;
  if (typeof toolChoice === "string") {
    body.tool_choice =
      toolChoice === "required"
        ? {
            type: "any",
            ...(parallelToolCalls === false
              ? { disable_parallel_tool_use: true }
              : {}),
          }
        : toolChoice === "none"
          ? { type: "none" }
          : {
              type: "auto",
              ...(parallelToolCalls === false
                ? { disable_parallel_tool_use: true }
                : {}),
            };
  }
  if (request.metadata !== undefined) {
    body.metadata = request.metadata;
  }

  return {
    model,
    path: "/v1/messages",
    body,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  };
}

/**
 * Anthropic's Messages API has one native endpoint.  This codec deliberately
 * takes the V2 requirements as the authority: provider options are transport
 * settings and must not silently weaken required output, tool, or reasoning
 * semantics.
 */
export function buildAnthropicHttpRequestV2(
  request: ModelRequestV2,
  env: AnthropicEnvConfig,
): ReturnType<typeof buildAnthropicHttpRequest> {
  if (request.requirements.endpoint !== "messages") {
    throw createAnthropicBadResponseError(
      "Anthropic V2 requests require the native Messages endpoint.",
    );
  }
  const model = request.model ?? env.model;
  const messages = toAnthropicMessages(request, true);
  const body: Record<string, unknown> = { model, messages };
  const outputConfig: Record<string, unknown> = {};
  const output = request.requirements.output;
  if (output.kind !== "text") {
    outputConfig.format = {
      type: "json_schema",
      schema:
        output.kind === "json_schema"
          ? request.responseSchema
          : { type: "object" },
    };
  }
  if (request.requirements.reasoning.mode !== "off") {
    body.thinking = { type: "adaptive", display: "summarized" };
    if (request.requirements.reasoning.effort !== undefined) {
      outputConfig.effort = request.requirements.reasoning.effort;
    }
  }
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
  const system = toSystemPrompt(
    request.messages,
    request.providerOptions?.anthropic?.cacheControl === "ephemeral",
  );
  if (system !== undefined) body.system = system;
  const maxTokens = request.providerOptions?.anthropic?.maxTokens;
  body.max_tokens = typeof maxTokens === "number" ? maxTokens : 2048;
  if (typeof request.providerOptions?.anthropic?.temperature === "number") {
    body.temperature = request.providerOptions.anthropic.temperature;
  }
  if (typeof request.providerOptions?.anthropic?.topP === "number") {
    body.top_p = request.providerOptions.anthropic.topP;
  }
  const tools = toAnthropicTools(
    request.tools,
    request.providerOptions?.anthropic?.cacheControl === "ephemeral",
    request.requirements.tools.strictArguments,
  );
  assertAnthropicStrictToolContract(request, tools);
  if (tools.length > 0) body.tools = tools;
  const toolRequirements = request.requirements.tools;
  if (toolRequirements.choice === "named") {
    if (toolRequirements.toolName === undefined) {
      throw createAnthropicBadResponseError(
        "Named Anthropic tool choice requires an exact tool name.",
      );
    }
    body.tool_choice = {
      type: "tool",
      name: toolRequirements.toolName,
      ...(toolRequirements.parallelism === "forbidden"
        ? { disable_parallel_tool_use: true }
        : {}),
    };
  } else if (toolRequirements.choice === "required") {
    body.tool_choice = {
      type: "any",
      ...(toolRequirements.parallelism === "forbidden"
        ? { disable_parallel_tool_use: true }
        : {}),
    };
  } else if (toolRequirements.choice === "auto") {
    body.tool_choice = {
      type: "auto",
      ...(toolRequirements.parallelism === "forbidden"
        ? { disable_parallel_tool_use: true }
        : {}),
    };
  } else {
    body.tool_choice = { type: "none" };
  }
  if (request.metadata !== undefined) body.metadata = request.metadata;
  return {
    model,
    path: "/v1/messages",
    body,
    ...(output.kind !== "text"
      ? {
          structuredOutput: {
            mode:
              output.kind === "json_schema"
                ? ("constrained" as const)
                : ("json_object" as const),
            ...(output.schemaName !== undefined
              ? { schemaName: output.schemaName }
              : {}),
          },
        }
      : {}),
  };
}

export function mapAnthropicResponse<TOutput>(
  payload: unknown,
  context: {
    requestedModel: string;
    requestId?: string | undefined;
    structuredOutput?:
      | {
          mode: "constrained" | "json_object";
          schemaName?: string | undefined;
        }
      | undefined;
  },
): ModelResponse<TOutput> {
  const root = asRecord(payload);
  const content = asArray(root?.content);
  const textParts: string[] = [];
  const toolIntents: ModelToolIntent[] = [];
  const visible: NonNullable<ModelResponse["reasoning"]>["visible"] = [];
  const continuationBlocks: Array<Record<string, unknown>> = [];

  for (const block of content) {
    const record = asRecord(block);
    const type = asString(record?.type);
    if (type === "text") {
      const text = asString(record?.text);
      if (text !== undefined) {
        textParts.push(text);
      }
      continue;
    }
    if (type === "thinking") {
      const thinking = asString(record?.thinking);
      if (thinking !== undefined && thinking.length > 0) {
        visible.push({ format: "provider_thinking", text: thinking });
      }
      if (record?.signature !== undefined) {
        continuationBlocks.push(record);
      }
      continue;
    }
    if (type === "redacted_thinking") {
      if (
        record?.signature === undefined ||
        asString(record?.data) === undefined
      ) {
        throw createAnthropicBadResponseError(
          "Anthropic returned a redacted-thinking block without native opaque state.",
        );
      }
      continuationBlocks.push(record);
      continue;
    }
    if (type === "tool_use") {
      const name = asString(record?.name);
      const input = asRecord(record?.input);
      if (name === undefined || input === undefined) {
        throw createAnthropicBadResponseError(
          "Anthropic returned a tool-use block without a valid name and object input.",
        );
      }
      toolIntents.push({
        name,
        input,
        ...(asString(record?.id) !== undefined
          ? { id: asString(record?.id) }
          : {}),
      });
    }
  }

  const text = textParts.length > 0 ? textParts.join("") : undefined;
  const output = parseOutput<TOutput>(text, context.structuredOutput);
  const continuation: NonNullable<ModelResponse["reasoning"]>["continuation"] =
    continuationBlocks.length === 0
      ? []
      : [
          {
            provider: "anthropic",
            kind: "signature",
            value:
              continuationBlocks.length === 1
                ? continuationBlocks[0]
                : continuationBlocks,
          },
        ];

  return {
    output,
    ...(text !== undefined ? { text } : {}),
    toolIntents,
    usage: mapUsage(asRecord(root?.usage)),
    ...(visible.length > 0 || continuation.length > 0
      ? { reasoning: { visible, continuation } }
      : {}),
    provider: {
      name: "anthropic",
      model: asString(root?.model) ?? context.requestedModel,
      endpoint: "messages",
      ...(context.requestId !== undefined
        ? { requestId: context.requestId }
        : {}),
      ...(context.structuredOutput !== undefined
        ? {
            structuredOutput: {
              mode: context.structuredOutput.mode,
              outcome: "success",
              ...(context.structuredOutput.schemaName !== undefined
                ? { schemaName: context.structuredOutput.schemaName }
                : {}),
            },
          }
        : {}),
    },
  };
}

/** Provider-owned terminal proof and exact Messages endpoint identity for V2. */
export function mapAnthropicResponseV2<TOutput>(
  payload: unknown,
  context: Parameters<typeof mapAnthropicResponse>[1] & {
    streamTerminalEvent?: string | undefined;
    visibleOutputStarted?: boolean | undefined;
  },
): ModelResponseV2<TOutput> {
  const mapped = mapAnthropicResponse<TOutput>(payload, context);
  const terminal = anthropicTerminal(payload, context.streamTerminalEvent);
  return {
    ...mapped,
    version: MODEL_RESPONSE_V2_VERSION,
    terminal: {
      ...terminal,
      visibleOutputStarted:
        context.visibleOutputStarted ??
        (mapped.text !== undefined || mapped.toolIntents.length > 0),
    },
    validation:
      terminal.state === "completed"
        ? { state: "not_requested" }
        : {
            state: "failed",
            failureCode: `MODEL_${terminal.state.toUpperCase()}_RESPONSE`,
          },
  };
}

function anthropicTerminal(
  payload: unknown,
  streamTerminalEvent: string | undefined,
): Omit<ModelResponseV2["terminal"], "visibleOutputStarted"> {
  const root = asRecord(payload);
  const stopReason = asString(root?.stop_reason);
  if (
    streamTerminalEvent !== undefined &&
    streamTerminalEvent !== "message_stop"
  ) {
    return { state: "malformed", providerTerminalEvent: streamTerminalEvent };
  }
  const providerTerminalEvent = streamTerminalEvent ?? "message";
  switch (stopReason) {
    case "end_turn":
    case "tool_use":
      return { state: "completed", providerTerminalEvent };
    case "max_tokens":
      return { state: "truncated", providerTerminalEvent };
    case "refusal":
      return { state: "refused", providerTerminalEvent };
    case "pause_turn":
    case "stop_sequence":
      return { state: "incomplete", providerTerminalEvent };
    case undefined:
      return {
        state: "malformed",
        ...(streamTerminalEvent !== undefined ? { providerTerminalEvent } : {}),
      };
    default:
      return { state: "interrupted", providerTerminalEvent };
  }
}

function resolveStructuredOutput(request: ModelRequest):
  | {
      mode: "constrained" | "json_object";
      schemaName?: string | undefined;
      schema?: Record<string, unknown> | undefined;
    }
  | undefined {
  if (request.responseFormat !== "json") {
    return;
  }
  if (request.responseSchema !== undefined) {
    return {
      mode: "constrained",
      schemaName:
        request.providerOptions?.anthropic?.responseSchemaName ??
        request.providerOptions?.openai?.responseSchemaName ??
        request.providerOptions?.openrouter?.responseSchemaName ??
        "kestrel_response",
      schema: request.responseSchema,
    };
  }
  return {
    mode: "json_object",
    schema: { type: "object" },
  };
}

function toAnthropicMessages(
  request: ModelRequest,
  strictContinuation = false,
): Array<Record<string, unknown>> {
  const messages =
    Array.isArray(request.messages) && request.messages.length > 0
      ? request.messages.filter((message) => message.role !== "system")
      : [
          {
            role: "user",
            content:
              typeof request.input === "string"
                ? request.input
                : safeJsonStringify(request.input),
          } satisfies ModelMessage,
        ];

  const mapped = messages.map(mapAnthropicMessage);
  const continuations = request.reasoning?.continuation ?? [];
  if (
    strictContinuation &&
    continuations.some(
      (item) => item.provider !== "anthropic" || item.kind !== "signature",
    )
  ) {
    throw createAnthropicBadResponseError(
      "Anthropic Messages cannot encode a continuation from another provider or kind.",
    );
  }
  const continuation = continuations
    .filter(
      (item) => item.provider === "anthropic" && item.kind === "signature",
    )
    .flatMap((item) => toAnthropicThinkingContinuationBlocks(item.value));
  if (
    strictContinuation &&
    continuation.some((item) => !isAnthropicThinkingContinuationBlock(item))
  ) {
    throw createAnthropicBadResponseError(
      "Anthropic continuation must preserve a native thinking or redacted-thinking block.",
    );
  }
  const thinkingContinuation = continuation.filter(
    isAnthropicThinkingContinuationBlock,
  );
  if (thinkingContinuation.length === 0) {
    return mapped;
  }
  for (let index = mapped.length - 1; index >= 0; index -= 1) {
    const message = mapped[index];
    if (message?.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    mapped[index] = {
      ...message,
      content: [...thinkingContinuation, ...content],
    };
    return mapped;
  }
  if (strictContinuation) {
    throw createAnthropicBadResponseError(
      "Anthropic continuation requires the preceding assistant message.",
    );
  }
  return mapped;
}

function mapAnthropicMessage(message: ModelMessage): Record<string, unknown> {
  if (
    message.role === "assistant" &&
    Array.isArray(message.toolCalls) &&
    message.toolCalls.length > 0
  ) {
    const text = contentText(message.content).trim();
    const content = [
      ...(text.length > 0 ? [{ type: "text", text }] : []),
      ...message.toolCalls.map((toolCall) => ({
        type: "tool_use",
        id: toolCall.id,
        name: toProviderToolName(toolCall.name),
        input: toolCall.input,
      })),
    ];
    return {
      role: "assistant",
      content,
    };
  }
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          ...(message.toolCallId !== undefined
            ? { tool_use_id: message.toolCallId }
            : {}),
          content: contentText(message.content),
        },
      ],
    };
  }
  return {
    role: message.role,
    content: toAnthropicContent(message.content),
  };
}

function toSystemPrompt(
  messages: ModelMessage[] | undefined,
  useEphemeralCache: boolean,
): string | Array<Record<string, unknown>> | undefined {
  if (Array.isArray(messages) === false) {
    return;
  }
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content).trim())
    .filter((message) => message.length > 0);
  if (system.length === 0) return;
  const text = system.join("\n\n");
  return useEphemeralCache
    ? [{ type: "text", text, cache_control: { type: "ephemeral" } }]
    : text;
}

function toAnthropicContent(
  content: ModelMessage["content"],
): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: part.mimeType,
        data: part.data,
      },
    };
  });
}

function contentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function toAnthropicTools(
  tools: ModelToolSpec[] | undefined,
  useEphemeralCache: boolean,
  strict = false,
): Array<Record<string, unknown>> {
  const mapped: Array<Record<string, unknown>> = Array.isArray(tools)
    ? tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        ...(strict ? { strict: true } : {}),
      }))
    : [];

  if (useEphemeralCache && mapped.length > 0) {
    const finalTool = mapped[mapped.length - 1];
    if (finalTool !== undefined) {
      mapped[mapped.length - 1] = {
        ...finalTool,
        cache_control: { type: "ephemeral" },
      };
    }
  }

  return mapped;
}

function assertAnthropicStrictToolContract(
  request: ModelRequestV2,
  tools: Array<Record<string, unknown>>,
): void {
  const requirements = request.requirements.tools;
  if (!requirements.strictArguments) return;
  if (requirements.choice === "none" || tools.length === 0) {
    throw createAnthropicBadResponseError(
      "Anthropic strict tool input requires at least one native tool and a non-none tool choice.",
    );
  }
  if (
    requirements.choice === "named" &&
    !tools.some((tool) => tool.name === requirements.toolName)
  ) {
    throw createAnthropicBadResponseError(
      "Anthropic strict tool input requires the named native tool to be present.",
    );
  }
}

function isAnthropicThinkingContinuationBlock(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> {
  return value?.type === "thinking" || value?.type === "redacted_thinking";
}

function toAnthropicThinkingContinuationBlocks(
  value: unknown,
): Array<Record<string, unknown> | undefined> {
  const block = asRecord(value);
  if (block !== undefined) return [block];
  const blocks = asArray(value);
  return blocks === undefined ? [undefined] : blocks.map(asRecord);
}

function toProviderToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_");
}

function parseOutput<TOutput>(
  text: string | undefined,
  structuredOutput:
    | { mode: "constrained" | "json_object"; schemaName?: string | undefined }
    | undefined,
): TOutput | undefined {
  if (text === undefined) {
    return;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  try {
    return JSON.parse(trimmed) as TOutput;
  } catch {
    if (structuredOutput !== undefined) {
      throw createAnthropicBadResponseError(
        "Anthropic structured output was not one complete JSON value.",
      );
    }
    return;
  }
}

function mapUsage(value: Record<string, unknown> | undefined) {
  if (value === undefined) {
    return;
  }
  const directInputTokens = asNumber(value.input_tokens);
  const outputTokens = asNumber(value.output_tokens);
  const cachedInputTokens = asNumber(value.cache_read_input_tokens);
  const cacheWriteInputTokens = asNumber(value.cache_creation_input_tokens);
  const inputTokens =
    directInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheWriteInputTokens !== undefined
      ? (directInputTokens ?? 0) +
        (cachedInputTokens ?? 0) +
        (cacheWriteInputTokens ?? 0)
      : undefined;
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
