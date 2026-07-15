import type { RunConsoleChannel } from "./events.js";
import type { RuntimeEvent } from "./events.js";
import type { SessionRecord } from "./store.js";

export interface ToolRuntimeStatus {
  healthy: boolean;
  checkedAt: string;
  providers: Record<string, unknown>;
}

export interface ToolGatewayPreRunContext {
  runId: string;
  event: RuntimeEvent;
  session: SessionRecord;
}

export interface ToolRunContext {
  runId: string;
  sessionId: string;
  payload: unknown;
  sessionState: unknown;
}

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface ModelRequest {
  model?: string | undefined;
  input: unknown;
  messages?: ModelMessage[] | undefined;
  tools?: ModelToolSpec[] | undefined;
  responseSchema?: Record<string, unknown> | undefined;
  responseFormat?: "json" | "text" | undefined;
  providerOptions?: ProviderOptions | undefined;
  reasoning?: ModelReasoningRequest | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type ModelReasoningMode = "off" | "summary" | "provider_visible";

export interface ModelReasoningRequest {
  mode: ModelReasoningMode;
  effort?: "low" | "medium" | "high" | undefined;
  /** Provider-native opaque state from the immediately preceding active turn only. */
  continuation?: ModelReasoningContinuation[] | undefined;
}

export type ModelReasoningFormat =
  | "summary"
  | "provider_thinking"
  | "provider_reasoning_text";

export interface ModelVisibleReasoning {
  format: ModelReasoningFormat;
  text: string;
}

export interface ModelReasoningContinuation {
  provider: "openai" | "anthropic" | "openrouter";
  kind: "encrypted_content" | "signature" | "reasoning_details";
  /** Opaque provider-returned value. This must never be rendered or logged. */
  value: unknown;
}

export type ModelGatewayStreamEvent =
  | {
      type: "attempt.started";
      attempt: number;
    }
  | {
      type: "reasoning.started";
      attempt: number;
      format: ModelReasoningFormat;
    }
  | {
      type: "reasoning.delta";
      attempt: number;
      format: ModelReasoningFormat;
      delta: string;
    }
  | {
      type: "reasoning.completed";
      attempt: number;
      format: ModelReasoningFormat;
    }
  | {
      type: "reasoning.failed";
      attempt: number;
      format: ModelReasoningFormat;
    }
  | {
      type: "reasoning.unavailable";
      attempt: number;
      format: ModelReasoningFormat;
    }
  | {
      type: "output.delta";
      attempt: number;
      delta: string;
    }
  | {
      type: "attempt.completed";
      attempt: number;
    };

export type ModelGatewayEventSink = (
  event: ModelGatewayStreamEvent,
) => void | Promise<void>;

export interface ModelGatewayCallOptions {
  signal?: AbortSignal | undefined;
  /** Awaited only to enqueue the event; consumers must do expensive work asynchronously. */
  onEvent?: ModelGatewayEventSink | undefined;
}

export type ModelBudgetClass = "action" | "maintenance";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ModelContentPart[];
  name?: string | undefined;
  toolCallId?: string | undefined;
  toolCalls?: ModelMessageToolCall[] | undefined;
}

export interface ModelMessageToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputContract?: ModelToolContract | undefined;
}

export interface ModelToolContractField {
  type?: string | string[] | undefined;
  enum?: string[] | undefined;
  description?: string | undefined;
  itemType?: string | string[] | undefined;
}

export interface ModelToolContract {
  type: "object";
  required: string[];
  fields: Record<string, ModelToolContractField>;
  additionalProperties?: boolean | undefined;
}

export interface AgentToolModelContext {
  text: string;
  rawOutputRef: string;
  truncated: boolean;
}

export interface AgentToolAuditRecord {
  toolName: string;
  input: unknown;
  output?: unknown | undefined;
  error?: unknown | undefined;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: "OK" | "FAILED";
}

export interface AgentToolCitationPresentation {
  id: string;
  title: string;
  url?: string | undefined;
  documentId?: string | undefined;
  excerpt?: string | undefined;
}

export interface AgentToolArtifactPresentation {
  id: string;
  title: string;
  kind: string;
  url?: string | undefined;
  mediaType?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface AgentToolPresentation {
  citations?: AgentToolCitationPresentation[] | undefined;
  artifacts?: AgentToolArtifactPresentation[] | undefined;
}

export interface AgentToolResult {
  toolName: string;
  status: "OK" | "FAILED";
  modelContext: AgentToolModelContext;
  auditRecord: AgentToolAuditRecord;
  presentation?: AgentToolPresentation | undefined;
}

export interface ModelToolIntent {
  name: string;
  input: Record<string, unknown>;
  id?: string | undefined;
}

export interface ModelUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface ProviderOptions {
  openrouter?: OpenRouterProviderOptions | undefined;
  openai?: OpenAiProviderOptions | undefined;
  anthropic?: AnthropicProviderOptions | undefined;
}

export interface OpenRouterProviderOptions {
  endpoint?: "chat" | "responses" | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  topP?: number | undefined;
  toolChoice?: "auto" | "none" | "required" | string | undefined;
  responseSchemaName?: string | undefined;
}

export interface OpenAiProviderOptions {
  endpoint?: "chat" | "responses" | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  topP?: number | undefined;
  toolChoice?: "auto" | "none" | "required" | string | undefined;
  responseSchemaName?: string | undefined;
}

export interface AnthropicProviderOptions {
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  topP?: number | undefined;
  toolChoice?: "auto" | "none" | "required" | string | undefined;
  responseSchemaName?: string | undefined;
}

export interface ModelResponse<TOutput = unknown> {
  output?: TOutput | undefined;
  text?: string | undefined;
  toolIntents: ModelToolIntent[];
  usage?: ModelUsage | undefined;
  reasoning?: {
    visible: ModelVisibleReasoning[];
    continuation: ModelReasoningContinuation[];
  } | undefined;
  rawResponse?: unknown;
  provider: {
    name:
      | "openrouter"
      | "openai"
      | "anthropic"
      | "ollama"
      | "lmstudio"
      | "lumi"
      | "runpod";
    model: string;
    endpoint: "chat" | "responses";
    requestId?: string | undefined;
    structuredOutput?:
      | {
          mode: "constrained" | "json_object";
          outcome: "success" | "provider_parsed" | "text_fallback_parsed" | "parse_failed";
          source?: "provider" | "text_fallback" | "none" | undefined;
          schemaRequested?: boolean | undefined;
          schemaName?: string | undefined;
          compilerDiagnostics?: Record<string, unknown> | undefined;
        }
      | undefined;
  };
}

export interface ToolGateway {
  validateInput?(name: string, input: unknown, options?: ToolGatewayCallOptions): Promise<unknown>;
  call(name: string, input: unknown, options?: ToolGatewayCallOptions): Promise<AgentToolResult>;
  preRun?(context: ToolGatewayPreRunContext): Promise<void>;
  getRuntimeStatus?(): Promise<ToolRuntimeStatus>;
  refreshRuntime?(): Promise<ToolRuntimeStatus>;
  close?(): Promise<void>;
}

export interface ToolGatewayCallOptions {
  signal?: AbortSignal | undefined;
  console?: ToolConsoleSink | undefined;
  runContext?: ToolRunContext | undefined;
}

export type ToolConsoleSink = (event: ToolConsoleEvent) => void | Promise<void>;

export interface ToolConsoleEvent {
  status: "chunk" | "snapshot";
  channel: RunConsoleChannel;
  text: string;
  byteLength?: number | undefined;
  cursor?: number | undefined;
  nextCursor?: number | undefined;
  processId?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  truncated?: boolean | undefined;
}

export interface ModelGateway {
  call<T>(request: ModelRequest, options?: ModelGatewayCallOptions): Promise<T>;
}
