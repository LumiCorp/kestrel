import type { ModelMessage, ModelRequest, ModelResponse, ModelToolIntent, ModelToolSpec } from "../../src/kestrel/contracts/model-io.js";

import type {
  OpenRouterEndpoint,
  OpenRouterEnvConfig,
  OpenRouterHttpRequest,
  OpenRouterResponseContext,
} from "../contracts.js";
import { createOpenRouterBadResponseError } from "./OpenRouterErrors.js";
import { compileOpenRouterResponseSchema } from "./OpenRouterSchemaCompiler.js";

export function resolveOpenRouterEndpoint(request: ModelRequest): OpenRouterEndpoint {
  return request.providerOptions?.openrouter?.endpoint ?? "chat";
}

export function resolveOpenRouterModel(
  request: ModelRequest,
  env: OpenRouterEnvConfig,
): string {
  return request.model ?? env.model;
}

export function buildOpenRouterHttpRequest(
  request: ModelRequest,
  env: OpenRouterEnvConfig,
): OpenRouterHttpRequest {
  const endpoint = resolveOpenRouterEndpoint(request);
  const model = resolveOpenRouterModel(request, env);

  if (endpoint === "responses") {
    const payload = buildResponsesBody(request, model);
    return {
      endpoint,
      model,
      path: "/api/v1/responses",
      body: payload.body,
      ...(payload.structuredOutput !== undefined
        ? { structuredOutput: payload.structuredOutput }
        : {}),
    };
  }

  const payload = buildChatBody(request, model);
  return {
    endpoint,
    model,
    path: "/api/v1/chat/completions",
    body: payload.body,
    ...(payload.structuredOutput !== undefined
      ? { structuredOutput: payload.structuredOutput }
      : {}),
  };
}

export function mapOpenRouterResponse<TOutput>(
  payload: unknown,
  context: OpenRouterResponseContext,
): ModelResponse<TOutput> {
  if (context.endpoint === "responses") {
    return mapResponsesPayload<TOutput>(payload, context);
  }

  return mapChatPayload<TOutput>(payload, context);
}

function buildChatBody(
  request: ModelRequest,
  model: string,
): {
  body: Record<string, unknown>;
  structuredOutput?:
    | {
        mode: "constrained" | "json_object";
        schemaName?: string | undefined;
        compilerDiagnostics?: Record<string, unknown> | undefined;
      }
    | undefined;
} {
  const messages = toMessages(request);
  const tools = toOpenRouterTools(request.tools);
  const openrouter = request.providerOptions?.openrouter;

  const body: Record<string, unknown> = {
    model,
    messages,
  };
  applyReasoningRequest(body, request);

  if (typeof openrouter?.temperature === "number") {
    body.temperature = openrouter.temperature;
  }
  if (typeof openrouter?.maxTokens === "number") {
    body.max_tokens = openrouter.maxTokens;
  }
  if (typeof openrouter?.topP === "number") {
    body.top_p = openrouter.topP;
  }
  const toolChoice = mapOpenRouterToolChoice(openrouter?.toolChoice);
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice;
  }
  if (tools.length > 0) {
    body.tools = tools;
    body.parallel_tool_calls = toolChoice === "required" ? false : true;
  }

  const responseFormat = toResponseFormat(request);
  if (responseFormat.value !== undefined) {
    body.response_format = responseFormat.value;
  }

  if (request.metadata !== undefined) {
    body.metadata = request.metadata;
  }

  return {
    body,
    ...(responseFormat.structuredOutput !== undefined
      ? { structuredOutput: responseFormat.structuredOutput }
      : {}),
  };
}

function buildResponsesBody(
  request: ModelRequest,
  model: string,
): {
  body: Record<string, unknown>;
  structuredOutput?:
    | {
        mode: "constrained" | "json_object";
        schemaName?: string | undefined;
        compilerDiagnostics?: Record<string, unknown> | undefined;
      }
    | undefined;
} {
  const openrouter = request.providerOptions?.openrouter;
  const tools = toOpenRouterTools(request.tools);

  const body: Record<string, unknown> = {
    model,
    input: toResponsesInput(request),
  };
  applyReasoningRequest(body, request);

  if (typeof openrouter?.temperature === "number") {
    body.temperature = openrouter.temperature;
  }
  if (typeof openrouter?.maxTokens === "number") {
    body.max_output_tokens = openrouter.maxTokens;
  }
  if (typeof openrouter?.topP === "number") {
    body.top_p = openrouter.topP;
  }
  const toolChoice = mapOpenRouterToolChoice(openrouter?.toolChoice);
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice;
  }
  if (tools.length > 0) {
    body.tools = tools;
    body.parallel_tool_calls = toolChoice === "required" ? false : true;
  }

  const responseFormat = toResponseFormat(request);
  if (responseFormat.value !== undefined) {
    body.response_format = responseFormat.value;
  }

  if (request.metadata !== undefined) {
    body.metadata = request.metadata;
  }

  return {
    body,
    ...(responseFormat.structuredOutput !== undefined
      ? { structuredOutput: responseFormat.structuredOutput }
      : {}),
  };
}

function mapOpenRouterToolChoice(toolChoice: unknown): string | undefined {
  if (typeof toolChoice !== "string") {
    return undefined;
  }
  return toolChoice;
}

function toResponseFormat(request: ModelRequest): {
  value?: Record<string, unknown> | undefined;
  structuredOutput?:
    | {
        mode: "constrained" | "json_object";
        schemaName?: string | undefined;
        compilerDiagnostics?: Record<string, unknown> | undefined;
      }
    | undefined;
} {
  if (request.responseFormat !== "json") {
    return {};
  }

  const responseSchema = request.responseSchema;
  if (responseSchema !== undefined) {
    const schemaName = request.providerOptions?.openrouter?.responseSchemaName ?? "kestrel_response";
    const compiled = compileOpenRouterResponseSchema({
      schema: responseSchema,
      schemaName,
    });

    return {
      value: compiled.responseFormat,
      structuredOutput: {
        mode: "constrained",
        schemaName,
        compilerDiagnostics: compiled.diagnostics,
      },
    };
  }

  const schemaName = request.providerOptions?.openrouter?.responseSchemaName;
  return {
    value: {
      type: "json_object",
    },
    structuredOutput: {
      mode: "json_object",
      ...(schemaName !== undefined ? { schemaName } : {}),
    },
  };
}

function toMessages(request: ModelRequest): Array<Record<string, unknown>> {
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    const mapped = request.messages.map((message) => mapMessage(message));
    applyOpenRouterContinuation(mapped, request);
    return mapped;
  }

  if (typeof request.input === "string") {
    return [{ role: "user", content: request.input }];
  }

  return [
    {
      role: "user",
      content: safeJsonStringify(request.input),
    },
  ];
}

function applyReasoningRequest(body: Record<string, unknown>, request: ModelRequest): void {
  if (request.reasoning === undefined || request.reasoning.mode === "off") return;
  body.reasoning = {
    exclude: false,
    ...(request.reasoning.effort !== undefined ? { effort: request.reasoning.effort } : {}),
  };
}

function applyOpenRouterContinuation(
  messages: Array<Record<string, unknown>>,
  request: ModelRequest,
): void {
  const details = (request.reasoning?.continuation ?? [])
    .filter((item) => item.provider === "openrouter" && item.kind === "reasoning_details")
    .flatMap((item) => Array.isArray(item.value) ? item.value : [item.value]);
  if (details.length === 0) return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "assistant") continue;
    messages[index] = { ...messages[index], reasoning_details: details };
    break;
  }
}

function toResponsesInput(request: ModelRequest): unknown {
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return request.messages.flatMap((message) => mapResponsesMessage(message));
  }

  return typeof request.input === "string" ? request.input : safeJsonStringify(request.input);
}

function mapMessage(message: ModelMessage): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    role: message.role,
    content: mapChatContent(message.content),
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

function mapResponsesMessage(message: ModelMessage): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (text.length > 0) {
      items.push({
        role: "assistant",
        content: mapResponsesContent(message.content),
      });
    }
    for (const toolCall of message.toolCalls) {
      items.push({
        type: "function_call",
        call_id: toolCall.id,
        name: toProviderToolName(toolCall.name),
        arguments: safeJsonStringify(toolCall.input),
      });
    }
    return items;
  }

  if (message.role === "tool") {
    const callId = message.toolCallId;
    return [
      {
        type: "function_call_output",
        ...(callId !== undefined ? { call_id: callId } : {}),
        output: typeof message.content === "string" ? message.content : safeJsonStringify(message.content),
      },
    ];
  }

  return [
    {
      role: message.role,
      content: mapResponsesContent(message.content),
    },
  ];
}

function mapChatContent(content: ModelMessage["content"]): unknown {
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

function mapResponsesContent(content: ModelMessage["content"]): unknown[] {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  return content.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` },
  );
}

function toOpenRouterTools(tools: ModelToolSpec[] | undefined): Array<Record<string, unknown>> {
  if (Array.isArray(tools) === false) {
    return [];
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function toProviderToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function mapChatPayload<TOutput>(
  payload: unknown,
  context: OpenRouterResponseContext,
): ModelResponse<TOutput> {
  const root = asRecord(payload);
  const choices = asArray(root?.choices);
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const parsedOutput = firstDefined([
    parseStructuredOutput<TOutput>(message?.parsed),
    parseStructuredOutput<TOutput>(firstChoice?.parsed),
    parseStructuredOutput<TOutput>(firstChoice?.output_parsed),
    parseStructuredOutput<TOutput>(root?.output_parsed),
  ]);
  const text =
    extractChatMessageText(message ?? asRecord(firstChoice?.delta) ?? firstChoice) ??
    asString(firstChoice?.text) ??
    asString(root?.output_text) ??
    extractOutputTextFromResponses(root?.output) ??
    extractChatMessageText(root?.output);
  const textOutput = parsedOutput === undefined ? parseOutput<TOutput>(text) : undefined;
  const output = parsedOutput ?? textOutput;
  const toolIntents = extractToolIntentsFromOpenAIToolCalls(message?.tool_calls);
  const reasoning = extractOpenRouterChatReasoning(message);

  return {
    output,
    ...(text !== undefined ? { text } : {}),
    toolIntents: dedupeToolIntents(toolIntents),
    usage: mapUsage(asRecord(root?.usage), "chat"),
    ...(reasoning !== undefined ? { reasoning } : {}),
    provider: {
      name: "openrouter",
      model: asString(root?.model) ?? context.requestedModel,
      endpoint: "chat",
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      ...(context.structuredOutput !== undefined
        ? {
            structuredOutput: buildStructuredOutputTelemetry(
              context.structuredOutput,
              parsedOutput !== undefined ? "provider" : textOutput !== undefined ? "text_fallback" : "none",
            ),
          }
        : {}),
    },
  };
}

function mapResponsesPayload<TOutput>(
  payload: unknown,
  context: OpenRouterResponseContext,
): ModelResponse<TOutput> {
  const root = asRecord(payload);
  const outputText = asString(root?.output_text) ?? extractOutputTextFromResponses(root?.output);
  const output = parseOutput<TOutput>(outputText);

  const toolIntents = extractToolIntentsFromResponsesOutput(root?.output);
  const reasoning = extractOpenRouterResponsesReasoning(root?.output);

  return {
    output,
    ...(outputText !== undefined ? { text: outputText } : {}),
    toolIntents: dedupeToolIntents(toolIntents),
    usage: mapUsage(asRecord(root?.usage), "responses"),
    ...(reasoning !== undefined ? { reasoning } : {}),
    provider: {
      name: "openrouter",
      model: asString(root?.model) ?? context.requestedModel,
      endpoint: "responses",
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      ...(context.structuredOutput !== undefined
        ? {
            structuredOutput: buildStructuredOutputTelemetry(
              context.structuredOutput,
              output !== undefined ? "text_fallback" : "none",
            ),
          }
        : {}),
    },
  };
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function buildStructuredOutputTelemetry(
  structuredOutput: NonNullable<OpenRouterResponseContext["structuredOutput"]>,
  source: "provider" | "text_fallback" | "none",
): NonNullable<ModelResponse["provider"]["structuredOutput"]> {
  return {
    mode: structuredOutput.mode,
    outcome: source === "provider"
      ? "provider_parsed"
      : source === "text_fallback"
        ? "text_fallback_parsed"
        : "parse_failed",
    source,
    schemaRequested: true,
    ...(structuredOutput.schemaName !== undefined
      ? { schemaName: structuredOutput.schemaName }
      : {}),
    ...(structuredOutput.compilerDiagnostics !== undefined
      ? { compilerDiagnostics: structuredOutput.compilerDiagnostics }
      : {}),
  };
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
    const sliced = parseJsonText<TOutput>(trimmed.slice(firstBrace, lastBrace + 1));
    if (sliced !== undefined) {
      return sliced;
    }
  }

  return undefined;
}

function parseStructuredOutput<TOutput>(value: unknown): TOutput | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return parseOutput<TOutput>(value);
  }
  if (typeof value === "object") {
    return value as TOutput;
  }
  return undefined;
}

function parseJsonText<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function extractToolIntentsFromOpenAIToolCalls(value: unknown): ModelToolIntent[] {
  return asArray(value)
    .map((item) => asRecord(item))
    .flatMap((toolCall) => {
      const fn = asRecord(toolCall?.function);
      const name = asString(fn?.name);
      if (name === undefined) {
        return [];
      }

      const argumentsText = asString(fn?.arguments);
      const input = parseArgs(argumentsText);
      const id = asString(toolCall?.id);
      return [{ name, input, ...(id !== undefined ? { id } : {}) }];
    });
}

function extractToolIntentsFromResponsesOutput(value: unknown): ModelToolIntent[] {
  const outputBlocks = asArray(value);
  const intents: ModelToolIntent[] = [];

  for (const block of outputBlocks) {
    const blockRecord = asRecord(block);
    for (const item of asArray(blockRecord?.content)) {
      const record = asRecord(item);
      const type = asString(record?.type);
      if (type !== "function_call" && type !== "tool_call") {
        continue;
      }

      const name = asString(record?.name);
      if (name === undefined) {
        continue;
      }

      const argsValue = record?.arguments;
      const argsText =
        typeof argsValue === "string" ? argsValue : safeJsonStringify(argsValue ?? {});
      const id = asString(record?.id);
      intents.push({
        name,
        input: parseArgs(argsText),
        ...(id !== undefined ? { id } : {}),
      });
    }
  }

  return intents;
}

function mapUsage(
  usage: Record<string, unknown> | undefined,
  endpoint: OpenRouterEndpoint,
): ModelResponse["usage"] {
  if (usage === undefined) {
    return undefined;
  }

  if (endpoint === "responses") {
    const inputTokens = asNumber(usage.input_tokens);
    const outputTokens = asNumber(usage.output_tokens);
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

function extractOutputTextFromResponses(value: unknown): string | undefined {
  const outputBlocks = asArray(value);
  const parts: string[] = [];

  for (const block of outputBlocks) {
    const blockRecord = asRecord(block);
    for (const item of asArray(blockRecord?.content)) {
      const record = asRecord(item);
      const type = asString(record?.type);
      if (type !== "output_text") {
        continue;
      }

      const text = asString(record?.text);
      if (text !== undefined) {
        parts.push(text);
      }
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join("\n");
}

function extractChatMessageText(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct !== undefined) {
    return direct;
  }

  const valueRecord = asRecord(value);
  if (valueRecord !== undefined) {
    const nestedContent = extractChatMessageText(valueRecord.content);
    if (nestedContent !== undefined) {
      return nestedContent;
    }
  }

  const textValueObject = asRecord(valueRecord?.text);
  const textValue = asString(textValueObject?.value);
  if (textValue !== undefined) {
    return textValue;
  }

  const textFromRecord = asString(valueRecord?.text);
  if (textFromRecord !== undefined) {
    return textFromRecord;
  }

  const outputText = asString(valueRecord?.output_text);
  if (outputText !== undefined) {
    return outputText;
  }

  const refusalText = asString(valueRecord?.refusal);
  if (refusalText !== undefined) {
    return refusalText;
  }

  const chunks = asArray(value)
    .map((item) => extractChatMessageText(item))
    .filter((item): item is string => item !== undefined && item.length > 0);

  if (chunks.length === 0) {
    return undefined;
  }

  return chunks.join("\n");
}

function extractOpenRouterChatReasoning(
  message: Record<string, unknown> | undefined,
): ModelResponse["reasoning"] | undefined {
  if (message === undefined) return undefined;
  const visible: NonNullable<ModelResponse["reasoning"]>["visible"] = [];
  const details = asArray(message.reasoning_details);
  for (const detail of details) {
    const record = asRecord(detail);
    const type = asString(record?.type);
    if (type === "reasoning.text" && asString(record?.text) !== undefined) {
      visible.push({ format: "provider_reasoning_text", text: asString(record?.text) as string });
    } else if (type === "reasoning.summary" && asString(record?.summary) !== undefined) {
      visible.push({ format: "summary", text: asString(record?.summary) as string });
    }
  }
  const plainReasoning = asString(message.reasoning);
  if (plainReasoning !== undefined && plainReasoning.length > 0 && visible.length === 0) {
    visible.push({ format: "provider_reasoning_text", text: plainReasoning });
  }
  const continuation = details.length > 0
    ? [{ provider: "openrouter" as const, kind: "reasoning_details" as const, value: details }]
    : [];
  return visible.length > 0 || continuation.length > 0 ? { visible, continuation } : undefined;
}

function extractOpenRouterResponsesReasoning(value: unknown): ModelResponse["reasoning"] | undefined {
  const visible: NonNullable<ModelResponse["reasoning"]>["visible"] = [];
  const continuation: NonNullable<ModelResponse["reasoning"]>["continuation"] = [];
  for (const item of asArray(value)) {
    const record = asRecord(item);
    if (asString(record?.type) !== "reasoning") continue;
    const summary = asArray(record?.summary)
      .map((part) => asString(asRecord(part)?.text) ?? asString(part))
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n");
    if (summary.length > 0) visible.push({ format: "summary", text: summary });
    const reasoningText = asString(record?.reasoning);
    if (reasoningText !== undefined && reasoningText.length > 0) {
      visible.push({ format: "provider_reasoning_text", text: reasoningText });
    }
    if (record?.encrypted_content !== undefined) {
      continuation.push({ provider: "openrouter", kind: "reasoning_details", value: record });
    }
  }
  return visible.length > 0 || continuation.length > 0 ? { visible, continuation } : undefined;
}

function parseArgs(value: string | undefined): Record<string, unknown> {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function dedupeToolIntents(intents: ModelToolIntent[]): ModelToolIntent[] {
  const seen = new Set<string>();
  const output: ModelToolIntent[] = [];

  for (const intent of intents) {
    const key = `${intent.id ?? ""}:${intent.name}:${safeJsonStringify(intent.input)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(intent);
  }

  return output;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw createOpenRouterBadResponseError("Failed to serialize model input");
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
  return typeof value === "number" ? value : undefined;
}
