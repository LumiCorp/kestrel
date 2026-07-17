import type { ContextPolicyManager } from "./ContextPolicyManager.js";
import type { InteractionManager } from "./InteractionManager.js";
import type {
  RunRepository,
  ThreadStore,
} from "../kestrel/contracts/store.js";
import type {
  ContextPolicyDecision,
  DelegationRecord,
  SubmitTurnInput,
  SubmitTurnResult,
  ThreadRecord,
  TurnExecutor,
} from "./contracts.js";
import type { RuntimeTurnInput } from "../runtime/RuntimeTurn.js";
import { finalizeRuntimeAssistantResponse } from "../runtime/assistantResponseContract.js";
import { normalizeSubmittedHistory } from "../runtime/submittedHistory.js";

export class TurnOrchestrator {
  private readonly executor: TurnExecutor;
  private readonly store: ThreadStore & RunRepository;
  private readonly interactionManager: InteractionManager;
  private readonly contextPolicyManager: ContextPolicyManager;

  constructor(options: {
    executor: TurnExecutor;
    store: ThreadStore & RunRepository;
    interactionManager: InteractionManager;
    contextPolicyManager: ContextPolicyManager;
  }) {
    this.executor = options.executor;
    this.store = options.store;
    this.interactionManager = options.interactionManager;
    this.contextPolicyManager = options.contextPolicyManager;
  }

  async execute(thread: ThreadRecord, input: SubmitTurnInput): Promise<SubmitTurnResult> {
    const submittedMetadata = normalizeSubmittedMetadata(input.metadata);
    const decision = this.contextPolicyManager.evaluateBeforeTurn({
      thread,
      ...(input.manualCompaction !== undefined ? { manualCompaction: input.manualCompaction } : {}),
      ...(input.autoCompaction !== undefined ? { autoCompaction: input.autoCompaction } : {}),
    });
    const runningMetadata = mergeSubmittedHistoryMetadata(thread.metadata, submittedMetadata);
    const runningThread: ThreadRecord = {
      ...thread,
      status: "RUNNING",
      currentRequestId: undefined,
      waitFor: undefined,
      ...(runningMetadata !== undefined ? { metadata: runningMetadata } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.store.upsertThread(runningThread);
    const delegation = await this.store.getDelegationByChildThreadId(thread.threadId);
    const executionMetadata = mergeSubmittedHistoryMetadata(input.runtimeTurn?.metadata, {
      ...(submittedMetadata ?? {}),
      threadId: thread.threadId,
      ...(delegation !== null ? readDelegationRuntimeMetadata(delegation) : {}),
    });

    const execution = await this.executor.executeTurn({
      ...input,
      sessionId: thread.sessionId,
      ...(decision.action === "compact" ? { manualCompaction: true } : {}),
      ...(executionMetadata !== undefined ? { metadata: executionMetadata } : {}),
      runtimeTurn: buildCanonicalRuntimeTurn({
        thread,
        input,
        metadata: executionMetadata,
        manualCompaction: decision.action === "compact",
      }),
    });

    const request = await this.interactionManager.syncWaitState({
      threadId: thread.threadId,
      runId: execution.output.runId,
      ...(delegation !== null ? { delegationId: delegation.delegationId } : {}),
      waitFor: execution.output.waitFor,
    });
    const canonicalResponse = finalizeRuntimeAssistantResponse({
      output: execution.output,
      assistantText: execution.assistantText,
      ...(request !== undefined ? { request } : {}),
    });
    const output = canonicalResponse.output;
    const assistantText = canonicalResponse.assistantText;
    const latestThread = await this.store.getThread(thread.threadId);
    const activeRunId = await this.resolveThreadActiveRunId({
      sessionId: thread.sessionId,
      nextRunId: output.runId,
      thread: latestThread ?? runningThread,
    });
    const updatedAt = new Date().toISOString();
    const metadata = appendAssistantHistory({
      metadata: mergeSubmittedHistoryMetadata((latestThread ?? runningThread).metadata, submittedMetadata),
      assistantText,
      status: output.status,
      runId: output.runId,
      timestamp: updatedAt,
    });
    const updatedThread: ThreadRecord = {
      ...(latestThread ?? runningThread),
      status: mapOutputStatus(output.status),
      activeRunId,
      lastRunStatus: output.status,
      waitFor: output.waitFor,
      currentRequestId: request?.requestId,
      ...(metadata !== undefined ? { metadata } : {}),
      updatedAt,
    };
    await this.store.upsertThread(updatedThread);

    const result: SubmitTurnResult = {
      thread: updatedThread,
      output,
      assistantText,
      ...(execution.session !== undefined ? { session: execution.session } : {}),
      ...(request !== undefined && output.waitFor !== undefined
        ? {
            wait: {
              waitFor: output.waitFor,
              request,
            },
          }
        : {}),
      ...(execution.finalizedPayload !== undefined ? { finalizedPayload: execution.finalizedPayload } : {}),
      compactionAction: decision.action,
    };
    await this.contextPolicyManager.recordPostTurn({
      thread: updatedThread,
      result,
      decision: decision as ContextPolicyDecision,
    });
    return result;
  }

  private async resolveThreadActiveRunId(input: {
    sessionId: string;
    nextRunId: string;
    thread: ThreadRecord;
  }): Promise<string | undefined> {
    const run = await this.store.getRun(input.nextRunId);
    if (run !== null && run.sessionId === input.sessionId) {
      return input.nextRunId;
    }
    return input.thread.activeRunId;
  }
}

function buildCanonicalRuntimeTurn(input: {
  thread: ThreadRecord;
  input: SubmitTurnInput;
  metadata?: Record<string, unknown> | undefined;
  manualCompaction: boolean;
}): RuntimeTurnInput {
  const runtimeTurn = input.input.runtimeTurn;
  return {
    ...(runtimeTurn ?? {
      sessionId: input.thread.sessionId,
      message: input.input.message,
      eventType: input.input.eventType,
    }),
    sessionId: input.thread.sessionId,
    message: input.input.message,
    eventType: input.input.eventType,
    ...(input.input.attachments !== undefined ? { attachments: input.input.attachments } : {}),
    ...(input.input.stepAgent !== undefined ? { stepAgent: input.input.stepAgent } : {}),
    ...(input.input.interactionMode !== undefined ? { interactionMode: input.input.interactionMode } : {}),
    ...(input.input.actSubmode !== undefined ? { actSubmode: input.input.actSubmode } : {}),
    ...(input.input.executionPolicy !== undefined ? { executionPolicy: input.input.executionPolicy } : {}),
    ...(input.input.resumeBlockedRun === true ? { resumeBlockedRun: true } : {}),
    ...(input.manualCompaction || input.input.manualCompaction === true ? { manualCompaction: true } : {}),
    ...(input.input.autoCompaction !== undefined ? { autoCompaction: input.input.autoCompaction } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

function normalizeSubmittedMetadata(
  submitted: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (submitted === undefined || Array.isArray(submitted.history) === false) {
    return submitted;
  }
  return {
    ...submitted,
    history: normalizeSubmittedHistory(submitted.history) ?? [],
  };
}

function readDelegationRuntimeMetadata(delegation: DelegationRecord): Record<string, unknown> {
  const lineage = readDelegationLineage(delegation);
  const activeTaskId = lineage.taskId ?? lineage.parentTaskId;
  return {
    delegationId: delegation.delegationId,
    ...(activeTaskId !== undefined ? { activeTaskId, taskId: activeTaskId } : {}),
    ...(lineage.parentTaskId !== undefined ? { parentTaskId: lineage.parentTaskId } : {}),
    delegationDepth: lineage.delegationDepth ?? 1,
    rootDelegationId: lineage.rootDelegationId ?? delegation.delegationId,
  };
}

function readDelegationLineage(delegation: DelegationRecord): {
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
} {
  const policyLineage = asRecord(asRecord(delegation.policy)?.lineage);
  return {
    ...(delegation.taskId !== undefined
      ? { taskId: delegation.taskId }
      : typeof policyLineage?.taskId === "string"
        ? { taskId: policyLineage.taskId }
        : {}),
    ...(delegation.parentTaskId !== undefined
      ? { parentTaskId: delegation.parentTaskId }
      : typeof policyLineage?.parentTaskId === "string"
        ? { parentTaskId: policyLineage.parentTaskId }
        : {}),
    ...(delegation.delegationDepth !== undefined
      ? { delegationDepth: delegation.delegationDepth }
      : typeof policyLineage?.delegationDepth === "number" && Number.isFinite(policyLineage.delegationDepth)
        ? { delegationDepth: policyLineage.delegationDepth }
        : {}),
    ...(delegation.rootDelegationId !== undefined
      ? { rootDelegationId: delegation.rootDelegationId }
      : typeof policyLineage?.rootDelegationId === "string"
        ? { rootDelegationId: policyLineage.rootDelegationId }
        : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

export function mergeSubmittedHistoryMetadata(
  current: Record<string, unknown> | undefined,
  submitted: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (submitted === undefined) {
    return current;
  }
  if (Array.isArray(submitted?.history) === false) {
    return {
      ...(current ?? {}),
      ...submitted,
    };
  }
  const currentHistory = normalizeSubmittedHistory(current?.history) ?? [];
  const submittedHistory = normalizeSubmittedHistory(submitted.history) ?? [];
  const currentRuntimeAssistantMessages = new Map(
    currentHistory.flatMap((line) => {
      const runId = readRuntimeAssistantHistoryRunId(line);
      return runId === undefined ? [] : [[runId, line] as const];
    }),
  );
  const submittedRuntimeAssistantRunIds = new Set(
    submittedHistory.flatMap((line) => {
      const runId = readRuntimeAssistantHistoryRunId(line);
      return runId === undefined ? [] : [runId];
    }),
  );
  const reconciledCurrentHistory = currentHistory.filter((line) => {
    const runId = readRuntimeAssistantHistoryRunId(line);
    return runId === undefined || submittedRuntimeAssistantRunIds.has(runId) === false;
  });
  const reconciledSubmittedHistory = submittedHistory.map((line) => {
    const runId = readRuntimeAssistantHistoryRunId(line);
    return runId === undefined ? line : currentRuntimeAssistantMessages.get(runId) ?? line;
  });
  const seen = new Set<string>();
  const seenWaitingPromptRunIds = new Set<string>();
  const history = normalizeSubmittedHistory(
    [...reconciledCurrentHistory, ...reconciledSubmittedHistory].filter((line) => {
      const waitingPromptRunId = readRuntimeAssistantHistoryRunId(line);
      if (waitingPromptRunId !== undefined) {
        if (seenWaitingPromptRunIds.has(waitingPromptRunId)) {
          return false;
        }
        seenWaitingPromptRunIds.add(waitingPromptRunId);
      }
      const key = `${line.role}\u0000${line.timestamp}\u0000${line.text}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }),
  ) ?? [];
  return {
    ...(current ?? {}),
    ...submitted,
    history,
  };
}

function mapOutputStatus(status: SubmitTurnResult["output"]["status"]): ThreadRecord["status"] {
  return status === "WAITING" || status === "COMPLETED" || status === "FAILED" ? status : "RUNNING";
}

function appendAssistantHistory(input: {
  metadata?: Record<string, unknown> | undefined;
  assistantText: string | null;
  status: SubmitTurnResult["output"]["status"];
  runId: string;
  timestamp: string;
}): Record<string, unknown> | undefined {
  const entry =
    (input.status === "COMPLETED" || input.status === "WAITING") &&
    input.assistantText !== null
    ? { role: "assistant" as const, text: input.assistantText }
    : undefined;
  if (entry === undefined) {
    return input.metadata;
  }

  const metadata = input.metadata ?? {};
  const history = Array.isArray(metadata.history) ? metadata.history : [];
  const last = history[history.length - 1];
  const duplicateLastEntry = isRecord(last)
    && last.role === entry.role
    && last.text === entry.text
    && readAssistantHistoryRunId(last) === input.runId;
  if (duplicateLastEntry) {
    return metadata;
  }

  return {
    ...metadata,
    history: [
      ...history,
      {
        role: entry.role,
        text: entry.text,
        timestamp: input.timestamp,
        data: { kind: "runtime.assistant_text", runId: input.runId },
      },
    ],
  };
}

function readAssistantHistoryRunId(value: unknown): string | undefined {
  if (isRecord(value) === false || value.role !== "assistant") {
    return ;
  }
  const data = isRecord(value.data) ? value.data : undefined;
  return data?.kind === "runtime.assistant_text" && typeof data.runId === "string"
    ? data.runId
    : undefined;
}

function readWaitingPromptRunId(value: unknown): string | undefined {
  if (isRecord(value) === false || value.role !== "system") {
    return ;
  }
  const data = isRecord(value.data) ? value.data : undefined;
  if (data?.kind !== "runtime.waiting_prompt" || typeof data.runId !== "string") {
    return ;
  }
  const runId = data.runId.trim();
  return runId.length > 0 ? runId : undefined;
}

function readRuntimeAssistantHistoryRunId(value: unknown): string | undefined {
  return readAssistantHistoryRunId(value) ?? readWaitingPromptRunId(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}
