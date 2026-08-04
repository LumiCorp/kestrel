import {
  digestCanonicalValue,
  parseRuntimeEvaluationDecisionV1,
  parseRuntimeEvaluationRequestV1,
  parseRuntimeEvaluationVerdictV1,
  type RuntimeEvaluationBudgetV1,
  type RuntimeEvaluationDecisionV1,
  type RuntimeEvaluationRequestV1,
  type RuntimeEvaluationVerdictV1,
} from "../kestrel/contracts/evaluation.js";
import type { ModelRequest } from "../kestrel/contracts/model-io.js";
import type { PersistedArtifact, SessionStore } from "../kestrel/contracts/store.js";
import type { ActiveWaitReport } from "../replay/RunReplayService.js";
import {
  rebuildEvaluationEvidenceProjectionV1,
  RUNTIME_EVALUATION_ARTIFACT_TYPES,
} from "./RuntimeEvaluationCoordinator.js";
import {
  RuntimeEvaluationFailure,
  type RuntimeEvaluationJudgeResultV1,
  type RuntimeEvaluatorRegistry,
} from "./RuntimeEvaluatorRegistry.js";

export const EVALUATION_EVIDENCE_INCOMPLETE =
  "EVALUATION_EVIDENCE_INCOMPLETE" as const;

export interface RecordedRuntimeEvaluationEntryV1 {
  request: RuntimeEvaluationRequestV1;
  projectionDigest: string;
  verdict?: RuntimeEvaluationVerdictV1 | undefined;
  decision: RuntimeEvaluationDecisionV1;
  actionDecision?: RuntimeEvaluationDecisionV1 | undefined;
  failure?: {
    reasonCode: string;
    failedAt: string;
  } | undefined;
}

export interface RecordedRuntimeEvaluationEvidenceV1 {
  status: "complete" | "incomplete";
  errorCode?: typeof EVALUATION_EVIDENCE_INCOMPLETE | undefined;
  entries: RecordedRuntimeEvaluationEntryV1[];
  reviews: Array<{
    requestId?: string | undefined;
    runId?: string | undefined;
    threadId?: string | undefined;
    status: ActiveWaitReport["status"];
    metadata?: Record<string, unknown> | undefined;
  }>;
}

export async function buildRecordedRuntimeEvaluationEvidenceV1(input: {
  store: Pick<SessionStore, "listArtifacts">;
  sessionId: string;
  runId: string;
  waits: ActiveWaitReport[];
}): Promise<RecordedRuntimeEvaluationEvidenceV1 | undefined> {
  const artifacts = await input.store.listArtifacts({
    sessionId: input.sessionId,
    runId: input.runId,
    limit: 1_000,
  });
  const evaluationArtifacts = artifacts.filter((artifact) =>
    Object.values(RUNTIME_EVALUATION_ARTIFACT_TYPES).includes(
      artifact.type as (typeof RUNTIME_EVALUATION_ARTIFACT_TYPES)[keyof typeof RUNTIME_EVALUATION_ARTIFACT_TYPES],
    )
  );
  if (evaluationArtifacts.length === 0) return;

  try {
    const requests = evaluationArtifacts
      .filter((artifact) => artifact.type === RUNTIME_EVALUATION_ARTIFACT_TYPES.request)
      .sort(compareArtifacts)
      .map((artifact) => parseRuntimeEvaluationRequestV1(
        requireRecord(artifact.payload.request, "Recorded evaluation request"),
      ));
    if (requests.length === 0) return incompleteEvidence(input.waits);

    const entries = requests.map((request) => {
      const projection = rebuildEvaluationEvidenceProjectionV1(request.projection);
      const projectionDigest = digestCanonicalValue(projection);
      if (projectionDigest !== request.projectionDigest) {
        throw new RuntimeEvaluationReplayError(
          `Recorded evaluation request '${request.requestId}' projection digest does not match.`,
        );
      }
      const verdictArtifact = findArtifact(
        evaluationArtifacts,
        request.requestId,
        RUNTIME_EVALUATION_ARTIFACT_TYPES.verdict,
      );
      const decisionArtifact = findArtifact(
        evaluationArtifacts,
        request.requestId,
        RUNTIME_EVALUATION_ARTIFACT_TYPES.decision,
      );
      if (decisionArtifact === undefined) {
        throw new RuntimeEvaluationReplayError(
          `Recorded evaluation request '${request.requestId}' has no durable decision.`,
        );
      }
      const verdict = verdictArtifact === undefined
        ? undefined
        : parseRuntimeEvaluationVerdictV1(verdictArtifact.payload.verdict);
      const decision = parseRuntimeEvaluationDecisionV1(
        decisionArtifact.payload.decision,
      );
      if (
        decision.requestId !== request.requestId ||
        (verdict !== undefined &&
          (verdict.requestId !== request.requestId ||
            decision.verdictId !== verdict.verdictId))
      ) {
        throw new RuntimeEvaluationReplayError(
          `Recorded evaluation request '${request.requestId}' evidence identity does not match.`,
        );
      }
      const actionArtifact = findArtifact(
        evaluationArtifacts,
        request.requestId,
        RUNTIME_EVALUATION_ARTIFACT_TYPES.actionDecision,
      );
      const failureArtifact = findArtifact(
        evaluationArtifacts,
        request.requestId,
        RUNTIME_EVALUATION_ARTIFACT_TYPES.failure,
      );
      return {
        request,
        projectionDigest,
        ...(verdict !== undefined ? { verdict } : {}),
        decision,
        ...(actionArtifact !== undefined
          ? {
              actionDecision: parseRuntimeEvaluationDecisionV1(
                actionArtifact.payload.decision,
              ),
            }
          : {}),
        ...(failureArtifact !== undefined
          ? { failure: parseFailure(failureArtifact) }
          : {}),
      } satisfies RecordedRuntimeEvaluationEntryV1;
    });
    return {
      status: "complete",
      entries,
      reviews: evaluationReviews(input.waits),
    };
  } catch (error) {
    if (error instanceof RuntimeEvaluationReplayError) {
      return incompleteEvidence(input.waits);
    }
    return incompleteEvidence(input.waits);
  }
}

export async function reevaluateRecordedRuntimeEvaluationV1(input: {
  entry: RecordedRuntimeEvaluationEntryV1;
  evaluatorRegistry: RuntimeEvaluatorRegistry;
  invokeJudge(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<RuntimeEvaluationJudgeResultV1>;
  budget: RuntimeEvaluationBudgetV1;
  signal?: AbortSignal | undefined;
}): Promise<RuntimeEvaluationVerdictV1> {
  if (input.signal?.aborted === true) {
    throw input.signal.reason ?? new Error("Offline evaluation cancelled.");
  }
  const projection = rebuildEvaluationEvidenceProjectionV1(
    input.entry.request.projection,
  );
  if (digestCanonicalValue(projection) !== input.entry.projectionDigest) {
    throw new RuntimeEvaluationReplayError(
      "Recorded evaluation projection digest does not match live evidence.",
    );
  }
  const evaluator = input.evaluatorRegistry.require(input.entry.request.evaluator);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new RuntimeEvaluationFailure(
      "EVALUATION_TIMEOUT",
      "Offline runtime evaluation exceeded its supplied timeout.",
    )),
    input.budget.timeoutMs,
  );
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const verdict = parseRuntimeEvaluationVerdictV1(
      await evaluator.evaluate(input.entry.request, {
        signal: controller.signal,
        invokeJudge: (request) => input.invokeJudge(request, controller.signal),
      }),
    );
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error("Offline evaluation cancelled.");
    }
    if (
      verdict.requestId !== input.entry.request.requestId ||
      verdict.usage.inputTokens > input.budget.maxInputTokensPerEvaluation ||
      verdict.usage.outputTokens > input.budget.maxOutputTokensPerEvaluation ||
      verdict.usage.totalTokens > input.budget.maxTotalTokens ||
      verdict.usage.costUsd > input.budget.maxTotalCostUsd
    ) {
      throw new RuntimeEvaluationFailure(
        "EVALUATION_BUDGET_EXCEEDED",
        "Offline runtime evaluation exceeded its separately supplied budget.",
      );
    }
    return verdict;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export class RuntimeEvaluationReplayError extends Error {
  readonly code = EVALUATION_EVIDENCE_INCOMPLETE;
}

function incompleteEvidence(
  waits: ActiveWaitReport[],
): RecordedRuntimeEvaluationEvidenceV1 {
  return {
    status: "incomplete",
    errorCode: EVALUATION_EVIDENCE_INCOMPLETE,
    entries: [],
    reviews: evaluationReviews(waits),
  };
}

function evaluationReviews(
  waits: ActiveWaitReport[],
): RecordedRuntimeEvaluationEvidenceV1["reviews"] {
  return waits.flatMap((wait) =>
    wait.metadata?.reason === "evaluation_review"
      ? [{
          ...(wait.requestId !== undefined ? { requestId: wait.requestId } : {}),
          ...(wait.runId !== undefined ? { runId: wait.runId } : {}),
          ...(wait.threadId !== undefined ? { threadId: wait.threadId } : {}),
          status: wait.status,
          ...(wait.metadata !== undefined
            ? { metadata: structuredClone(wait.metadata) }
            : {}),
        }]
      : [],
  );
}

function findArtifact(
  artifacts: PersistedArtifact[],
  requestId: string,
  type: string,
): PersistedArtifact | undefined {
  const matches = artifacts.filter(
    (artifact) =>
      artifact.type === type &&
      artifact.artifactId.startsWith(`${requestId}:`),
  );
  if (matches.length > 1) {
    throw new RuntimeEvaluationReplayError(
      `Recorded evaluation request '${requestId}' has duplicate '${type}' evidence.`,
    );
  }
  return matches[0];
}

function parseFailure(artifact: PersistedArtifact) {
  const payload = requireRecord(artifact.payload, "Recorded evaluation failure");
  return {
    reasonCode: requireString(payload.reasonCode, "Recorded evaluation failure reasonCode"),
    failedAt: requireString(payload.failedAt, "Recorded evaluation failure failedAt"),
  };
}

function compareArtifacts(left: PersistedArtifact, right: PersistedArtifact): number {
  return left.stepIndex - right.stepIndex ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.artifactId.localeCompare(right.artifactId);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeEvaluationReplayError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RuntimeEvaluationReplayError(`${label} must be a non-empty string.`);
  }
  return value;
}
