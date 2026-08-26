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

import type { OpenAiEnvConfig } from "../contracts.js";
import { compileOpenRouterResponseSchema } from "../openrouter/OpenRouterSchemaCompiler.js";
import { createOpenAiBadResponseError } from "./OpenAiErrors.js";

const OPENAI_REPLAY_AFTER_CALL_ID = "__kestrelReplayAfterCallId";

export function buildOpenAiHttpRequest(
  request: ModelRequest,
  env: OpenAiEnvConfig,
): {
  model: string;
  path: string;
  body: Record<string, unknown>;
  endpoint: "chat" | "responses";
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
  const requiredEndpoint = v2Requirements(request)?.endpoint;
  const endpoint =
    requiredEndpoint === "chat" || requiredEndpoint === "responses"
      ? requiredEndpoint
      : (openai?.endpoint ??
        (env.providerName === "openai" ? "responses" : "chat"));
  assertOpenAiStrictToolInputCompatibility(request);
  if (endpoint === "responses") {
    return buildOpenAiResponsesRequest(request, env, model);
  }
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
  applyChatTools(
    body,
    request,
    tools,
    openai?.toolChoice ?? openrouterFallback?.toolChoice,
    openai?.parallelToolCalls ?? openrouterFallback?.parallelToolCalls,
  );

  const responseFormat = toChatResponseFormat(request, env);
  if (responseFormat.value !== undefined) {
    body.response_format = responseFormat.value;
  }

  return {
    model,
    endpoint: "chat",
    path: "/v1/chat/completions",
    body,
    ...(responseFormat.structuredOutput !== undefined
      ? { structuredOutput: responseFormat.structuredOutput }
      : {}),
  };
}

/** Provider-owned decoding and terminal proof for a V2 call. */
export function mapOpenAiResponseV2<TOutput>(
  payload: unknown,
  context: Parameters<typeof mapOpenAiResponse>[1] & {
    streamTerminalEvent?: string | undefined;
    visibleOutputStarted?: boolean | undefined;
  },
): ModelResponseV2<TOutput> {
  const endpoint = context.endpoint ?? "chat";
  const mapped = mapOpenAiResponse<TOutput>(payload, context);
  return {
    ...mapped,
    version: MODEL_RESPONSE_V2_VERSION,
    terminal: {
      state:
        endpoint === "responses"
          ? responseTerminalState(payload)
          : chatTerminalState(payload),
      visibleOutputStarted:
        context.visibleOutputStarted ??
        (mapped.text !== undefined || mapped.toolIntents.length > 0),
      ...(context.streamTerminalEvent !== undefined
        ? { providerTerminalEvent: context.streamTerminalEvent }
        : {}),
    },
    validation: { state: "not_requested" },
  };
}

function chatTerminalState(
  payload: unknown,
): ModelResponseV2["terminal"]["state"] {
  const root = asRecord(payload);
  const choice = asRecord(asArray(root?.choices)[0]);
  const message = asRecord(choice?.message);
  if (asString(message?.refusal) !== undefined) return "refused";
  switch (asString(choice?.finish_reason)) {
    case "stop":
    case "tool_calls":
      return "completed";
    case "length":
      return "truncated";
    case "content_filter":
      return "refused";
    case undefined:
      return "malformed";
    default:
      return "incomplete";
  }
}

function responseTerminalState(
  payload: unknown,
): ModelResponseV2["terminal"]["state"] {
  const root = asRecord(payload);
  if (hasResponseRefusal(root)) return "refused";
  switch (asString(root?.status)) {
    case "completed":
      return "completed";
    case "incomplete":
      return asString(asRecord(root?.incomplete_details)?.reason) ===
        "max_output_tokens"
        ? "truncated"
        : "incomplete";
    case "failed":
    case "cancelled":
      return "interrupted";
    case undefined:
      return "malformed";
    default:
      return "incomplete";
  }
}

function hasResponseRefusal(
  root: Record<string, unknown> | undefined,
): boolean {
  return asArray(root?.output).some((item) => {
    const record = asRecord(item);
    return (
      record?.type === "message" &&
      asArray(record.content).some((part) => asRecord(part)?.type === "refusal")
    );
  });
}

export function mapOpenAiResponse<TOutput>(
  payload: unknown,
  context: {
    providerName: OpenAiEnvConfig["providerName"];
    endpoint?: "chat" | "responses" | undefined;
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
  if (context.endpoint === "responses") {
    return mapOpenAiResponsesPayload<TOutput>(payload, context);
  }
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
      ...(context.requestId !== undefined
        ? { requestId: context.requestId }
        : {}),
      ...(context.structuredOutput !== undefined
        ? {
            structuredOutput: {
              mode: context.structuredOutput.mode,
              outcome:
                output !== undefined ? "provider_parsed" : "parse_failed",
              source: output !== undefined ? "provider" : "none",
              schemaRequested: true,
              ...(context.structuredOutput.schemaName !== undefined
                ? { schemaName: context.structuredOutput.schemaName }
                : {}),
            },
          }
        : {}),
    },
  };
}

function buildOpenAiResponsesRequest(
  request: ModelRequest,
  env: OpenAiEnvConfig,
  model: string,
): ReturnType<typeof buildOpenAiHttpRequest> {
  const openai = request.providerOptions?.openai;
  const fallback = request.providerOptions?.openrouter;
  const body: Record<string, unknown> = {
    model,
    input: toResponsesInput(request),
    store: false,
  };
  const maxTokens = openai?.maxTokens ?? fallback?.maxTokens;
  if (typeof maxTokens === "number") {
    body.max_output_tokens = maxTokens;
  }
  const temperature = openai?.temperature ?? fallback?.temperature;
  if (typeof temperature === "number") {
    body.temperature = temperature;
  }
  const topP = openai?.topP ?? fallback?.topP;
  if (typeof topP === "number") {
    body.top_p = topP;
  }
  const tools = toResponsesTools(request.tools);
  applyResponsesTools(
    body,
    request,
    tools,
    openai?.toolChoice ?? fallback?.toolChoice,
    openai?.parallelToolCalls ?? fallback?.parallelToolCalls,
  );
  if (requestedReasoningMode(request) !== "off") {
    const reasoning = request.reasoning;
    body.reasoning = {
      summary: "auto",
      ...(reasoning?.effort !== undefined ? { effort: reasoning.effort } : {}),
    };
    body.include = ["reasoning.encrypted_content"];
  }
  const responseFormat = toResponsesTextFormat(request, env);
  if (responseFormat.value !== undefined) {
    body.text = { format: responseFormat.value };
  }
  return {
    model,
    endpoint: "responses",
    path: "/v1/responses",
    body,
    ...(responseFormat.structuredOutput !== undefined
      ? { structuredOutput: responseFormat.structuredOutput }
      : {}),
  };
}

function toResponsesInput(request: ModelRequest): unknown {
  const continuation = responseContinuationItems(request);
  const messages =
    Array.isArray(request.messages) && request.messages.length > 0
      ? request.messages
      : undefined;
  const mapped =
    messages !== undefined
      ? messages.flatMap((message, index) => {
          if (message.role === "tool") {
            return [
              {
                type: "function_call_output",
                ...(message.toolCallId !== undefined
                  ? { call_id: message.toolCallId }
                  : {}),
                output:
                  typeof message.content === "string"
                    ? message.content
                    : safeJsonStringify(message.content),
              },
            ];
          }
          const items: Array<Record<string, unknown>> = [
            {
              role: message.role,
              content:
                typeof message.content === "string"
                  ? message.content
                  : message.content.map((part) =>
                      part.type === "text"
                        ? { type: "input_text", text: part.text }
                        : {
                            type: "input_image",
                            image_url: `data:${part.mimeType};base64,${part.data}`,
                          },
                    ),
            },
          ];
          const isContinuationTurn =
            continuation.length > 0 &&
            message.role === "assistant" &&
            isLastAssistantMessage(messages, index);
          if (isContinuationTurn) {
            // A Responses continuation is an output item from the prior turn.
            // Its order relative to the prior function calls is provider state.
            items.push(
              ...replayResponsesAssistantOutput(
                message.toolCalls ?? [],
                continuation,
              ),
            );
          } else {
            items.push(...toResponsesFunctionCalls(message.toolCalls ?? []));
          }
          return items;
        })
      : [
          ...continuation.map(({ providerItem }) => providerItem),
          typeof request.input === "string"
            ? { role: "user", content: request.input }
            : { role: "user", content: safeJsonStringify(request.input) },
        ];
  if (
    continuation.length > 0 &&
    messages !== undefined &&
    !messages.some((message) => message.role === "assistant")
  ) {
    throw createOpenAiBadResponseError(
      "OpenAI reasoning continuation requires a preceding assistant output for ordered replay.",
      "MODEL_CONTINUATION_ORDER_INVALID",
    );
  }
  return mapped;
}

function toResponsesTools(
  tools: ModelToolSpec[] | undefined,
): Array<Record<string, unknown>> {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: toProviderToolName(tool.name),
    description: tool.description,
    parameters: toOpenAiFunctionParameters(tool.inputSchema),
    strict: isOpenAiStrictSchema(toOpenAiFunctionParameters(tool.inputSchema)),
  }));
}

function assertOpenAiStrictToolInputCompatibility(request: ModelRequest): void {
  const requirements = v2Requirements(request);
  if (
    requirements?.tools.strictArguments !== true ||
    requirements.tools.choice === "none"
  ) {
    return;
  }
  const unsupported = (request.tools ?? []).find(
    (tool) =>
      !isOpenAiStrictSchema(toOpenAiFunctionParameters(tool.inputSchema)),
  );
  if (unsupported !== undefined) {
    throw createOpenAiBadResponseError(
      `OpenAI cannot encode tool '${unsupported.name}' with strict: true.`,
      "MODEL_PROVIDER_SCHEMA",
    );
  }
}

function applyChatTools(
  body: Record<string, unknown>,
  request: ModelRequest,
  tools: Array<Record<string, unknown>>,
  legacyChoice: unknown,
  legacyParallel: unknown,
): void {
  const requirements = v2Requirements(request);
  if (tools.length === 0 || requirements?.tools.choice === "none") return;
  body.tools = tools;
  const choice =
    requirements === undefined ? legacyChoice : chatToolChoice(requirements);
  if (choice !== undefined) body.tool_choice = choice;
  const parallel =
    requirements === undefined
      ? (legacyParallel ?? true)
      : requirements.tools.parallelism !== "forbidden";
  body.parallel_tool_calls = parallel;
}

function applyResponsesTools(
  body: Record<string, unknown>,
  request: ModelRequest,
  tools: Array<Record<string, unknown>>,
  legacyChoice: unknown,
  legacyParallel: unknown,
): void {
  const requirements = v2Requirements(request);
  if (tools.length === 0 || requirements?.tools.choice === "none") return;
  body.tools = tools;
  const choice =
    requirements === undefined
      ? legacyChoice
      : responsesToolChoice(requirements);
  if (choice !== undefined) body.tool_choice = choice;
  const parallel =
    requirements === undefined
      ? (legacyParallel ?? true)
      : requirements.tools.parallelism !== "forbidden";
  body.parallel_tool_calls = parallel;
}

function chatToolChoice(
  request: ModelRequestV2["requirements"],
): string | Record<string, unknown> | undefined {
  if (request.tools.choice === "none") return "none";
  if (request.tools.choice === "auto") return "auto";
  if (request.tools.choice === "required") return "required";
  return request.tools.toolName === undefined
    ? undefined
    : {
        type: "function",
        function: { name: toProviderToolName(request.tools.toolName) },
      };
}

function responsesToolChoice(
  request: ModelRequestV2["requirements"],
): string | Record<string, unknown> | undefined {
  if (request.tools.choice === "none") return "none";
  if (request.tools.choice === "auto") return "auto";
  if (request.tools.choice === "required") return "required";
  return request.tools.toolName === undefined
    ? undefined
    : { type: "function", name: toProviderToolName(request.tools.toolName) };
}

function v2Requirements(
  request: ModelRequest,
): ModelRequestV2["requirements"] | undefined {
  return request.version === "model_request_v2"
    ? (request as ModelRequestV2).requirements
    : undefined;
}

function requestedReasoningMode(
  request: ModelRequest,
): "off" | "summary" | "provider_visible" {
  return (
    v2Requirements(request)?.reasoning.mode ?? request.reasoning?.mode ?? "off"
  );
}

function responseContinuationItems(
  request: ModelRequest,
): OpenAiContinuationItem[] {
  return (request.reasoning?.continuation ?? []).map((continuation) => {
    if (
      continuation.provider !== "openai" ||
      continuation.kind !== "encrypted_content"
    ) {
      throw createOpenAiBadResponseError(
        "OpenAI Responses received continuation for another provider or continuation kind.",
        "MODEL_CONTINUATION_PROVIDER_MISMATCH",
      );
    }
    const value = asRecord(continuation.value);
    if (value?.type !== "reasoning") {
      throw createOpenAiBadResponseError(
        "OpenAI Responses continuation must be the opaque reasoning output item returned by OpenAI.",
        "MODEL_CONTINUATION_ORDER_INVALID",
      );
    }
    const replayPositionPresent = Object.hasOwn(
      value,
      OPENAI_REPLAY_AFTER_CALL_ID,
    );
    const replayPosition = value[OPENAI_REPLAY_AFTER_CALL_ID];
    if (
      replayPositionPresent &&
      replayPosition !== null &&
      typeof replayPosition !== "string"
    ) {
      throw createOpenAiBadResponseError(
        "OpenAI Responses continuation has an invalid provider output position.",
        "MODEL_CONTINUATION_ORDER_INVALID",
      );
    }
    const replayAfterCallId = asString(replayPosition);
    const { [OPENAI_REPLAY_AFTER_CALL_ID]: _replayPosition, ...providerItem } =
      value;
    return { providerItem, replayPositionPresent, replayAfterCallId };
  });
}

interface OpenAiContinuationItem {
  providerItem: Record<string, unknown>;
  replayPositionPresent: boolean;
  replayAfterCallId?: string | undefined;
}

function replayResponsesAssistantOutput(
  toolCalls: NonNullable<ModelMessage["toolCalls"]>,
  continuation: OpenAiContinuationItem[],
): Array<Record<string, unknown>> {
  if (toolCalls.length === 0) {
    return continuation.map(({ providerItem }) => providerItem);
  }
  if (continuation.some((item) => !item.replayPositionPresent)) {
    throw createOpenAiBadResponseError(
      "OpenAI Responses continuation lacks the provider output position required for ordered replay.",
      "MODEL_CONTINUATION_ORDER_INVALID",
    );
  }
  const replayed: Array<Record<string, unknown>> = [];
  const remaining = [...continuation];
  const beforeFirstCall = takeReplayItems(remaining, undefined);
  replayed.push(...beforeFirstCall.map(({ providerItem }) => providerItem));
  for (const toolCall of toolCalls) {
    replayed.push(...toResponsesFunctionCalls([toolCall]));
    const afterCall = takeReplayItems(remaining, toolCall.id);
    replayed.push(...afterCall.map(({ providerItem }) => providerItem));
  }
  if (remaining.length > 0) {
    throw createOpenAiBadResponseError(
      "OpenAI Responses continuation refers to a function call that is absent from the replay turn.",
      "MODEL_CONTINUATION_ORDER_INVALID",
    );
  }
  return replayed;
}

function takeReplayItems(
  items: OpenAiContinuationItem[],
  replayAfterCallId: string | undefined,
): OpenAiContinuationItem[] {
  const matched: OpenAiContinuationItem[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.replayAfterCallId === replayAfterCallId) {
      matched.unshift(items[index]!);
      items.splice(index, 1);
    }
  }
  return matched;
}

function toResponsesFunctionCalls(
  toolCalls: NonNullable<ModelMessage["toolCalls"]>,
): Array<Record<string, unknown>> {
  return toolCalls.map((toolCall) => ({
    type: "function_call",
    call_id: toolCall.id,
    name: toProviderToolName(toolCall.name),
    arguments: safeJsonStringify(toolCall.input),
  }));
}

function isLastAssistantMessage(
  messages: ModelMessage[],
  index: number,
): boolean {
  return !messages
    .slice(index + 1)
    .some((message) => message.role === "assistant");
}

function mapOpenAiResponsesPayload<TOutput>(
  payload: unknown,
  context: Parameters<typeof mapOpenAiResponse>[1],
): ModelResponse<TOutput> {
  const root = asRecord(payload);
  const outputItems = asArray(root?.output);
  const textParts: string[] = [];
  const toolIntents: ModelToolIntent[] = [];
  const visible: NonNullable<ModelResponse["reasoning"]>["visible"] = [];
  const continuation: NonNullable<ModelResponse["reasoning"]>["continuation"] =
    [];
  let replayAfterCallId: string | undefined;
  for (const item of outputItems) {
    const record = asRecord(item);
    const type = asString(record?.type);
    if (type === "message") {
      for (const part of asArray(record?.content)) {
        const content = asRecord(part);
        if (
          asString(content?.type) === "output_text" &&
          asString(content?.text) !== undefined
        ) {
          textParts.push(asString(content?.text) as string);
        }
      }
    } else if (type === "function_call") {
      const name = asString(record?.name);
      if (name !== undefined) {
        const callId = asString(record?.call_id);
        toolIntents.push({
          name,
          input: parseToolArguments(asString(record?.arguments)),
          ...(callId !== undefined ? { id: callId } : {}),
        });
        replayAfterCallId = callId;
      }
    } else if (type === "reasoning") {
      const summaryText = asArray(record?.summary)
        .map((part) => asString(asRecord(part)?.text) ?? asString(part))
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join("\n");
      if (summaryText.length > 0) {
        visible.push({ format: "summary", text: summaryText });
      }
      if (record?.encrypted_content !== undefined) {
        continuation.push({
          provider: "openai",
          kind: "encrypted_content",
          value: {
            ...record,
            [OPENAI_REPLAY_AFTER_CALL_ID]: replayAfterCallId ?? null,
          },
        });
      }
    }
  }
  const text =
    textParts.length > 0 ? textParts.join("") : asString(root?.output_text);
  const output = parseOutput<TOutput>(text);
  return {
    output,
    ...(text !== undefined ? { text } : {}),
    toolIntents: dedupeToolIntents(toolIntents),
    usage: mapResponsesUsage(asRecord(root?.usage)),
    ...(visible.length > 0 || continuation.length > 0
      ? { reasoning: { visible, continuation } }
      : {}),
    provider: {
      name: context.providerName,
      model: asString(root?.model) ?? context.requestedModel,
      endpoint: "responses",
      ...(context.requestId !== undefined
        ? { requestId: context.requestId }
        : {}),
      ...(context.structuredOutput !== undefined
        ? {
            structuredOutput: {
              mode: context.structuredOutput.mode,
              outcome:
                output !== undefined ? "provider_parsed" : "parse_failed",
              source: output !== undefined ? "provider" : "none",
              schemaRequested: true,
              ...(context.structuredOutput.schemaName !== undefined
                ? { schemaName: context.structuredOutput.schemaName }
                : {}),
            },
          }
        : {}),
    },
  };
}

function parseToolArguments(
  value: string | undefined,
): Record<string, unknown> {
  if (value === undefined) {
    throw createOpenAiBadResponseError(
      "OpenAI Responses function call omitted arguments.",
      "MODEL_MALFORMED_TOOL_ARGUMENTS",
    );
  }
  try {
    const parsed = asRecord(JSON.parse(value));
    if (parsed === undefined) {
      throw createOpenAiBadResponseError(
        "OpenAI Responses function arguments must be a JSON object.",
        "MODEL_MALFORMED_TOOL_ARGUMENTS",
      );
    }
    return parsed;
  } catch {
    throw createOpenAiBadResponseError(
      "OpenAI Responses function arguments were not valid JSON.",
      "MODEL_MALFORMED_TOOL_ARGUMENTS",
    );
  }
}

function mapResponsesUsage(value: Record<string, unknown> | undefined) {
  if (value === undefined) return;
  const inputTokens = asNumber(value.input_tokens);
  const outputTokens = asNumber(value.output_tokens);
  const totalTokens = asNumber(value.total_tokens);
  const inputDetails = asRecord(value.input_tokens_details);
  const outputDetails = asRecord(value.output_tokens_details);
  const cachedInputTokens = asNumber(inputDetails?.cached_tokens);
  const reasoningTokens = asNumber(outputDetails?.reasoning_tokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
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

function toOpenAiTools(
  tools: ModelToolSpec[] | undefined,
): Array<Record<string, unknown>> {
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
      isOpenAiStrictSchema(property),
    )
  );
}

function toProviderToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_");
}

function toChatResponseFormat(
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
      v2Requirements(request)?.output.schemaName ??
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

function toResponsesTextFormat(
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
  const chat = toChatResponseFormat(request, env);
  if (chat.value?.type !== "json_schema") return chat;
  const jsonSchema = asRecord(chat.value.json_schema);
  if (jsonSchema === undefined) {
    throw createOpenAiBadResponseError(
      "OpenAI Responses JSON Schema format was not compiled.",
      "MODEL_PROVIDER_SCHEMA",
    );
  }
  // Responses uses a flat text.format object; Chat nests the same fields
  // under response_format.json_schema.
  return {
    ...chat,
    value: {
      type: "json_schema",
      ...jsonSchema,
    },
  };
}

function extractChatMessageText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) === false) {
    return;
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
    return;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }

  // Decode exactly one provider value; prose and Markdown fences are not
  // structured output and must reach shared proof as a failure.
  return parseJsonText<TOutput>(trimmed);
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
      return [
        {
          name,
          input: parseArgs(argsText),
          ...(id !== undefined ? { id } : {}),
        },
      ];
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

function mapUsage(
  usage: Record<string, unknown> | undefined,
): ModelResponse["usage"] {
  if (usage === undefined) {
    return;
  }
  const inputTokens = asNumber(usage.prompt_tokens);
  const outputTokens = asNumber(usage.completion_tokens);
  const totalTokens = asNumber(usage.total_tokens);
  const inputDetails = asRecord(usage.prompt_tokens_details);
  const outputDetails = asRecord(usage.completion_tokens_details);
  const cachedInputTokens = asNumber(inputDetails?.cached_tokens);
  const reasoningTokens = asNumber(outputDetails?.reasoning_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function parseArgs(value: string | undefined): Record<string, unknown> {
  if (value === undefined) {
    throw createOpenAiBadResponseError(
      "OpenAI Chat function call omitted arguments.",
      "MODEL_MALFORMED_TOOL_ARGUMENTS",
    );
  }
  const parsed = asRecord(parseJsonText<unknown>(value));
  if (parsed === undefined) {
    throw createOpenAiBadResponseError(
      "OpenAI Chat function arguments were not a JSON object.",
      "MODEL_MALFORMED_TOOL_ARGUMENTS",
    );
  }
  return parsed;
}

function parseJsonText<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return;
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
    return;
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
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
