import type {
  RunEventLevel,
  RunEventType,
} from "./base.js";

export interface RuntimeEvent {
  id: string;
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
  stepAgent?: string | undefined;
  timestamp?: string | undefined;
}

export interface RuntimeEventIntent {
  type: string;
  payload: Record<string, unknown>;
}

export interface MemorySnapshot {
  working: Record<string, unknown>;
  episodicRef?: string | undefined;
  semanticRef?: string | undefined;
}

export interface BudgetSnapshot {
  remainingMs: number;
  tokensUsed: number;
  toolCallsUsed: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  costUsd?: number | undefined;
}

export interface QualityMetrics {
  citationCoverage: number;
  unresolvedClaims: number;
  reworkRate: number;
  thrashIndex: number;
}

export interface CheckpointInfo {
  stateNode?: string | undefined;
  resumeToken?: string | undefined;
}

export interface PersistedRuntimeEvent {
  runId: string;
  sessionId: string;
  stepIndex?: number | undefined;
  type: RunEventType;
  level: RunEventLevel;
  timestamp: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface RunEvent extends PersistedRuntimeEvent {}

export type RunEventListener = (event: PersistedRuntimeEvent) => void | Promise<void>;

export interface RunLogEntry {
  runId: string;
  sessionId: string;
  stepIndex?: number | undefined;
  eventName: string;
  level: "INFO" | "WARN" | "ERROR";
  metadata?: Record<string, unknown> | undefined;
}

export type ProgressKind = "stage" | "tool" | "waiting" | "heartbeat";
export type ProgressPhase =
  | "engine"
  | "agent"
  | "route"
  | "chat"
  | "thinker"
  | "resolver"
  | "acter";
export type ProgressCode =
  | "RUN_STARTED"
  | "RUN_RESUMED"
  | "RESUMED_FROM_WAIT"
  | "STEP_SELECTED"
  | "STEP_STARTED"
  | "STEP_COMMITTED"
  | "RUN_TERMINAL"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "MODEL_CALL_STARTED"
  | "MODEL_CALL_DONE"
  | "MODEL_CALL_FAILED"
  | "TOOL_CALL_STARTED"
  | "TOOL_CALL_DONE"
  | "TOOL_CALL_FAILED"
  | "WAITING_FOR_EVENT"
  | "RUN_STILL_ACTIVE";

export type ReasoningMilestone =
  | "phase_changed"
  | "tool_activity"
  | "effect_activity"
  | "wait_entered"
  | "run_terminal";

export interface ProgressUpdateV1 {
  version: "v1";
  runId: string;
  sessionId: string;
  ts: string;
  seq: number;
  kind: ProgressKind;
  phase: ProgressPhase;
  code: ProgressCode;
  message: string;
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
  tool?:
    | {
        name: string;
        status: "STARTED" | "DONE" | "FAILED";
        latencyMs?: number | undefined;
      }
    | undefined;
  waitFor?:
    | {
        eventType: string;
        timeoutMs?: number | undefined;
      }
    | undefined;
  queueDepthRun?: number | undefined;
  queueDepthGlobal?: number | undefined;
  queueWaitMs?: number | undefined;
  chunkIndex?: number | undefined;
  chunkSize?: number | undefined;
  progress?:
    | {
        completedSteps?: number | undefined;
        maxSteps?: number | undefined;
      }
    | undefined;
  persist: boolean;
}

export interface ReasoningUpdateV1 {
  version: "v1";
  runId: string;
  sessionId: string;
  ts: string;
  seq: number;
  milestone: ReasoningMilestone;
  message: string;
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
  model?:
    | {
        provider?: string | undefined;
        model?: string | undefined;
        endpoint?: string | undefined;
        requestId?: string | undefined;
        latencyMs?: number | undefined;
      }
    | undefined;
}

export type RunConsoleChannel = "stdout" | "stderr" | "merged";

export type RunConsoleStatus =
  | "started"
  | "chunk"
  | "snapshot"
  | "completed"
  | "failed"
  | "truncated";

export interface RunConsoleUpdateV1 {
  version: "v1";
  runId: string;
  sessionId: string;
  ts: string;
  seq: number;
  toolCallId?: string | undefined;
  toolName: string;
  status: RunConsoleStatus;
  channel?: RunConsoleChannel | undefined;
  text?: string | undefined;
  byteLength?: number | undefined;
  cursor?: number | undefined;
  nextCursor?: number | undefined;
  processId?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  exitCode?: number | undefined;
  truncated?: boolean | undefined;
}

export type RunToolPhase = "started" | "completed" | "failed";

export interface RunToolUpdateV1 {
  version: "v1";
  runId: string;
  sessionId: string;
  ts: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  phase: RunToolPhase;
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
  displayName?: string | undefined;
  toolFamily?: string | undefined;
  provider?: string | undefined;
  input?: unknown;
  output?: unknown;
  error?:
    | {
        code?: string | undefined;
        message: string;
        details?: Record<string, unknown> | undefined;
      }
    | undefined;
  durationMs?: number | undefined;
}

export interface ReasoningSidecarConfig {
  enabled?: boolean | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  maxTokens?: number | undefined;
  inheritProcessEnv?: boolean | undefined;
}
