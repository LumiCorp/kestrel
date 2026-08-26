import type {
  ModelMessage,
  ModelResponse,
  ModelToolIntent,
  ModelToolSpec,
} from "../../src/kestrel/contracts/model-io.js";
import {
  MODEL_RESPONSE_V2_VERSION,
  type ModelRequestV2,
  type ModelResponseV2,
} from "../../src/kestrel/contracts/model-registration.js";

import type { OpenRouterEndpoint, OpenRouterEnvConfig } from "../contracts.js";
import {
  createOpenRouterBadResponseError,
  OpenRouterModelError,
} from "./OpenRouterErrors.js";
import { compileOpenRouterResponseSchema } from "./OpenRouterSchemaCompiler.js";

export interface OpenRouterQualifiedRouteEvidence {
  modelId: string;
  endpoint: OpenRouterEndpoint;
  supportedParameters: readonly string[];
  routing: {
    kind: "fixed" | "provider";
    policyId: string;
    allowedEndpointIds: readonly string[];
  };
  sourceHash: string;
}

export interface OpenRouterHttpRequestV2 {
  endpoint: OpenRouterEndpoint;
  model: string;
  path: string;
  body: Record<string, unknown>;
  structuredOutput?: {
    mode: "constrained" | "json_object";
    schemaName?: string | undefined;
    compilerDiagnostics?: Record<string, unknown> | undefined;
  } | undefined;
}

export function buildOpenRouterHttpRequestV2(
  request: ModelRequestV2,
  env: OpenRouterEnvConfig,
  route: OpenRouterQualifiedRouteEvidence,
): OpenRouterHttpRequestV2 {
  const endpoint = requireEndpoint(request, route);
  const model = request.model ?? env.model;
  if (model !== route.modelId) {
    throw createOpenRouterBadResponseError(
      "OpenRouter exact route evidence does not match the requested model.",
    );
  }
  if (endpoint === "responses" && (request.reasoning?.continuation?.length ?? 0) > 0) {
    throw createOpenRouterBadResponseError(
      "OpenRouter Responses continuation is unsupported until its endpoint codec can round-trip the opaque provider value.",
    );
  }

  const requiredParameters = requiredOpenRouterParameters(request, endpoint);
  for (const parameter of requiredParameters) {
    if (!route.supportedParameters.includes(parameter)) {
      throw createOpenRouterBadResponseError(
        `OpenRouter qualified route '${route.routing.policyId}' does not support required parameter '${parameter}'.`,
      );
    }
  }

  const payload = endpoint === "chat"
    ? buildChatBody(request, model, route)
    : buildResponsesBody(request, model, route);
  return {
    endpoint,
    model,
    path: endpoint === "chat" ? "/api/v1/chat/completions" : "/api/v1/responses",
    body: payload.body,
    ...(payload.structuredOutput !== undefined ? { structuredOutput: payload.structuredOutput } : {}),
  };
}

export function mapOpenRouterResponseV2<TOutput>(
  payload: unknown,
  context: {
    endpoint: OpenRouterEndpoint;
    requestedModel: string;
    requestId?: string | undefined;
    structuredOutput?: OpenRouterHttpRequestV2["structuredOutput"] | undefined;
  },
): ModelResponseV2<TOutput> {
  try {
    return context.endpoint === "chat"
      ? mapChatResponse<TOutput>(payload, context)
      : mapResponsesResponse<TOutput>(payload, context);
  } catch (error) {
    if (error instanceof OpenRouterModelError && error.code === "MODEL_BAD_RESPONSE") {
      return malformedResponse<TOutput>(payload, context, error.code);
    }
    throw error;
  }
}

function requireEndpoint(
  request: ModelRequestV2,
  route: OpenRouterQualifiedRouteEvidence,
): OpenRouterEndpoint {
  const requested = request.requirements.endpoint;
  if (requested !== "chat" && requested !== "responses") {
    throw createOpenRouterBadResponseError(
      "OpenRouter V2 requests require an exact chat or responses endpoint.",
    );
  }
  if (route.endpoint !== requested) {
    throw createOpenRouterBadResponseError(
      "OpenRouter exact route evidence does not match the requested endpoint.",
    );
  }
  if (route.routing.allowedEndpointIds.length === 0) {
    throw createOpenRouterBadResponseError(
      "OpenRouter exact route evidence has no eligible provider endpoint.",
    );
  }
  if (route.routing.kind === "fixed" && route.routing.allowedEndpointIds.length !== 1) {
    throw createOpenRouterBadResponseError(
      "OpenRouter fixed routing evidence must name exactly one provider endpoint.",
    );
  }
  return requested;
}

function buildChatBody(
  request: ModelRequestV2,
  model: string,
  route: OpenRouterQualifiedRouteEvidence,
) {
  const body: Record<string, unknown> = {
    model,
    messages: toChatMessages(request),
    provider: providerRouting(route),
  };
  applyCommonParameters(body, request, "chat");
  const output = chatStructuredOutput(request);
  if (output.value !== undefined) body.response_format = output.value;
  return { body, ...(output.structuredOutput !== undefined ? { structuredOutput: output.structuredOutput } : {}) };
}

function buildResponsesBody(
  request: ModelRequestV2,
  model: string,
  route: OpenRouterQualifiedRouteEvidence,
) {
  const body: Record<string, unknown> = {
    model,
    input: toResponsesInput(request),
    provider: providerRouting(route),
  };
  applyCommonParameters(body, request, "responses");
  const output = responsesStructuredOutput(request);
  if (output.value !== undefined) body.text = { format: output.value };
  return { body, ...(output.structuredOutput !== undefined ? { structuredOutput: output.structuredOutput } : {}) };
}

function providerRouting(route: OpenRouterQualifiedRouteEvidence): Record<string, unknown> {
  return {
    require_parameters: true,
    order: [...route.routing.allowedEndpointIds],
    // OpenRouter cannot prove a fallback remains within this set. Keep the
    // qualified route closed until provider-scoped fallback is represented.
    allow_fallbacks: false,
  };
}

function applyCommonParameters(
  body: Record<string, unknown>,
  request: ModelRequestV2,
  endpoint: OpenRouterEndpoint,
): void {
  const options = request.providerOptions?.openrouter;
  if (typeof options?.temperature === "number") body.temperature = options.temperature;
  if (typeof options?.maxTokens === "number") {
    body[endpoint === "chat" ? "max_tokens" : "max_output_tokens"] = options.maxTokens;
  }
  if (typeof options?.topP === "number") body.top_p = options.topP;

  const tools = request.tools ?? [];
  if (tools.length > 0) {
    body.tools = endpoint === "chat"
      ? toChatTools(tools, request.requirements.tools.strictArguments)
      : toResponsesTools(tools, request.requirements.tools.strictArguments);
    body.tool_choice = toolChoice(request, endpoint);
    body.parallel_tool_calls = request.requirements.tools.parallelism !== "forbidden";
  }

  if (request.requirements.reasoning.mode !== "off") {
    body.reasoning = {
      exclude: false,
      ...(request.requirements.reasoning.effort !== undefined
        ? { effort: request.requirements.reasoning.effort }
        : {}),
    };
  }
  if (request.metadata !== undefined) body.metadata = request.metadata;
}

function toolChoice(request: ModelRequestV2, endpoint: OpenRouterEndpoint): unknown {
  const requirements = request.requirements.tools;
  if (requirements.choice === "auto") return "auto";
  if (requirements.choice === "none") return "none";
  if (requirements.choice === "required") return "required";
  if (requirements.toolName === undefined) {
    throw createOpenRouterBadResponseError("Named OpenRouter tool choice requires its exact tool name.");
  }
  return endpoint === "chat"
    ? { type: "function", function: { name: requirements.toolName } }
    : { type: "function", name: requirements.toolName };
}

function chatStructuredOutput(request: ModelRequestV2) {
  if (request.requirements.output.kind === "text") return {};
  if (request.requirements.output.kind === "json_object") {
    return { value: { type: "json_object" }, structuredOutput: { mode: "json_object" as const } };
  }
  const schemaName = request.requirements.output.schemaName ?? "kestrel_response";
  const compiled = compileOpenRouterResponseSchema({ schema: request.responseSchema ?? {}, schemaName });
  return {
    value: compiled.responseFormat,
    structuredOutput: { mode: "constrained" as const, schemaName, compilerDiagnostics: compiled.diagnostics },
  };
}

function responsesStructuredOutput(request: ModelRequestV2) {
  if (request.requirements.output.kind === "text") return {};
  if (request.requirements.output.kind === "json_object") {
    return { value: { type: "json_object" }, structuredOutput: { mode: "json_object" as const } };
  }
  const schemaName = request.requirements.output.schemaName ?? "kestrel_response";
  const compiled = compileOpenRouterResponseSchema({ schema: request.responseSchema ?? {}, schemaName });
  return {
    value: { ...compiled.responseFormat, json_schema: { ...compiled.responseFormat.json_schema, strict: true } },
    structuredOutput: { mode: "constrained" as const, schemaName, compilerDiagnostics: compiled.diagnostics },
  };
}

function requiredOpenRouterParameters(request: ModelRequestV2, endpoint: OpenRouterEndpoint): string[] {
  const required = new Set<string>();
  if (request.requirements.output.kind !== "text") required.add("response_format");
  if (request.requirements.tools.choice !== "none") {
    required.add("tools");
    required.add("tool_choice");
    required.add("parallel_tool_calls");
  }
  if (request.requirements.reasoning.mode !== "off") required.add("reasoning");
  if (request.reasoning?.continuation?.length) required.add("reasoning_details");
  return [...required].sort();
}

function toChatMessages(request: ModelRequestV2): Array<Record<string, unknown>> {
  const messages = messagesFor(request).map(mapChatMessage);
  applyChatContinuation(messages, request);
  return messages;
}

function toResponsesInput(request: ModelRequestV2): unknown {
  const messages = messagesFor(request);
  return messages.flatMap(mapResponsesMessage);
}

function messagesFor(request: ModelRequestV2): ModelMessage[] {
  if (Array.isArray(request.messages) && request.messages.length > 0) return request.messages;
  return [{ role: "user", content: typeof request.input === "string" ? request.input : JSON.stringify(request.input) }];
}

function applyChatContinuation(messages: Array<Record<string, unknown>>, request: ModelRequestV2): void {
  const continuation = request.reasoning?.continuation ?? [];
  if (continuation.length === 0) return;
  const details = continuation.filter((entry) => entry.provider === "openrouter" && entry.kind === "reasoning_details");
  if (details.length !== continuation.length) {
    throw createOpenRouterBadResponseError("OpenRouter chat cannot encode a continuation from another provider or kind.");
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      messages[index] = { ...messages[index], reasoning_details: details.map((entry) => entry.value) };
      return;
    }
  }
  throw createOpenRouterBadResponseError("OpenRouter continuation requires the preceding assistant message.");
}

function mapChatMessage(message: ModelMessage): Record<string, unknown> {
  const mapped: Record<string, unknown> = { role: message.role, content: mapChatContent(message.content) };
  if (message.name !== undefined) mapped.name = providerToolName(message.name);
  if (message.toolCallId !== undefined) mapped.tool_call_id = message.toolCallId;
  if (message.toolCalls?.length) {
    mapped.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: providerToolName(call.name), arguments: JSON.stringify(call.input) },
    }));
  }
  return mapped;
}

function mapResponsesMessage(message: ModelMessage): Array<Record<string, unknown>> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return [
      ...(contentText(message.content).trim() ? [{ role: "assistant", content: mapResponsesContent(message.content) }] : []),
      ...message.toolCalls.map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: providerToolName(call.name),
        arguments: JSON.stringify(call.input),
      })),
    ];
  }
  if (message.role === "tool") {
    if (message.toolCallId === undefined) throw createOpenRouterBadResponseError("OpenRouter Responses tool output requires a call ID.");
    return [{ type: "function_call_output", call_id: message.toolCallId, output: contentText(message.content) }];
  }
  return [{ role: message.role, content: mapResponsesContent(message.content) }];
}

function toChatTools(tools: ModelToolSpec[], strict: boolean): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema, ...(strict ? { strict: true } : {}) },
  }));
}

function toResponsesTools(tools: ModelToolSpec[], strict: boolean): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    ...(strict ? { strict: true } : {}),
  }));
}

function mapChatResponse<TOutput>(payload: unknown, context: Parameters<typeof mapOpenRouterResponseV2>[1]): ModelResponseV2<TOutput> {
  const root = record(payload);
  const choice = record(array(root?.choices)[0]);
  const message = record(choice?.message);
  const terminal = chatTerminal(choice, root);
  const text = textFromChat(message);
  const parsed = structuredValue<TOutput>(message?.parsed);
  const output = parsed ?? exactJson<TOutput>(text);
  return responseV2({
    output,
    text,
    toolIntents: chatToolIntents(message?.tool_calls),
    usage: mapUsage(record(root?.usage), "chat"),
    reasoning: chatReasoning(message),
    provider: provider(context, root, "chat", parsed !== undefined ? "provider" : output !== undefined ? "text" : "none"),
    terminal,
  });
}

function mapResponsesResponse<TOutput>(payload: unknown, context: Parameters<typeof mapOpenRouterResponseV2>[1]): ModelResponseV2<TOutput> {
  const root = record(payload);
  const outputItems = array(root?.output);
  const text = string(root?.output_text) ?? (outputItems.flatMap(outputText).join("\n") || undefined);
  const terminal = responsesTerminal(root);
  return responseV2({
    output: exactJson<TOutput>(text),
    text,
    toolIntents: responsesToolIntents(outputItems),
    usage: mapUsage(record(root?.usage), "responses"),
    reasoning: responsesReasoning(outputItems),
    provider: provider(context, root, "responses", "none"),
    terminal,
  });
}

function responseV2<TOutput>(value: Omit<ModelResponseV2<TOutput>, "version" | "validation">): ModelResponseV2<TOutput> {
  return {
    ...value,
    version: MODEL_RESPONSE_V2_VERSION,
    validation: value.terminal.state === "completed" ? { state: "not_requested" } : { state: "failed", failureCode: `MODEL_${value.terminal.state.toUpperCase()}_RESPONSE` },
  };
}

function malformedResponse<TOutput>(
  payload: unknown,
  context: Parameters<typeof mapOpenRouterResponseV2>[1],
  failureCode: string,
): ModelResponseV2<TOutput> {
  const root = record(payload);
  const event = context.endpoint === "chat"
    ? string(root?.__openRouterTerminalEvent) ?? (string(record(array(root?.choices)[0])?.finish_reason) !== undefined ? "chat.completion" : undefined)
    : string(root?.__openRouterTerminalEvent) ?? (string(root?.status) !== undefined ? "response.completed" : undefined);
  return {
    version: MODEL_RESPONSE_V2_VERSION,
    toolIntents: [],
    provider: provider(context, root, context.endpoint, "none"),
    terminal: {
      state: "malformed",
      visibleOutputStarted: event !== undefined,
      ...(event !== undefined ? { providerTerminalEvent: event } : {}),
    },
    validation: { state: "failed", failureCode },
  };
}

function chatTerminal(choice: Record<string, unknown> | undefined, root: Record<string, unknown> | undefined): ModelResponseV2["terminal"] {
  const finish = string(choice?.finish_reason);
  if (finish === "stop" || finish === "tool_calls") return { state: "completed", visibleOutputStarted: false, providerTerminalEvent: "chat.completion" };
  if (finish === "length") return { state: "truncated", visibleOutputStarted: false, providerTerminalEvent: "chat.completion" };
  if (finish === "content_filter") return { state: "refused", visibleOutputStarted: false, providerTerminalEvent: "chat.completion" };
  const streamEvent = string(root?.__openRouterTerminalEvent);
  if (streamEvent === "[DONE]") return { state: "completed", visibleOutputStarted: true, providerTerminalEvent: streamEvent };
  return { state: "malformed", visibleOutputStarted: false };
}

function responsesTerminal(root: Record<string, unknown> | undefined): ModelResponseV2["terminal"] {
  const status = string(root?.status);
  const event = string(root?.__openRouterTerminalEvent);
  if (event === "response.completed" || status === "completed") return { state: "completed", visibleOutputStarted: event !== undefined, providerTerminalEvent: event ?? "response.completed" };
  if (status === "incomplete") return { state: "incomplete", visibleOutputStarted: false, providerTerminalEvent: event };
  if (status === "failed" || status === "cancelled") return { state: "interrupted", visibleOutputStarted: false, providerTerminalEvent: event };
  return { state: "malformed", visibleOutputStarted: false, ...(event !== undefined ? { providerTerminalEvent: event } : {}) };
}

function provider(context: Parameters<typeof mapOpenRouterResponseV2>[1], root: Record<string, unknown> | undefined, endpoint: OpenRouterEndpoint, source: "provider" | "text" | "none") {
  return {
    name: "openrouter" as const,
    model: string(root?.model) ?? context.requestedModel,
    endpoint,
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
    ...(context.structuredOutput !== undefined ? { structuredOutput: {
      mode: context.structuredOutput.mode,
      outcome: source === "provider" ? "provider_parsed" as const : source === "text" ? "text_fallback_parsed" as const : "parse_failed" as const,
      source: source === "provider" ? "provider" as const : source === "text" ? "text_fallback" as const : "none" as const,
      schemaRequested: true,
      ...(context.structuredOutput.schemaName !== undefined ? { schemaName: context.structuredOutput.schemaName } : {}),
      ...(context.structuredOutput.compilerDiagnostics !== undefined ? { compilerDiagnostics: context.structuredOutput.compilerDiagnostics } : {}),
    } } : {}),
  };
}

function chatToolIntents(value: unknown): ModelToolIntent[] {
  return array(value).map((entry) => {
    const call = record(entry);
    const fn = record(call?.function);
    const name = string(fn?.name);
    const id = string(call?.id);
    const input = exactObjectJson(fn?.arguments, "OpenRouter Chat tool arguments");
    if (name === undefined || id === undefined) throw createOpenRouterBadResponseError("OpenRouter Chat returned a tool call without an ID or name.");
    return { id, name, input };
  });
}

function responsesToolIntents(value: unknown[]): ModelToolIntent[] {
  return value.filter((entry) => record(entry)?.type === "function_call").map((entry) => {
    const call = record(entry)!;
    const name = string(call.name);
    const id = string(call.call_id) ?? string(call.id);
    if (name === undefined || id === undefined) throw createOpenRouterBadResponseError("OpenRouter Responses returned a function call without an ID or name.");
    return { id, name, input: exactObjectJson(call.arguments, "OpenRouter Responses function arguments") };
  });
}

function chatReasoning(message: Record<string, unknown> | undefined): ModelResponse["reasoning"] | undefined {
  const details = array(message?.reasoning_details);
  const visible: NonNullable<ModelResponse["reasoning"]>["visible"] = [];
  for (const detail of details) {
    const item = record(detail);
    if (item?.type === "reasoning.text" && string(item.text) !== undefined) {
      visible.push({ format: "provider_reasoning_text", text: string(item.text)! });
    } else if (item?.type === "reasoning.summary" && string(item.summary) !== undefined) {
      visible.push({ format: "summary", text: string(item.summary)! });
    }
  }
  return visible.length || details.length ? { visible, continuation: details.length ? [{ provider: "openrouter", kind: "reasoning_details", value: details }] : [] } : undefined;
}

function responsesReasoning(value: unknown[]): ModelResponse["reasoning"] | undefined {
  const details = value.filter((entry) => record(entry)?.type === "reasoning");
  const visible = details.flatMap((entry) => {
    const item = record(entry);
    const summary = string(item?.summary) ?? string(item?.text);
    return summary === undefined ? [] : [{ format: "provider_reasoning_text" as const, text: summary }];
  });
  return visible.length ? { visible, continuation: [] } : undefined;
}

function outputText(value: unknown): string[] {
  const item = record(value);
  if (item?.type === "output_text" && string(item.text) !== undefined) return [string(item.text)!];
  return array(item?.content).flatMap(outputText);
}

function textFromChat(message: Record<string, unknown> | undefined): string | undefined {
  return string(message?.content) ?? (array(message?.content).map((part) => string(record(part)?.text)).filter((part): part is string => part !== undefined).join("\n") || undefined);
}

function structuredValue<T>(value: unknown): T | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  if (typeof value === "string") return exactJson<T>(value);
  return undefined;
}

function exactJson<T>(value: string | undefined): T | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

function exactObjectJson(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw createOpenRouterBadResponseError(`${label} must be a JSON object string.`);
  const parsed = exactJson<unknown>(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw createOpenRouterBadResponseError(`${label} were malformed.`);
  return parsed as Record<string, unknown>;
}

function mapUsage(value: Record<string, unknown> | undefined, endpoint: OpenRouterEndpoint): ModelResponse["usage"] | undefined {
  if (!value) return undefined;
  const input = number(endpoint === "chat" ? value.prompt_tokens : value.input_tokens);
  const output = number(endpoint === "chat" ? value.completion_tokens : value.output_tokens);
  const total = number(value.total_tokens);
  const cached = number(record(endpoint === "chat" ? value.prompt_tokens_details : value.input_tokens_details)?.cached_tokens);
  const reasoning = number(record(value.output_tokens_details)?.reasoning_tokens);
  return input === undefined && output === undefined && total === undefined && cached === undefined && reasoning === undefined ? undefined : {
    ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}), ...(total !== undefined ? { totalTokens: total } : {}), ...(cached !== undefined ? { cachedInputTokens: cached } : {}), ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

function mapChatContent(content: ModelMessage["content"]): unknown { return typeof content === "string" ? content : content.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }); }
function mapResponsesContent(content: ModelMessage["content"]): unknown[] { return typeof content === "string" ? [{ type: "input_text", text: content }] : content.map((part) => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` }); }
function contentText(content: ModelMessage["content"]): string { return typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n"); }
function providerToolName(value: string): string { return value.replace(/[^A-Za-z0-9_-]/gu, "_"); }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
