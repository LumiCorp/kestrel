import type { SessionRecord } from "../kestrel/contracts/store.js";

import type {
  ContextCheckpointAction,
  SubmitTurnResult,
  ThreadRecord,
} from "./contracts.js";
import type { EvidenceRecoverySummary } from "../runtime/evidenceQuality.js";
import { buildRecoveryAdaptationVerdict } from "../runtime/recoveryVerdict.js";

export interface ContextAdaptationEvaluation {
  disposition: "none" | "auto_apply" | "checkpoint";
  recommendedAction?: ContextCheckpointAction | undefined;
  reason?: string | undefined;
  sourceSignals?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
  evidenceRecovery?: EvidenceRecoverySummary | undefined;
}

export function evaluateContextAdaptation(input: {
  thread: ThreadRecord;
  result: SubmitTurnResult;
  session: SessionRecord | null;
}): ContextAdaptationEvaluation {
  const output = input.result.output;
  const waitReason = readString(output.waitFor?.metadata?.reason);
  const contextPressure = readString(
    output.waitFor?.metadata?.contextPressure ??
      input.thread.metadata?.contextPressure ??
      asRecord(asRecord(asRecord(input.session?.state)?.react)?.contextTelemetry)?.contextPressure,
  );
  const handoffPrompt = readString(input.thread.metadata?.handoffPrompt);
  const handoffTitle = readString(input.thread.metadata?.handoffTitle);
  const splitPrompt = readString(input.thread.metadata?.splitPrompt);
  const splitTitle = readString(input.thread.metadata?.splitTitle);
  const splitRecommended =
    input.thread.metadata?.splitRecommended === true || input.thread.metadata?.separableObjective === true;
  const postToolVerification = asRecord(asRecord(asRecord(input.session?.state)?.react)?.postToolVerification);
  const verdict = buildRecoveryAdaptationVerdict({
    evidenceRecovery: postToolVerification?.evidenceRecoverySummary,
    webExtraction: postToolVerification?.webExtractionRetrySummary,
    contextPressure,
    outputStatus: output.status,
    waitFor: output.waitFor,
  });
  const evidenceRecovery = verdict.evidenceRecovery;
  const capabilityLoss = waitReason === "capability_loss";
  const highPressure = verdict.contextPressure.high;
  const criticalPressure = verdict.contextPressure.critical;

  const sourceSignals: Record<string, unknown> = {};
  if (verdict.contextPressure.level !== "none") {
    sourceSignals.contextPressure = verdict.contextPressure.level;
  }
  if (capabilityLoss) {
    sourceSignals.capabilityLoss = true;
  }
  if (evidenceRecovery !== undefined) {
    sourceSignals.evidenceRecovery = toEvidenceRecoverySignals(evidenceRecovery);
  }

  if (capabilityLoss && (highPressure || verdict.recoveryExhausted)) {
    if (splitPrompt !== undefined && splitRecommended) {
      return {
        disposition: "checkpoint",
        recommendedAction: "split_into_child_thread",
        reason: "Capability loss and context pressure suggest splitting the remaining objective into a child thread.",
        sourceSignals,
        metadata: {
          splitPrompt,
          ...(splitTitle !== undefined ? { splitTitle } : {}),
        },
        evidenceRecovery,
      };
    }
    if (handoffPrompt !== undefined) {
      return {
        disposition: "checkpoint",
        recommendedAction: "handoff",
        reason: "Capability loss and context pressure require an operator-directed handoff.",
        sourceSignals,
        metadata: {
          handoffPrompt,
          ...(handoffTitle !== undefined ? { handoffTitle } : {}),
        },
        evidenceRecovery,
      };
    }
    return {
      disposition: "checkpoint",
      recommendedAction: "operator_checkpoint",
      reason: "Runtime capability degraded under context pressure and needs operator review.",
      sourceSignals,
      evidenceRecovery,
    };
  }

  if (
    splitPrompt !== undefined &&
    splitRecommended &&
    (highPressure || verdict.lowSignalState === "elevated" || verdict.lowSignalState === "exhausted")
  ) {
    return {
      disposition: "checkpoint",
      recommendedAction: "split_into_child_thread",
      reason: "The objective appears separable and should continue in a child thread.",
      sourceSignals,
      metadata: {
        splitPrompt,
        ...(splitTitle !== undefined ? { splitTitle } : {}),
      },
      evidenceRecovery,
    };
  }

  if (verdict.recoveryExhausted) {
    return {
      disposition: "checkpoint",
      recommendedAction: "summarize_forward",
      reason: "Evidence recovery is exhausted; summarize the verified work before continuing.",
      sourceSignals,
      metadata: {
        summaryIntent: "research_stall_recovery",
      },
      evidenceRecovery,
    };
  }

  if (highPressure && handoffPrompt !== undefined) {
    return {
      disposition: "checkpoint",
      recommendedAction: "handoff",
      reason: "Thread context pressure is high and the work is suitable for handoff.",
      sourceSignals,
      metadata: {
        handoffPrompt,
        ...(handoffTitle !== undefined ? { handoffTitle } : {}),
      },
      evidenceRecovery,
    };
  }

  if (verdict.autoCompactEligible) {
    return {
      disposition: "auto_apply",
      recommendedAction: "compact",
      reason: "Thread context pressure is elevated; applying low-risk compaction automatically.",
      sourceSignals,
      evidenceRecovery,
    };
  }

  if (highPressure) {
    return {
      disposition: "checkpoint",
      recommendedAction: "compact",
      reason: "Thread context pressure is high and needs an operator checkpoint.",
      sourceSignals,
      evidenceRecovery,
    };
  }

  return {
    disposition: "none",
    ...(evidenceRecovery !== undefined ? { evidenceRecovery } : {}),
  };
}

function toEvidenceRecoverySignals(summary: EvidenceRecoverySummary): Record<string, unknown> {
  return {
    objectiveKey: summary.objectiveKey,
    family: summary.family,
    attempts: summary.attempts,
    lowSignalAttempts: summary.lowSignalAttempts,
    consecutiveLowSignal: summary.consecutiveLowSignal,
    broadenedSearchUsed: summary.broadenedSearchUsed,
    targetedFetchUsed: summary.targetedFetchUsed,
    ...(summary.latest !== undefined
      ? {
          latest: {
            quality: summary.latest.quality,
            lowSignal: summary.latest.lowSignal,
            issues: summary.latest.issues,
          },
        }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
