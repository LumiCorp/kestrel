import type { ModelMessage, ModelRequest, ModelResponse, ModelToolIntent, ModelToolSpec } from "../../src/kestrel/contracts/model-io.js";

import type { OpenAiEnvConfig } from "../contracts.js";
import { compileOpenRouterResponseSchema } from "../openrouter/OpenRouterSchemaCompiler.js";

export function buildOpenAiHttpRequest(
  request: ModelRequest,
  env: OpenAiEnvConfig,
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
  const openai = request.providerOptions?.openai;
  const openrouterFallback = request.providerOptions?.openrouter;
  const model = request.model ?? env.model;
  const tools = toOpenAiTools(request.tools);
  const body: Record<string, unknown> = {
    model,
    messages: toMessages(request),
  };

  const temperature = openai?.temperature ?? openrouterFallback?.temperature;
  if (typeof temperature === "number") {
    body.temperature = temperature;
  }
  const maxTokens = openai?.maxTokens ?? openrouterFallback?.maxTokens;
  if (typeof maxTokens === "number") {
    body.max_completion_tokens = maxTokens;
  }
  const topP = openai?.topP ?? openrouterFallback?.topP;
  if (typeof topP === "number") {
    body.top_p = topP;
  }
  if (tools.length > 0) {
    const toolChoice = openai?.toolChoice ?? openrouterFallback?.toolChoice;
    if (typeof toolChoice === "string") {
      body.tool_choice = toolChoice;
    }
    body.tools = tools;
    body.parallel_tool_calls = toolChoice === "required" ? false : true;
  }

  const responseFormat = toResponseFormat(request, env);
  if (responseFormat.value !== undefined) {
    body.response_format = responseFormat.value;
  }

  return {
    model,
    path: "/v1/chat/completions",
    body,
    ...(responseFormat.structuredOutput !== undefined
      ? { structuredOutput: responseFormat.structuredOutput }
      : {}),
  };
}

export function mapOpenAiResponse<TOutput>(
  payload: unknown,
  context: {
    providerName: OpenAiEnvConfig["providerName"];
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
  const choices = asArray(root?.choices);
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);

  const text = extractChatMessageText(message?.content);
  const output = parseOutput<TOutput>(text);
  const toolIntents = extractToolIntentsFromToolCalls(message?.tool_calls);

  return {
    output,
    ...(text !== undefined ? { text } : {}),
    toolIntents: dedupeToolIntents(toolIntents),
    usage: mapUsage(asRecord(root?.usage)),
    provider: {
      name: context.providerName,
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

function toMessages(request: ModelRequest): Array<Record<string, unknown>> {
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return request.messages.map((message) => mapMessage(message));
  }

  if (typeof request.input === "string") {
    return [{ role: "user", content: request.input }];
  }

  return [{ role: "user", content: safeJsonStringify(request.input) }];
}

function mapMessage(message: ModelMessage): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    role: message.role,
    content: mapContent(message.content),
  };
  if (message.name !== undefined) {
    mapped.name = toProviderToolName(message.name);
  }
  if (message.toolCallId !== undefined) {
    mapped.tool_call_id = message.toolCallId;
  }
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    mapped.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toProviderToolName(toolCall.name),
        arguments: safeJsonStringify(toolCall.input),
      },
    }));
  }
  return mapped;
}

function mapContent(content: ModelMessage["content"]): unknown {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image_url",
      image_url: {
        url: `data:${part.mimeType};base64,${part.data}`,
      },
    };
  });
}

function toOpenAiTools(tools: ModelToolSpec[] | undefined): Array<Record<string, unknown>> {
  if (Array.isArray(tools) === false) {
    return [];
  }
  return tools.map((tool) => {
    const parameters = toOpenAiFunctionParameters(tool.inputSchema);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
        ...(isOpenAiStrictSchema(parameters) ? { strict: true } : {}),
      },
    };
  });
}

function toOpenAiFunctionParameters(value: unknown): Record<string, unknown> {
  const schema = asRecord(value);
  if (schema === undefined) {
    return { type: "object", properties: {} };
  }
  const {
    allOf: _allOf,
    anyOf: _anyOf,
    const: _const,
    enum: _enum,
    not: _not,
    oneOf: _oneOf,
    ...parameters
  } = schema;
  return { ...parameters, type: "object" };
}

function isOpenAiStrictSchema(value: unknown): boolean {
  const schema = asRecord(value);
  if (schema === undefined) {
    return false;
  }

  for (const unionKey of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[unionKey];
    if (
      Array.isArray(branches) &&
      branches.some((branch) => !isOpenAiStrictSchema(branch))
    ) {
      return false;
    }
  }

  if (schema.type === "array") {
    return schema.items !== undefined && isOpenAiStrictSchema(schema.items);
  }
  if (schema.type !== "object" && schema.properties === undefined) {
    return true;
  }

  const properties = asRecord(schema.properties);
  if (!(properties && schema.additionalProperties === false)) {
    return false;
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const propertyNames = Object.keys(properties);
  return (
    propertyNames.every((name) => required.includes(name)) &&
    Object.values(properties).every((property) =>
      isOpenAiStrictSchema(property)
    )
  );
}

function toProviderToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_");
}

function toResponseFormat(
  request: ModelRequest,
  env: OpenAiEnvConfig,
): {
  value?: Record<string, unknown> | undefined;
  structuredOutput?:
    | {
        mode: "constrained" | "json_object";
        schemaName?: string | undefined;
      }
    | undefined;
} {
  if (request.responseFormat !== "json") {
    return {};
  }

  if (request.responseSchema !== undefined) {
    const schemaName =
      request.providerOptions?.openai?.responseSchemaName ??
      request.providerOptions?.openrouter?.responseSchemaName ??
      "kestrel_response";
    if (env.providerName === "ollama" || env.providerName === "lmstudio") {
      // Local OpenAI-compatible providers can reject large constrained schemas.
      // Keep JSON mode enabled, but let Kestrel validate the parsed payload itself.
      return {
        value: {
          type: "json_object",
        },
        structuredOutput: {
          mode: "json_object",
          schemaName,
        },
      };
    }
    const compiled = compileOpenRouterResponseSchema({
      schema: request.responseSchema,
      schemaName,
    });
    return {
      value: {
        ...compiled.responseFormat,
        json_schema: {
          ...compiled.responseFormat.json_schema,
          strict: true,
        },
      },
      structuredOutput: {
        mode: "constrained",
        schemaName,
      },
    };
  }

  return {
    value: {
      type: "json_object",
    },
    structuredOutput: {
      mode: "json_object",
    },
  };
}

function extractChatMessageText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) === false) {
    return undefined;
  }

  const parts: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const type = asString(record?.type);
    if (type !== "text" && type !== "output_text") {
      continue;
    }
    const text = asString(record?.text);
    if (text !== undefined) {
      parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join("") : undefined;
}

function parseOutput<TOutput>(text: string | undefined): TOutput | undefined {
  if (text === undefined) {
    return undefined;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const direct = parseJsonText<TOutput>(trimmed);
  if (direct !== undefined) {
    return direct;
  }

  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  if (fenceMatch?.[1] !== undefined) {
    const fenced = parseJsonText<TOutput>(fenceMatch[1]);
    if (fenced !== undefined) {
      return fenced;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return parseJsonText<TOutput>(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return undefined;
}

function extractToolIntentsFromToolCalls(value: unknown): ModelToolIntent[] {
  return asArray(value)
    .map((item) => asRecord(item))
    .flatMap((toolCall) => {
      const fn = asRecord(toolCall?.function);
      const name = asString(fn?.name);
      if (name === undefined) {
        return [];
      }
      const argsText = asString(fn?.arguments);
      const id = asString(toolCall?.id);
      return [{ name, input: parseArgs(argsText), ...(id !== undefined ? { id } : {}) }];
    });
}

function dedupeToolIntents(toolIntents: ModelToolIntent[]): ModelToolIntent[] {
  const seen = new Set<string>();
  const deduped: ModelToolIntent[] = [];
  for (const intent of toolIntents) {
    const key = `${intent.id ?? ""}:${intent.name}:${safeJsonStringify(intent.input)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(intent);
  }
  return deduped;
}

function mapUsage(usage: Record<string, unknown> | undefined): ModelResponse["usage"] {
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = asNumber(usage.prompt_tokens);
  const outputTokens = asNumber(usage.completion_tokens);
  const totalTokens = asNumber(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function parseArgs(value: string | undefined): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  const parsed = parseJsonText<Record<string, unknown>>(value);
  return parsed ?? {};
}

function parseJsonText<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
