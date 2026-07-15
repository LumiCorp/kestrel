import type { FilesystemResumeReadBudgetDetail } from "../../runtime/filesystemResumeBudget.js";
import type { ProviderReasoningVault } from "../../runtime/ProviderReasoningVault.js";
import type {
  ManagedTaskWorktreeBinding,
  ManagedTaskWorktreeService,
} from "../../workspace/ManagedTaskWorktreeService.js";
import type {
  ClaimStatus,
  EffectFailurePolicy,
  RuntimeError,
  StateNodeRef,
  TransitionStatus,
} from "./base.js";
import type {
  PersistedRuntimeEvent,
  BudgetSnapshot,
  CheckpointInfo,
  MemorySnapshot,
  ProgressUpdateV1,
  ModelReasoningUpdateV1,
  QualityMetrics,
  ReasoningUpdateV1,
  RunConsoleUpdateV1,
  RunEvent,
  RunLogEntry,
  RuntimeEvent,
  RuntimeEventIntent,
} from "./events.js";
import type {
  AgentToolResult,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ToolGateway,
} from "./model-io.js";
import type {
  PersistedEffect,
  RuntimeStore,
  RuntimeWorkspaceCheckpointService,
  SessionRecord,
} from "./store.js";
import type { HeapDiagnosticsReporter } from "../../runtime/heapDiagnostics.js";

export interface UserReplyWaitMetadata extends Record<string, unknown> {
  prompt?: string | undefined;
  question?: string | undefined;
  resumeReply?: string | undefined;
  resumeCommand?: string | undefined;
}

export interface RuntimeInteractionRequestV1 extends Record<string, unknown> {
  version: "v1";
  requestId?: string | undefined;
  kind: "user_input" | "approval";
  eventType: string;
  prompt: string;
  inputSchema?: Record<string, unknown> | undefined;
  approval?: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  } | undefined;
}

export interface UserWaitForMatcher {
  kind: "user";
  eventType: string;
  timeoutMs?: number | undefined;
  metadata?: UserReplyWaitMetadata | undefined;
  interaction?: RuntimeInteractionRequestV1 | undefined;
}

export interface NonUserWaitForMatcher {
  kind: "effect" | "approval" | "region_merge" | "tool";
  eventType: string;
  timeoutMs?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  interaction?: RuntimeInteractionRequestV1 | undefined;
}

export interface RuntimeWaitForMatcher {
  kind: "effect" | "user" | "approval" | "region_merge" | "tool";
  eventType: string;
  timeoutMs?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  interaction?: RuntimeInteractionRequestV1 | undefined;
}

export interface LegacyWaitForMatcher {
  kind?: "effect" | "user" | "approval" | "region_merge" | "tool" | undefined;
  eventType: string;
  reason?: string | undefined;
  timeoutMs?: number;
  metadata?: Record<string, unknown> | undefined;
  interaction?: RuntimeInteractionRequestV1 | undefined;
}

export type WaitForMatcher = UserWaitForMatcher | NonUserWaitForMatcher | RuntimeWaitForMatcher | LegacyWaitForMatcher;

export type ExecutableActionId =
  | "send_message"
  | "assistant.respond"
  | "execute_tool_call"
  | "tool.execute"
  | "test_noop"
  | "test.noop";

export interface ExecutableActionDescriptor {
  actionId: ExecutableActionId;
  category: "runtime_message" | "tool_execution" | "internal_test";
  modelVisible: boolean;
  description: string;
}

export interface Effect {
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string | undefined;
  failurePolicy?: EffectFailurePolicy | undefined;
}

export interface ResolvedEffect {
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  failurePolicy: EffectFailurePolicy;
}

export interface EffectResult {
  idempotencyKey: string;
  status: "DONE" | "FAILED";
  output?: unknown;
  error?: RuntimeError | undefined;
  timestamp: string;
}

export interface ArtifactIntent {
  type: string;
  id?: string | undefined;
  payload: Record<string, unknown>;
}

export interface ClaimIntent {
  id?: string | undefined;
  text: string;
  evidenceIds: string[];
  status: ClaimStatus;
}

export interface RegionWorkIntent {
  region: string;
  stepAgent: string;
  stateNode?: StateNodeRef | undefined;
}

export interface RegionWorkItem {
  id: number;
  sessionId: string;
  region: string;
  stepAgent: string;
  status: "PENDING" | "CLAIMED" | "DONE" | "FAILED";
  stateNode?: StateNodeRef | undefined;
  createdAt: string;
  claimedAt?: string | undefined;
  completedAt?: string | undefined;
  error?: Record<string, unknown> | undefined;
}

export interface Transition {
  nextStepAgent?: string | undefined;
  statePatch?: Record<string, unknown> | undefined;
  status: TransitionStatus;
  effects?: Effect[] | undefined;
  emitEvents?: RuntimeEventIntent[] | undefined;
  waitFor?: WaitForMatcher | undefined;
  stateNode?: StateNodeRef | undefined;
  regionOps?:
    | {
        spawn?: RegionWorkIntent[] | undefined;
        complete?: string[] | undefined;
        syncNode?: string | undefined;
      }
    | undefined;
  artifacts?: ArtifactIntent[] | undefined;
  claims?: ClaimIntent[] | undefined;
  /** Primary-model authored progress, published only after this transition commits. */
  agentProgress?: string | undefined;
}

export interface StepTransition extends Transition {}

export interface StepContext {
  runId: string;
  session: SessionRecord;
  event: RuntimeEvent;
  stepIndex: number;
  memory: MemorySnapshot;
  budget: BudgetSnapshot;
  stateNode?: StateNodeRef | undefined;
  region?:
    | {
        currentRegion?: string | undefined;
        laneCursor?: string | undefined;
        pendingRegions: string[];
      }
    | undefined;
}

export interface StepIO {
  useModel<T>(request: ModelRequest): Promise<T | ModelResponse<unknown>>;
  useTool?(name: string, input: unknown): Promise<AgentToolResult>;
}

export interface StepCommit {
  runId: string;
  event: RuntimeEvent;
  session: SessionRecord;
  stepName: string;
  stepIndex: number;
  transition: StepTransition;
  statePatch?: Record<string, unknown> | undefined;
  resolvedEffects: ResolvedEffect[];
  emitEvents?: RuntimeEventIntent[] | undefined;
  artifacts?: ArtifactIntent[] | undefined;
  claims?: ClaimIntent[] | undefined;
  memory: MemorySnapshot;
  budget: BudgetSnapshot;
  stepFrame?:
    | {
        runLogs: RunLogEntry[];
        runEvents: RunEvent[];
      }
    | undefined;
}

export type StepAgent = (ctx: StepContext, io: StepIO) => Promise<StepTransition>;

export interface NormalizedOutput {
  status: TransitionStatus;
  sessionId: string;
  runId: string;
  finalStep?: string | undefined;
  waitFor?: WaitForMatcher | undefined;
  continuation?:
    | {
        outcome: "requested" | "granted" | "declined";
        extraStepsRequested?: number | undefined;
        extraStepsGranted?: number | undefined;
        extraModelCallsRequested?: number | undefined;
        extraModelCallsGranted?: number | undefined;
        continuationCount?: number | undefined;
      }
    | undefined;
  quality: QualityMetrics;
  checkpoint?: CheckpointInfo | undefined;
  errors: RuntimeError[];
  telemetry: {
    stepsExecuted: number;
    toolCalls: number;
    effectToolCalls?: number | undefined;
    modelCalls: number;
    actionModelCalls?: number | undefined;
    maintenanceModelCalls?: number | undefined;
    durationMs: number;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
  readBudgets?: {
    filesystemResume: FilesystemResumeReadBudgetDetail;
  } | undefined;
}

export interface GuardrailConfig {
  maxStepsPerRun: number;
  maxToolCallsPerRun: number;
  maxModelCallsPerRun: number;
  maxMaintenanceModelCallsPerRun?: number | undefined;
  maxStepVisits?: number | undefined;
  maxConcurrentToolJobsPerRun: number;
  maxConcurrentToolJobsGlobal: number;
  maxQueuedToolJobsPerRun: number;
  maxQueuedToolJobsGlobal?: number | undefined;
  toolBatchCheckpointSize: number;
  toolCallRetryCount: number;
}

export interface RuntimeDependencies {
  store: RuntimeStore;
  registry: StepRegistry;
  stepContractRegistry?: StepContractRegistry | undefined;
  toolGateway: ToolGateway;
  workspaceCheckpointService?: RuntimeWorkspaceCheckpointService | undefined;
  managedTaskWorktreeService?: ManagedTaskWorktreeService | undefined;
  modelGateway: ModelGateway;
  providerReasoningVault?: ProviderReasoningVault | undefined;
  effectRunner: EffectRunner;
  outbox: Outbox;
  runLogger: RunLogger;
  progressReporter: ProgressReporter;
  consoleReporter?: ConsoleReporter | undefined;
  reasoningReporter: ReasoningReporter;
  outputNormalizer: OutputNormalizer;
  runEventListener?: ((event: PersistedRuntimeEvent) => void | Promise<void>) | undefined;
  heapDiagnostics?: HeapDiagnosticsReporter | undefined;
}

export type { ManagedTaskWorktreeBinding, ManagedTaskWorktreeService };

export interface StepRegistry {
  register(name: string, step: StepAgent): void;
  resolve(name: string): StepAgent;
}

export interface StepContractValidationInput {
  stepName: string;
  transition: Transition;
  context: StepContext;
}

export type StepContractValidator = (input: StepContractValidationInput) => void;

export interface StepContractRegistry {
  register(stepName: string, validator: StepContractValidator): void;
  validate(input: StepContractValidationInput): void;
}

export interface EffectRunner {
  runEffects(
    effects: PersistedEffect[],
    context: {
      runId: string;
      sessionId: string;
      stepIndex: number;
      runtimeBudgetRemainingMs?: number | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<{
    stop: boolean;
    terminalStatus?: TransitionStatus;
    errors: RuntimeError[];
  }>;
}

export interface Outbox {
  dispatchInline(runId: string): Promise<void>;
}

export interface RunLogger {
  info(entry: Omit<RunLogEntry, "level">): Promise<void>;
  warn(entry: Omit<RunLogEntry, "level">): Promise<void>;
  error(entry: Omit<RunLogEntry, "level">): Promise<void>;
  notify?(entry: RunLogEntry): Promise<void>;
}

export interface ProgressReporter {
  emit(update: ProgressUpdateV1): Promise<void>;
}

export interface ConsoleReporter {
  emit(update: RunConsoleUpdateV1): Promise<void>;
}

export interface ReasoningReporter {
  emit(update: ReasoningUpdateV1 | ModelReasoningUpdateV1): Promise<void>;
}

export interface OutputNormalizer {
  normalize(input: {
    status: TransitionStatus;
    sessionId: string;
    runId: string;
    finalStep?: string | undefined;
    waitFor?: WaitForMatcher | undefined;
    continuation?: NormalizedOutput["continuation"] | undefined;
    quality: QualityMetrics;
    checkpoint?: CheckpointInfo | undefined;
    errors: RuntimeError[];
    telemetry: {
      stepsExecuted: number;
      toolCalls: number;
      effectToolCalls?: number | undefined;
      modelCalls: number;
      actionModelCalls?: number | undefined;
      maintenanceModelCalls?: number | undefined;
      durationMs: number;
    };
    readBudgets?: NormalizedOutput["readBudgets"] | undefined;
  }): NormalizedOutput;
}
