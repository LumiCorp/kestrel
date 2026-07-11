import type { ModelMessage, ModelRequest, ModelResponse, ModelToolIntent, ModelToolSpec } from "../../src/kestrel/contracts/model-io.js";

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
  const model = request.model ?? env.model;
  const system = toSystemPrompt(request.messages);
  const messages = toAnthropicMessages(request);
  const structuredOutput = resolveStructuredOutput(request);
  const tools = toAnthropicTools(request.tools, structuredOutput);

  const body: Record<string, unknown> = {
    model,
    messages,
  };
  if (system !== undefined) {
    body.system = system;
  }
  const temperature = provider?.temperature ?? fallback?.temperature;
  if (typeof temperature === "number") {
    body.temperature = temperature;
  }
  const maxTokens = provider?.maxTokens ?? fallback?.maxTokens;
  body.max_tokens = typeof maxTokens === "number" ? maxTokens : 2_048;
  const topP = provider?.topP ?? fallback?.topP;
  if (typeof topP === "number") {
    body.top_p = topP;
  }
  if (tools.length > 0) {
    body.tools = tools;
  }
  if (structuredOutput?.schemaName !== undefined && request.tools === undefined) {
    body.tool_choice = {
      type: "tool",
      name: structuredOutput.schemaName,
    };
  } else {
    const toolChoice = provider?.toolChoice ?? fallback?.toolChoice;
    if (typeof toolChoice === "string") {
      body.tool_choice =
        toolChoice === "required"
          ? { type: "any" }
          : toolChoice === "none"
            ? { type: "none" }
            : { type: "auto" };
    }
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
  let structuredOutputValue: TOutput | undefined;

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
    if (type === "tool_use") {
      const name = asString(record?.name);
      const input = asRecord(record?.input);
      if (name === undefined || input === undefined) {
        continue;
      }
      if (context.structuredOutput?.schemaName === name) {
        structuredOutputValue = input as TOutput;
      } else {
        toolIntents.push({
          name,
          input,
          ...(asString(record?.id) !== undefined ? { id: asString(record?.id) } : {}),
        });
      }
    }
  }

  const text = textParts.length > 0 ? textParts.join("") : undefined;
  const output = structuredOutputValue ?? parseOutput<TOutput>(text);

  return {
    output,
    ...(text !== undefined ? { text } : {}),
    toolIntents,
    usage: mapUsage(asRecord(root?.usage)),
    provider: {
      name: "anthropic",
      model: asString(root?.model) ?? context.requestedModel,
      endpoint: "chat",
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
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

function resolveStructuredOutput(
  request: ModelRequest,
): {
  mode: "constrained" | "json_object";
  schemaName?: string | undefined;
  schema?: Record<string, unknown> | undefined;
} | undefined {
  if (request.responseFormat !== "json") {
    return undefined;
  }
  if (request.responseSchema !== undefined && Array.isArray(request.tools) && request.tools.length > 0) {
    throw createAnthropicBadResponseError(
      "Anthropic gateway cannot combine request.responseSchema with request.tools in this MVP.",
    );
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
  };
}

function toAnthropicMessages(request: ModelRequest): Array<Record<string, unknown>> {
  const messages = Array.isArray(request.messages) && request.messages.length > 0
    ? request.messages.filter((message) => message.role !== "system")
    : [{
        role: "user",
        content: typeof request.input === "string" ? request.input : safeJsonStringify(request.input),
      } satisfies ModelMessage];

  return messages.map(mapAnthropicMessage);
}

function mapAnthropicMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
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
          ...(message.toolCallId !== undefined ? { tool_use_id: message.toolCallId } : {}),
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

function toSystemPrompt(messages: ModelMessage[] | undefined): string | undefined {
  if (Array.isArray(messages) === false) {
    return undefined;
  }
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content).trim())
    .filter((message) => message.length > 0);
  return system.length > 0 ? system.join("\n\n") : undefined;
}

function toAnthropicContent(content: ModelMessage["content"]): Array<Record<string, unknown>> {
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
  structuredOutput:
    | {
        mode: "constrained" | "json_object";
        schemaName?: string | undefined;
        schema?: Record<string, unknown> | undefined;
      }
    | undefined,
): Array<Record<string, unknown>> {
  const mapped: Array<Record<string, unknown>> = Array.isArray(tools)
    ? tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }))
    : [];

  if (structuredOutput?.mode === "constrained" && structuredOutput.schema !== undefined) {
    mapped.push({
      name: structuredOutput.schemaName ?? "kestrel_response",
      description: "Return the structured response payload for this turn.",
      input_schema: structuredOutput.schema,
    });
  }

  return mapped;
}

function toProviderToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_");
}

function parseOutput<TOutput>(text: string | undefined): TOutput | undefined {
  if (text === undefined) {
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as TOutput;
  } catch {
    return undefined;
  }
}

function mapUsage(value: Record<string, unknown> | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const inputTokens = asNumber(value.input_tokens);
  const outputTokens = asNumber(value.output_tokens);
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
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
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
