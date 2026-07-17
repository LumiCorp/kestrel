import { randomUUID } from "node:crypto";

import type {
  EventStore,
  SessionRepository,
  ThreadStore,
} from "../kestrel/contracts/store.js";
import type { StructuredContextSummaryV1 } from "../kestrel/contracts/orchestration.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  ContextCheckpointRecord,
  ContextPolicyDecision,
  ContextSummaryArtifactRecord,
  SubmitTurnResult,
  ThreadCompactionEventRecord,
  ThreadRecord,
} from "./contracts.js";
import { evaluateContextAdaptation } from "./ContextAdaptationEvaluator.js";

interface ContextCheckpointDraft {
  recommendedAction: ContextCheckpointRecord["recommendedAction"];
  reason: string;
  signals?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type ContextStructuredSummaryGenerator = (input: {
  deterministicSummary: StructuredContextSummaryV1;
  thread: ThreadRecord;
  result: SubmitTurnResult;
  action: "compact" | "summarize_forward" | "handoff" | "split_into_child_thread";
  reason: string;
}) => Promise<unknown> | unknown;

export class ContextPolicyManager {
  private readonly store: SessionRepository & ThreadStore & EventStore;
  private readonly structuredSummaryGenerator?: ContextStructuredSummaryGenerator | undefined;

  constructor(
    store: SessionRepository & ThreadStore & EventStore,
    options: { structuredSummaryGenerator?: ContextStructuredSummaryGenerator | undefined } = {},
  ) {
    this.store = store;
    this.structuredSummaryGenerator = options.structuredSummaryGenerator;
  }

  evaluateBeforeTurn(input: {
    thread: ThreadRecord;
    manualCompaction?: boolean | undefined;
    autoCompaction?:
      | {
          enabled?: boolean | undefined;
          state?: string | undefined;
          suppressOnce?: boolean | undefined;
        }
      | undefined;
  }): ContextPolicyDecision {
    if (input.manualCompaction === true) {
      return {
        action: "compact",
        reason: "Manual compaction requested for this turn.",
      };
    }

    if (
      input.autoCompaction?.enabled === true &&
      input.autoCompaction.state === "armed" &&
      input.autoCompaction.suppressOnce !== true
    ) {
      return {
        action: "compact",
        reason: "Auto-compaction was armed before turn execution.",
      };
    }

    return {
      action: "continue",
      reason: "No compaction or checkpoint policy was triggered.",
    };
  }

  async recordPostTurn(input: {
    thread: ThreadRecord;
    result: SubmitTurnResult;
    decision: ContextPolicyDecision;
  }): Promise<void> {
    if (input.decision.action === "compact") {
      await this.persistAdaptationAction({
        thread: input.thread,
        result: input.result,
        action: "compact",
        reason: input.decision.reason,
        summarySource:
          input.result.output.status === "COMPLETED" ? "manual_compaction" : "policy_checkpoint",
        metadata: {
          runId: input.result.output.runId,
          telemetry: input.result.output.telemetry,
          ...(input.decision.metadata !== undefined ? input.decision.metadata : {}),
        },
      });
      return;
    }

    const session = await this.store.getSession(input.thread.sessionId);
    const adaptation = evaluateContextAdaptation({
      thread: input.thread,
      result: input.result,
      session,
    });
    if (adaptation.disposition === "none") {
      return;
    }
    if (adaptation.disposition === "auto_apply" && adaptation.recommendedAction === "compact") {
      await this.persistAdaptationAction({
        thread: input.thread,
        result: input.result,
        action: "compact",
        reason: adaptation.reason ?? "Context adaptation auto-applied compaction.",
        summarySource: "auto_compaction",
        metadata: {
          ...(adaptation.sourceSignals !== undefined ? { sourceSignals: adaptation.sourceSignals } : {}),
          ...(adaptation.evidenceRecovery !== undefined
            ? {
                evidenceRecovery: {
                  family: adaptation.evidenceRecovery.family,
                  attempts: adaptation.evidenceRecovery.attempts,
                  lowSignalAttempts: adaptation.evidenceRecovery.lowSignalAttempts,
                  consecutiveLowSignal: adaptation.evidenceRecovery.consecutiveLowSignal,
                  broadenedSearchUsed: adaptation.evidenceRecovery.broadenedSearchUsed,
                  targetedFetchUsed: adaptation.evidenceRecovery.targetedFetchUsed,
                },
              }
            : {}),
        },
      });
      return;
    }

    const checkpointDraft = buildContextCheckpointDraft({
      result: input.result,
      decision: input.decision,
      adaptation,
    });
    if (checkpointDraft === undefined) {
      return;
    }
    const checkpoint = await this.upsertCoalescedCheckpoint({
      thread: input.thread,
      runId: input.result.output.runId,
      checkpoint: checkpointDraft,
    });
    await this.store.upsertContextCheckpoint(checkpoint);
    await this.store.appendRunEvent({
      runId: input.result.output.runId,
      sessionId: input.thread.sessionId,
      type: "context.checkpoint_requested",
      level: "WARN",
      timestamp: new Date().toISOString(),
      metadata: {
        threadId: input.thread.threadId,
        checkpointId: checkpoint.checkpointId,
        recommendedAction: checkpoint.recommendedAction,
        reason: checkpoint.reason,
        ...(checkpoint.signals !== undefined ? { signals: checkpoint.signals } : {}),
      },
    });
  }

  private async upsertCoalescedCheckpoint(input: {
    thread: ThreadRecord;
    runId: string;
    checkpoint: ContextCheckpointDraft;
  }): Promise<ContextCheckpointRecord> {
    const pending = (await this.store.listContextCheckpoints({
      threadId: input.thread.threadId,
      status: "PENDING",
    })).filter((checkpoint) => checkpoint.metadata?.kind !== "fan_in");
    const newestPending = pending[0];
    const checkpointReasonClass = toCheckpointReasonClass(
      input.checkpoint.recommendedAction,
      input.checkpoint.reason,
    );
    const reuseCheckpoint =
      newestPending !== undefined &&
      newestPending.recommendedAction === input.checkpoint.recommendedAction &&
      readCheckpointReasonClass(newestPending) === checkpointReasonClass;
    const targetCheckpointId = reuseCheckpoint
      ? newestPending.checkpointId
      : `checkpoint-${randomUUID()}`;
    const createdAt = reuseCheckpoint ? newestPending.createdAt : new Date().toISOString();
    const metadata = {
      ...(input.checkpoint.metadata ?? {}),
      reasonClass: checkpointReasonClass,
    };
    const checkpoint: ContextCheckpointRecord = {
      checkpointId: targetCheckpointId,
      threadId: input.thread.threadId,
      runId: input.runId,
      status: "PENDING",
      recommendedAction: input.checkpoint.recommendedAction,
      reason: input.checkpoint.reason,
      ...(input.checkpoint.signals !== undefined ? { signals: input.checkpoint.signals } : {}),
      metadata,
      createdAt,
    };
    const supersededAt = new Date().toISOString();
    const supersedeTargets = pending.filter((entry) => entry.checkpointId !== targetCheckpointId);
    for (const entry of supersedeTargets) {
      await this.store.upsertContextCheckpoint({
        ...entry,
        status: "DEFERRED",
        resolutionAction: "continue",
        resolvedBy: "policy",
        resolvedAt: supersededAt,
        metadata: {
          ...(entry.metadata ?? {}),
          supersededByCheckpointId: targetCheckpointId,
          supersededAt,
        },
      });
    }
    return checkpoint;
  }

  private async persistAdaptationAction(input: {
    thread: ThreadRecord;
    result: SubmitTurnResult;
    action: "compact" | "summarize_forward" | "handoff" | "split_into_child_thread";
    reason: string;
    summarySource: ContextSummaryArtifactRecord["source"];
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void> {
    const createdAt = new Date().toISOString();
    const deterministicSummary = buildDeterministicStructuredContextSummary({
      threadId: input.thread.threadId,
      runId: input.result.output.runId,
      turnId: readString(input.thread.metadata?.activeTurnId),
      createdAt,
      result: input.result,
    });
    const structuredSummary = parseStructuredContextSummary(
      await this.generateStructuredSummary({
        deterministicSummary,
        thread: input.thread,
        result: input.result,
        action: input.action,
        reason: input.reason,
      }),
      deterministicSummary,
    );
    const summary = formatStructuredContextSummary(structuredSummary);
    const artifact: ContextSummaryArtifactRecord = {
      artifactId: `context-summary-${randomUUID()}`,
      threadId: input.thread.threadId,
      runId: input.result.output.runId,
      summary,
      source: input.summarySource,
      metadata: {
        runId: input.result.output.runId,
        status: input.result.output.status,
        action: input.action,
        structuredSummary,
        ...(input.metadata ?? {}),
      },
      createdAt,
    };
    await this.store.saveContextSummaryArtifact(artifact);

    const event: ThreadCompactionEventRecord = {
      eventId: `compaction-${randomUUID()}`,
      threadId: input.thread.threadId,
      runId: input.result.output.runId,
      action: input.action,
      reason: input.reason,
      summaryArtifactId: artifact.artifactId,
      metadata: {
        runId: input.result.output.runId,
        telemetry: input.result.output.telemetry,
        ...(input.metadata ?? {}),
      },
      createdAt,
    };
    assertCompactionEventInvariant(event, { summaryRequired: true });
    await this.store.appendThreadCompactionEvent(event);
    await this.store.appendRunEvent({
      runId: input.result.output.runId,
      sessionId: input.thread.sessionId,
      type: input.action === "compact" ? "context.compaction_applied" : "context.adaptation_applied",
      level: "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        threadId: input.thread.threadId,
        compactionEventId: event.eventId,
        summaryArtifactId: artifact.artifactId,
        action: event.action,
        reason: event.reason,
        ...(input.metadata ?? {}),
      },
    });
  }

  private async generateStructuredSummary(input: {
    deterministicSummary: import("../kestrel/contracts/orchestration.js").StructuredContextSummaryV1;
    thread: ThreadRecord;
    result: SubmitTurnResult;
    action: "compact" | "summarize_forward" | "handoff" | "split_into_child_thread";
    reason: string;
  }): Promise<unknown> {
    if (this.structuredSummaryGenerator !== undefined) {
      return this.structuredSummaryGenerator(input);
    }
    return input.deterministicSummary;
  }
}

function assertCompactionEventInvariant(
  event: ThreadCompactionEventRecord,
  options: { summaryRequired: boolean },
): void {
  const missing: string[] = [];
  if (event.threadId.trim().length === 0) {
    missing.push("threadId");
  }
  if (event.runId === undefined || event.runId.trim().length === 0) {
    missing.push("runId");
  }
  if (event.action.trim().length === 0) {
    missing.push("action");
  }
  if (event.reason.trim().length === 0) {
    missing.push("reason");
  }
  if (
    options.summaryRequired &&
    (event.summaryArtifactId === undefined || event.summaryArtifactId.trim().length === 0)
  ) {
    missing.push("summaryArtifactId");
  }
  if (missing.length > 0) {
    throw createRuntimeFailure(
      "COMPACTION_EVENT_INVALID",
      `Invalid compaction event record; missing ${missing.join(", ")}`,
      { missing },
    );
  }
}

function buildContextCheckpointDraft(input: {
  result: SubmitTurnResult;
  decision: ContextPolicyDecision;
  adaptation: ReturnType<typeof evaluateContextAdaptation>;
}): ContextCheckpointDraft | undefined {
  if (
    input.adaptation.disposition !== "checkpoint" ||
    input.adaptation.recommendedAction === undefined ||
    input.adaptation.reason === undefined
  ) {
    return ;
  }

  return {
    recommendedAction: input.adaptation.recommendedAction,
    reason: input.adaptation.reason,
    ...(input.adaptation.sourceSignals !== undefined ? { signals: input.adaptation.sourceSignals } : {}),
    metadata: {
      runStatus: input.result.output.status,
      policyAction: input.decision.action,
      ...(input.adaptation.metadata !== undefined ? input.adaptation.metadata : {}),
    },
  };
}

function toCheckpointReasonClass(
  action: ContextCheckpointRecord["recommendedAction"],
  reason: string,
): string {
  return `${action}:${normalizeCheckpointReason(reason)}`;
}

function readCheckpointReasonClass(checkpoint: ContextCheckpointRecord): string {
  const explicit = checkpoint.metadata?.reasonClass;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return toCheckpointReasonClass(checkpoint.recommendedAction, checkpoint.reason);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function buildDeterministicStructuredContextSummary(input: {
  threadId: string;
  runId: string;
  turnId?: string | undefined;
  createdAt: string;
  result: SubmitTurnResult;
}): StructuredContextSummaryV1 {
  return {
    version: "v1",
    objective: readString(input.result.thread.title) ?? `Continue thread ${input.threadId}`,
    decisions: [],
    completedWork: [`Run ${input.runId} finished with status ${input.result.output.status}.`],
    openQuestions: input.result.wait !== undefined ? ["Waiting for user or external continuation."] : [],
    artifactsFiles: [],
    blockers: input.result.output.errors.map((error) => error.message),
    nextAction: input.result.output.status === "COMPLETED" ? "Continue with the next user request." : "Resume from the latest runtime state.",
    sourceRunIds: [input.runId],
    sourceThreadId: input.threadId,
    ...(input.turnId !== undefined ? { sourceTurnId: input.turnId } : {}),
    generatedAt: input.createdAt,
    generatedBy: "deterministic",
  };
}

function parseStructuredContextSummary(
  value: unknown,
  fallback: StructuredContextSummaryV1,
): StructuredContextSummaryV1 {
  const record = asRecord(value);
  if (record === undefined || record.version !== "v1") {
    return fallback;
  }
  return {
    version: "v1",
    objective: readString(record.objective) ?? fallback.objective,
    decisions: readStringArray(record.decisions),
    completedWork: readStringArray(record.completedWork),
    openQuestions: readStringArray(record.openQuestions),
    artifactsFiles: readStringArray(record.artifactsFiles),
    blockers: readStringArray(record.blockers),
    nextAction: readString(record.nextAction) ?? fallback.nextAction,
    sourceRunIds: readStringArray(record.sourceRunIds).length > 0 ? readStringArray(record.sourceRunIds) : fallback.sourceRunIds,
    ...(readString(record.sourceThreadId) !== undefined ? { sourceThreadId: readString(record.sourceThreadId) } : {}),
    ...(readString(record.sourceTurnId) !== undefined ? { sourceTurnId: readString(record.sourceTurnId) } : {}),
    generatedAt: readString(record.generatedAt) ?? fallback.generatedAt,
    generatedBy: record.generatedBy === "model" ? "model" : fallback.generatedBy,
  };
}

function formatStructuredContextSummary(summary: StructuredContextSummaryV1): string {
  return [
    `Objective: ${summary.objective}`,
    renderList("Decisions", summary.decisions),
    renderList("Completed work", summary.completedWork),
    renderList("Open questions", summary.openQuestions),
    renderList("Artifacts/files", summary.artifactsFiles),
    renderList("Blockers", summary.blockers),
    `Next action: ${summary.nextAction}`,
  ].filter((line) => line.length > 0).join("\n");
}

function renderList(label: string, values: string[]): string {
  if (values.length === 0) {
    return "";
  }
  return `${label}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const string = readString(entry);
        return string !== undefined ? [string] : [];
      })
    : [];
}

function normalizeCheckpointReason(reason: string): string {
  return reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .slice(0, 160);
}
