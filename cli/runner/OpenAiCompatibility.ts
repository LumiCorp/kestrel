import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { createWebClientCapabilities } from "../../src/clientCapabilities.js";
import { createWebDemoProfile } from "../../src/web/profile.js";
import type { TuiProfile } from "../contracts.js";
import type {
  RunnerActorMetadata,
  RunnerCommand,
  RunnerEvent,
  RunnerEventType,
} from "../protocol/contracts.js";
import { summarizeRunTurnResult } from "./finalizedOutput.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const KESTREL_SESSION_HEADER = "x-kestrel-session-id";
const KESTREL_RUN_HEADER = "x-kestrel-run-id";
const KESTREL_THREAD_HEADER = "x-kestrel-thread-id";
const KESTREL_ACTOR_ID_HEADER = "x-kestrel-actor-id";
const KESTREL_ACTOR_TYPE_HEADER = "x-kestrel-actor-type";
const KESTREL_ACTOR_NAME_HEADER = "x-kestrel-actor-name";
const KESTREL_TENANT_HEADER = "x-kestrel-tenant-id";

const SUPPORTED_COMPATIBILITY_MODEL_ID = "reference-react";
const COMPATIBILITY_MODEL_ALIASES = new Set(["reference-web"]);
const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (options?: { allErrors?: boolean; strict?: boolean }) => {
  validate(schema: unknown, data: unknown): boolean;
  compile(schema: unknown): {
    (data: unknown): boolean;
    errors?: unknown[];
  };
  errorsText(errors?: unknown[], options?: { separator?: string }): string;
  errors?: unknown;
};

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});

export interface CompatibilityRequestExecution {
  executeUnary(command: RunnerCommand): Promise<RunnerEvent>;
  executeStream(
    command: RunnerCommand,
    onEvent: (event: RunnerEvent) => void,
  ): Promise<void>;
}

export interface CompatibilityHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type CompatibilityParsedRequest =
  | {
      kind: "models";
    }
  | {
      kind: "turn";
      request: CompatibilityTurnRequest;
    };

interface CompatibilityResponseMetadata {
  sessionId: string;
  runId?: string | undefined;
  threadId?: string | undefined;
  model: string;
}

interface CompatibilityToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface StructuredOutputConstraint {
  type: "json_object" | "json_schema";
  schemaName?: string | undefined;
  schema?: Record<string, unknown> | undefined;
}

interface CompatibilityTurnRequest {
  api: "chat.completions" | "responses";
  stream: boolean;
  model: string;
  sessionId: string;
  metadata?: Record<string, string> | undefined;
  instructions?: string | undefined;
  inputText: string;
  history: Array<{
    role: "system" | "assistant" | "user";
    text: string;
    timestamp: string;
  }>;
  structuredOutput?: StructuredOutputConstraint | undefined;
}

interface CompatibilityStreamAccumulator {
  toolCalls: CompatibilityToolCall[];
  responseId: string;
  responseCreatedAt: number;
}

export function isOpenAiCompatibilityRoute(method: string, path: string): boolean {
  if (method === "GET" && path === "/v1/models") {
    return true;
  }
  if (method !== "POST") {
    return false;
  }
  return path === "/v1/chat/completions" || path === "/v1/responses";
}

export async function executeOpenAiCompatibilityRequest(input: {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
  execution: CompatibilityRequestExecution;
}): Promise<CompatibilityHttpResponse> {
  const parsed = parseOpenAiCompatibilityRequest({
    method: input.method,
    path: input.path,
    headers: input.headers,
    body: input.body,
  });
  if (parsed.ok === false) {
    return buildOpenAiErrorResponse(400, "invalid_request_error", parsed.message, parsed.code);
  }

  if (parsed.value.kind === "models") {
    return {
      statusCode: 200,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({
        object: "list",
        data: [toOpenAiModelRecord()],
      }),
    };
  }
  const parsedRequest = parsed.value.request;

  if (parsedRequest.stream) {
    const chunks = await collectCompatibilityStream(parsedRequest, input.execution);
    return {
      statusCode: 200,
      headers: {
        ...SSE_HEADERS,
        ...buildCompatibilityHeaders({
          sessionId: parsedRequest.sessionId,
          model: parsedRequest.model,
        }),
      },
      body: chunks.join(""),
    };
  }

  const command = buildRunStartCommand(parsedRequest, input.headers);
  const terminal = await input.execution.executeUnary(command);
  return toCompatibilityUnaryResponse(parsedRequest, terminal);
}

export function buildCompatibilityHeaders(metadata: CompatibilityResponseMetadata): Record<string, string> {
  return {
    [KESTREL_SESSION_HEADER]: metadata.sessionId,
    ...(metadata.runId !== undefined ? { [KESTREL_RUN_HEADER]: metadata.runId } : {}),
    ...(metadata.threadId !== undefined ? { [KESTREL_THREAD_HEADER]: metadata.threadId } : {}),
    "x-kestrel-model-id": metadata.model,
  };
}

export function buildRunStartCommand(
  request: CompatibilityTurnRequest,
  headers: Record<string, string | undefined>,
): Extract<RunnerCommand, { type: "run.start" }> {
  const profile = resolveCompatibilityProfile(request.model);
  const systemInstructions = request.history
    .filter((entry) => entry.role === "system")
    .map((entry) => entry.text);
  const runnerHistory = request.history.filter(
    (entry) => entry.role !== "system",
  );

  if (request.instructions !== undefined) {
    systemInstructions.push(request.instructions);
  }
  if (request.structuredOutput !== undefined) {
    systemInstructions.push(
      buildStructuredOutputInstruction(request.structuredOutput),
    );
  }

  return {
    id: randomUUID(),
    type: "run.start",
    metadata: {
      actor: resolveActorMetadata(headers),
      tenantId: readHeader(headers, KESTREL_TENANT_HEADER),
      profile,
    },
    payload: {
      profile,
      turn: {
        sessionId: request.sessionId,
        message: request.inputText,
        eventType: "user.message",
        stepAgent: "reference-react",
        modeSystemV2Enabled: true,
        clientCapabilities: createWebClientCapabilities(),
        ...(systemInstructions.length > 0 ? { systemInstructions } : {}),
        ...(runnerHistory.length > 0 ? { history: runnerHistory } : {}),
      },
    },
  };
}

export function parseOpenAiCompatibilityRequest(input: {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}):
  | { ok: true; value: CompatibilityParsedRequest }
  | { ok: false; message: string; code: string } {
  if (input.method === "GET" && input.path === "/v1/models") {
    return {
      ok: true,
      value: {
        kind: "models",
      },
    };
  }

  const parsedBody = parseJsonBody(input.body);
  if (parsedBody.ok === false) {
    return { ok: false, message: parsedBody.message, code: "invalid_json" };
  }

  const parsedRequest =
    input.path === "/v1/chat/completions"
      ? parseChatCompletionRequest(parsedBody.value, input.headers)
      : parseResponsesRequest(parsedBody.value, input.headers);
  if (parsedRequest.ok === false) {
    return parsedRequest;
  }

  return {
    ok: true,
    value: {
      kind: "turn",
      request: parsedRequest.value,
    },
  };
}

export function encodeChatCompletionChunk(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function encodeResponsesEvent(event: string, payload: Record<string, unknown> | "[DONE]"): string {
  if (payload === "[DONE]") {
    return `event: ${event}\ndata: [DONE]\n\n`;
  }
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createCompatibilityStreamHandler(
  request: CompatibilityTurnRequest,
  commandId: string,
): {
  metadata: CompatibilityResponseMetadata;
  onEvent(event: RunnerEvent): string[];
} {
  const responseId = request.api === "chat.completions" ? `chatcmpl-${randomUUID()}` : `resp_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const accumulator: CompatibilityStreamAccumulator = {
    toolCalls: [],
    responseId,
    responseCreatedAt: created,
  };

  const metadata: CompatibilityResponseMetadata = {
    sessionId: request.sessionId,
    model: request.model,
  };

  return {
    metadata,
    onEvent(event) {
      if (request.api === "chat.completions") {
        return toChatCompletionStreamChunks(request, commandId, event, accumulator, metadata);
      }
      return toResponsesStreamChunks(request, event, accumulator, metadata);
    },
  };
}

function toCompatibilityUnaryResponse(
  request: CompatibilityTurnRequest,
  terminal: RunnerEvent,
): CompatibilityHttpResponse {
  if (terminal.type === "runner.error") {
    return buildOpenAiErrorResponse(
      500,
      "server_error",
      terminal.payload.message,
      terminal.payload.code ?? "runner_error",
    );
  }
  if (terminal.type === "run.failed") {
    return buildOpenAiErrorResponse(
      500,
      "server_error",
      terminal.payload.error.message,
      terminal.payload.error.code,
    );
  }
  if (terminal.type !== "run.completed") {
    return buildOpenAiErrorResponse(
      500,
      "server_error",
      `Unexpected runner terminal event '${terminal.type}'.`,
      "unexpected_runner_event",
    );
  }

  const usage = toUsage(terminal.payload.result.output.telemetry);
  const summary = summarizeRunTurnResult(terminal.payload.result);
  const text = applyStructuredOutputConstraint(summary.text, request.structuredOutput);
  const toolCalls: CompatibilityToolCall[] = [];
  const metadata: CompatibilityResponseMetadata = {
    sessionId: request.sessionId,
    runId: terminal.runId ?? terminal.payload.result.output.runId,
    model: request.model,
  };

  const body =
    request.api === "chat.completions"
      ? JSON.stringify(
          buildChatCompletionResponse({
            id: `chatcmpl-${randomUUID()}`,
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            text,
            toolCalls,
            finishReason: "stop",
            usage,
            metadata,
            source: summary.raw,
          }),
        )
      : JSON.stringify(
          buildResponsesResponse({
            id: `resp_${randomUUID()}`,
            createdAt: Math.floor(Date.now() / 1000),
            model: request.model,
            text,
            toolCalls,
            usage,
            metadata,
            source: summary.raw,
          }),
        );

  return {
    statusCode: 200,
    headers: {
      ...JSON_HEADERS,
      ...buildCompatibilityHeaders(metadata),
    },
    body,
  };
}

async function collectCompatibilityStream(
  request: CompatibilityTurnRequest,
  execution: CompatibilityRequestExecution,
): Promise<string[]> {
  const command = buildRunStartCommand(request, {});
  const handler = createCompatibilityStreamHandler(request, command.id);
  const chunks: string[] = [];
  await execution.executeStream(command, (event) => {
    const next = handler.onEvent(event);
    if (event.type === "run.completed") {
      const runId = event.runId ?? event.payload.result.output.runId;
      handler.metadata.runId = runId;
    }
    chunks.push(...next);
  });
  return chunks;
}

function toChatCompletionStreamChunks(
  request: CompatibilityTurnRequest,
  commandId: string,
  event: RunnerEvent,
  accumulator: CompatibilityStreamAccumulator,
  metadata: CompatibilityResponseMetadata,
): string[] {
  if (event.type === "run.progress") {
    const toolCall = toToolCall(event, accumulator.toolCalls.length);
    if (toolCall === undefined) {
      return [];
    }
    accumulator.toolCalls.push(toolCall);
    return [
      encodeChatCompletionChunk({
        id: accumulator.responseId,
        object: "chat.completion.chunk",
        created: accumulator.responseCreatedAt,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: accumulator.toolCalls.length - 1,
                  ...toolCall,
                },
              ],
            },
            finish_reason: null,
          },
        ],
        command_id: commandId,
      }),
    ];
  }

  if (event.type === "run.completed") {
    const summary = summarizeRunTurnResult(event.payload.result);
    const text = applyStructuredOutputConstraint(summary.text, request.structuredOutput);
    const runId = event.runId ?? event.payload.result.output.runId;
    metadata.runId = runId;
    return [
      encodeChatCompletionChunk({
        id: accumulator.responseId,
        object: "chat.completion.chunk",
        created: accumulator.responseCreatedAt,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              ...(text.length > 0 ? { content: text } : {}),
            },
            finish_reason: null,
          },
        ],
        usage: toUsage(event.payload.result.output.telemetry),
      }),
      encodeChatCompletionChunk({
        id: accumulator.responseId,
        object: "chat.completion.chunk",
        created: accumulator.responseCreatedAt,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];
  }

  if (event.type === "run.failed" || event.type === "runner.error") {
    return [
      encodeChatCompletionChunk({
        error: {
          message: event.type === "run.failed" ? event.payload.error.message : event.payload.message,
          code: event.type === "run.failed" ? event.payload.error.code : event.payload.code,
        },
      }),
      "data: [DONE]\n\n",
    ];
  }

  return [];
}

function toResponsesStreamChunks(
  request: CompatibilityTurnRequest,
  event: RunnerEvent,
  accumulator: CompatibilityStreamAccumulator,
  metadata: CompatibilityResponseMetadata,
): string[] {
  if (event.type === "run.started") {
    return [
      encodeResponsesEvent("response.created", {
        type: "response",
        id: accumulator.responseId,
        object: "response",
        created_at: accumulator.responseCreatedAt,
        model: request.model,
        status: "in_progress",
      }),
    ];
  }

  if (event.type === "run.progress") {
    const toolCall = toToolCall(event, accumulator.toolCalls.length);
    if (toolCall === undefined) {
      return [];
    }
    accumulator.toolCalls.push(toolCall);
    return [
      encodeResponsesEvent("response.output_item.added", {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      }),
    ];
  }

  if (event.type === "run.completed") {
    const summary = summarizeRunTurnResult(event.payload.result);
    const text = applyStructuredOutputConstraint(summary.text, request.structuredOutput);
    metadata.runId = event.runId ?? event.payload.result.output.runId;
    return [
      ...(text.length > 0
        ? [
            encodeResponsesEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              delta: text,
            }),
            encodeResponsesEvent("response.output_text.done", {
              type: "response.output_text.done",
              text,
            }),
          ]
        : []),
      encodeResponsesEvent("response.completed", {
        type: "response.completed",
        response: buildResponsesResponse({
          id: accumulator.responseId,
          createdAt: accumulator.responseCreatedAt,
          model: request.model,
          text,
          toolCalls: accumulator.toolCalls,
          usage: toUsage(event.payload.result.output.telemetry),
          metadata,
          source: summary.raw,
        }),
      }),
      encodeResponsesEvent("done", "[DONE]"),
    ];
  }

  if (event.type === "run.failed" || event.type === "runner.error") {
    return [
      encodeResponsesEvent("error", {
        type: "error",
        error: {
          message: event.type === "run.failed" ? event.payload.error.message : event.payload.message,
          code: event.type === "run.failed" ? event.payload.error.code : event.payload.code,
        },
      }),
      encodeResponsesEvent("done", "[DONE]"),
    ];
  }

  return [];
}

function buildChatCompletionResponse(input: {
  id: string;
  created: number;
  model: string;
  text: string;
  toolCalls: CompatibilityToolCall[];
  finishReason: "stop" | "tool_calls";
  usage: ReturnType<typeof toUsage>;
  metadata: CompatibilityResponseMetadata;
  source: unknown;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: input.text.length > 0 ? input.text : null,
          ...(input.toolCalls.length > 0 ? { tool_calls: input.toolCalls } : {}),
        },
        finish_reason: input.finishReason,
      },
    ],
    usage: input.usage,
    metadata: {
      kestrel: {
        session_id: input.metadata.sessionId,
        ...(input.metadata.runId !== undefined ? { run_id: input.metadata.runId } : {}),
        ...(input.metadata.threadId !== undefined ? { thread_id: input.metadata.threadId } : {}),
        source: input.source,
      },
    },
  };
}

function buildResponsesResponse(input: {
  id: string;
  createdAt: number;
  model: string;
  text: string;
  toolCalls: CompatibilityToolCall[];
  usage: ReturnType<typeof toUsage>;
  metadata: CompatibilityResponseMetadata;
  source: unknown;
}): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  for (const toolCall of input.toolCalls) {
    output.push({
      type: "function_call",
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }
  output.push({
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: input.text,
      },
    ],
  });

  return {
    id: input.id,
    object: "response",
    created_at: input.createdAt,
    model: input.model,
    status: "completed",
    output,
    output_text: input.text,
    usage: input.usage,
    metadata: {
      kestrel: {
        session_id: input.metadata.sessionId,
        ...(input.metadata.runId !== undefined ? { run_id: input.metadata.runId } : {}),
        ...(input.metadata.threadId !== undefined ? { thread_id: input.metadata.threadId } : {}),
        source: input.source,
      },
    },
  };
}

function parseChatCompletionRequest(
  value: unknown,
  headers: Record<string, string | undefined>,
):
  | { ok: true; value: CompatibilityTurnRequest }
  | { ok: false; message: string; code: string } {
  const record = asRecord(value);
  if (record === undefined) {
    return { ok: false, message: "Request body must be a JSON object.", code: "invalid_body" };
  }

  const model = parseModel(record.model);
  if (model.ok === false) {
    return model;
  }

  if (Array.isArray(record.tools) && record.tools.length > 0) {
    return {
      ok: false,
      message:
        "Compatibility mode exposes Kestrel internal tool calls but does not accept client-supplied tool definitions.",
      code: "unsupported_tools",
    };
  }

  const messages = Array.isArray(record.messages) ? record.messages : undefined;
  if (messages === undefined || messages.length === 0) {
    return { ok: false, message: "messages must be a non-empty array.", code: "invalid_messages" };
  }

  const normalizedMessages = normalizeMessages(messages);
  if (normalizedMessages.ok === false) {
    return normalizedMessages;
  }

  const lastMessage = normalizedMessages.value[normalizedMessages.value.length - 1];
  if (lastMessage?.role !== "user") {
    return {
      ok: false,
      message: "The last chat message must have role 'user'.",
      code: "invalid_messages",
    };
  }

  return {
    ok: true,
    value: {
      api: "chat.completions",
      stream: record.stream === true,
      model: model.value,
      sessionId: readHeader(headers, KESTREL_SESSION_HEADER) ?? `compat-${randomUUID()}`,
      metadata: parseStringMap(record.metadata),
      inputText: lastMessage.text,
      history: normalizedMessages.value
        .slice(0, -1)
        .map((message) => ({
          role: message.role,
          text: message.text,
          timestamp: new Date().toISOString(),
        })),
      structuredOutput: parseStructuredOutput(record.response_format),
    },
  };
}

function parseResponsesRequest(
  value: unknown,
  headers: Record<string, string | undefined>,
):
  | { ok: true; value: CompatibilityTurnRequest }
  | { ok: false; message: string; code: string } {
  const record = asRecord(value);
  if (record === undefined) {
    return { ok: false, message: "Request body must be a JSON object.", code: "invalid_body" };
  }

  const model = parseModel(record.model);
  if (model.ok === false) {
    return model;
  }

  if (Array.isArray(record.tools) && record.tools.length > 0) {
    return {
      ok: false,
      message:
        "Compatibility mode exposes Kestrel internal tool calls but does not accept client-supplied tool definitions.",
      code: "unsupported_tools",
    };
  }

  const normalizedInput = normalizeResponsesInput(record.input);
  if (normalizedInput.ok === false) {
    return normalizedInput;
  }

  const lastMessage = normalizedInput.value[normalizedInput.value.length - 1];
  if (lastMessage === undefined) {
    return {
      ok: false,
      message: "input must provide at least one user message.",
      code: "invalid_input",
    };
  }

  return {
    ok: true,
    value: {
      api: "responses",
      stream: record.stream === true,
      model: model.value,
      sessionId: readHeader(headers, KESTREL_SESSION_HEADER) ?? `compat-${randomUUID()}`,
      metadata: parseStringMap(record.metadata),
      instructions: asNonEmptyString(record.instructions),
      inputText: lastMessage.text,
      history: normalizedInput.value
        .slice(0, -1)
        .map((message) => ({
          role: message.role,
          text: message.text,
          timestamp: new Date().toISOString(),
        })),
      structuredOutput: parseStructuredOutput(asRecord(record.text)?.format ?? record.response_format),
    },
  };
}

function parseModel(
  value: unknown,
): { ok: true; value: string } | { ok: false; message: string; code: string } {
  const model = asNonEmptyString(value);
  if (model === undefined) {
    return { ok: false, message: "model must be a non-empty string.", code: "invalid_model" };
  }

  if (model !== SUPPORTED_COMPATIBILITY_MODEL_ID && COMPATIBILITY_MODEL_ALIASES.has(model) === false) {
    return {
      ok: false,
      message: `Unsupported model '${model}'.`,
      code: "model_not_found",
    };
  }

  return {
    ok: true,
    value: SUPPORTED_COMPATIBILITY_MODEL_ID,
  };
}

function normalizeMessages(
  messages: unknown[],
):
  | {
      ok: true;
      value: Array<{ role: "system" | "assistant" | "user"; text: string }>;
    }
  | { ok: false; message: string; code: string } {
  const normalized: Array<{ role: "system" | "assistant" | "user"; text: string }> = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (record === undefined) {
      return { ok: false, message: "Each message must be an object.", code: "invalid_messages" };
    }
    const role = asNonEmptyString(record.role);
    const text = flattenMessageContent(record.content);
    if (role === undefined || text === undefined) {
      return {
        ok: false,
        message: "Each message must include a supported role and text content.",
        code: "invalid_messages",
      };
    }

    if (role === "developer" || role === "system") {
      normalized.push({ role: "system", text });
      continue;
    }
    if (role === "assistant") {
      normalized.push({ role: "assistant", text });
      continue;
    }
    if (role === "user") {
      normalized.push({ role: "user", text });
      continue;
    }
    if (role === "tool") {
      // Tool output is untrusted conversation context, never a system instruction.
      normalized.push({ role: "user", text: `Tool result:\n${text}` });
      continue;
    }
    return {
      ok: false,
      message: `Unsupported message role '${role}'.`,
      code: "invalid_messages",
    };
  }
  return { ok: true, value: normalized };
}

function normalizeResponsesInput(
  input: unknown,
):
  | {
      ok: true;
      value: Array<{ role: "system" | "assistant" | "user"; text: string }>;
    }
  | { ok: false; message: string; code: string } {
  if (typeof input === "string") {
    const text = input.trim();
    if (text.length === 0) {
      return { ok: false, message: "input must not be empty.", code: "invalid_input" };
    }
    return { ok: true, value: [{ role: "user", text }] };
  }

  if (Array.isArray(input) === false) {
    return { ok: false, message: "input must be a string or array.", code: "invalid_input" };
  }

  const normalized: Array<{ role: "system" | "assistant" | "user"; text: string }> = [];
  for (const item of input) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text.length > 0) {
        normalized.push({ role: "user", text });
      }
      continue;
    }

    const record = asRecord(item);
    if (record === undefined) {
      return { ok: false, message: "Each input item must be a string or object.", code: "invalid_input" };
    }

    if (record.type === "message") {
      const role = asNonEmptyString(record.role);
      const content = Array.isArray(record.content) ? flattenResponseContent(record.content) : flattenMessageContent(record.content);
      if (role === undefined || content === undefined) {
        return { ok: false, message: "Message input items must include role and text content.", code: "invalid_input" };
      }
      if (role === "developer" || role === "system") {
        normalized.push({ role: "system", text: content });
      } else if (role === "assistant") {
        normalized.push({ role: "assistant", text: content });
      } else if (role === "user") {
        normalized.push({ role: "user", text: content });
      } else {
        return { ok: false, message: `Unsupported input role '${role}'.`, code: "invalid_input" };
      }
      continue;
    }

    const type = asNonEmptyString(record.type);
    if (type === "input_text" || type === "text") {
      const text = asNonEmptyString(record.text);
      if (text === undefined) {
        return { ok: false, message: "Text input items must include text.", code: "invalid_input" };
      }
      normalized.push({ role: "user", text });
      continue;
    }

    return {
      ok: false,
      message: `Unsupported input item type '${type ?? "unknown"}'.`,
      code: "invalid_input",
    };
  }

  if (normalized.length === 0) {
    return { ok: false, message: "input must provide at least one text item.", code: "invalid_input" };
  }

  return { ok: true, value: normalized };
}

function flattenMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(content) === false) {
    return undefined;
  }

  const textParts = content.flatMap((part) => {
    const record = asRecord(part);
    if (record === undefined) {
      return [];
    }
    const type = asNonEmptyString(record.type);
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = asNonEmptyString(record.text);
      return text === undefined ? [] : [text];
    }
    return [];
  });
  if (textParts.length === 0) {
    return undefined;
  }
  return textParts.join("\n");
}

function flattenResponseContent(parts: unknown[]): string | undefined {
  const textParts = parts.flatMap((part) => {
    const record = asRecord(part);
    if (record === undefined) {
      return [];
    }
    const type = asNonEmptyString(record.type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = asNonEmptyString(record.text);
      return text === undefined ? [] : [text];
    }
    return [];
  });
  if (textParts.length === 0) {
    return undefined;
  }
  return textParts.join("\n");
}

function parseStructuredOutput(value: unknown): StructuredOutputConstraint | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const type = asNonEmptyString(record.type);
  if (type === "json_object") {
    return { type: "json_object" };
  }
  if (type !== "json_schema") {
    return undefined;
  }

  const jsonSchema = asRecord(record.json_schema);
  const schema = asRecord(jsonSchema?.schema);
  return {
    type: "json_schema",
    schemaName: asNonEmptyString(jsonSchema?.name) ?? "kestrel_response",
    ...(schema !== undefined ? { schema } : {}),
  };
}

function buildStructuredOutputInstruction(constraint: StructuredOutputConstraint): string {
  if (constraint.type === "json_object") {
    return [
      "Return only valid JSON.",
      "Do not include markdown fences, prose, or any content before or after the JSON object.",
    ].join(" ");
  }

  return [
    "Return only valid JSON that matches this JSON Schema exactly.",
    "Do not include markdown fences, prose, or any content before or after the JSON object.",
    `Schema name: ${constraint.schemaName ?? "kestrel_response"}.`,
    `JSON Schema: ${JSON.stringify(constraint.schema ?? {})}`,
  ].join(" ");
}

function applyStructuredOutputConstraint(
  text: string,
  constraint: StructuredOutputConstraint | undefined,
): string {
  if (constraint === undefined) {
    return text;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw createCompatibilityError(
      "structured_output_invalid",
      error instanceof Error ? error.message : "Structured output must be valid JSON.",
    );
  }

  if (constraint.type === "json_schema" && constraint.schema !== undefined) {
    const validate = ajv.compile(constraint.schema);
    if (validate(parsed) !== true) {
      const details = ajv.errorsText(validate.errors ?? [], { separator: "; " });
      throw createCompatibilityError(
        "structured_output_invalid",
        details.length > 0 ? details : "Structured output did not match the requested schema.",
      );
    }
  }

  return JSON.stringify(parsed);
}

function toUsage(telemetry: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const promptTokens = telemetry.inputTokens ?? 0;
  const completionTokens = telemetry.outputTokens ?? 0;
  const totalTokens = telemetry.totalTokens ?? promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function toToolCall(event: RunnerEvent, index: number): CompatibilityToolCall | undefined {
  if (event.type !== "run.progress") {
    return undefined;
  }
  const payload = asRecord(event.payload);
  const update = asRecord(payload?.update);
  if (update?.code !== "TOOL_CALL_STARTED") {
    return undefined;
  }

  const tool = asRecord(update.tool);
  const name = asNonEmptyString(tool?.name);
  if (name === undefined) {
    return undefined;
  }

  return {
    id: `call_${event.runId ?? event.commandId ?? "tool"}_${index}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(update.toolInput ?? {}),
    },
  };
}

export function buildOpenAiErrorResponse(
  statusCode: number,
  type: string,
  message: string,
  code: string,
): CompatibilityHttpResponse {
  return {
    statusCode,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({
      error: {
        message,
        type,
        code,
      },
    }),
  };
}

function parseJsonBody(body: string):
  | { ok: true; value: unknown }
  | { ok: false; message: string } {
  if (body.trim().length === 0) {
    return { ok: false, message: "Request body must not be empty." };
  }
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Request body must be valid JSON.",
    };
  }
}

function resolveCompatibilityProfile(_model: string): TuiProfile {
  const base = createWebDemoProfile();
  return {
    ...base,
    id: SUPPORTED_COMPATIBILITY_MODEL_ID,
    label: "Reference React",
    sessionPrefix: SUPPORTED_COMPATIBILITY_MODEL_ID,
  };
}

function toOpenAiModelRecord(): Record<string, unknown> {
  return {
    id: SUPPORTED_COMPATIBILITY_MODEL_ID,
    object: "model",
    created: 0,
    owned_by: "kestrel",
  };
}

function resolveActorMetadata(headers: Record<string, string | undefined>): RunnerActorMetadata {
  const actorType = readHeader(headers, KESTREL_ACTOR_TYPE_HEADER);
  return {
    actorId: readHeader(headers, KESTREL_ACTOR_ID_HEADER) ?? "compat-user",
    actorType:
      actorType === "operator" || actorType === "service" || actorType === "end_user"
        ? actorType
        : "end_user",
    ...(readHeader(headers, KESTREL_ACTOR_NAME_HEADER) !== undefined
      ? { displayName: readHeader(headers, KESTREL_ACTOR_NAME_HEADER) }
      : {}),
    ...(readHeader(headers, KESTREL_TENANT_HEADER) !== undefined
      ? { tenantId: readHeader(headers, KESTREL_TENANT_HEADER) }
      : {}),
  };
}

function readHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

function parseStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const entries = Object.entries(record).flatMap(([key, entryValue]) => {
    return typeof entryValue === "string" ? [[key, entryValue] as const] : [];
  });
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function createCompatibilityError(code: string, message: string): Error & { compatibilityCode: string } {
  const error = new Error(message) as Error & { compatibilityCode: string };
  error.compatibilityCode = code;
  return error;
}
