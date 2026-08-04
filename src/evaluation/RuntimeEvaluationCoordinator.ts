import { createHash } from "node:crypto";

import type { RunEventType } from "../kestrel/contracts/base.js";
import {
  EVALUATION_EVIDENCE_PROJECTION_VERSION,
  RUNTIME_EVALUATION_DECISION_VERSION,
  RUNTIME_EVALUATION_REQUEST_VERSION,
  digestCanonicalValue,
  parseEvaluationEvidenceProjectionV1,
  parseRuntimeEvaluationDecisionV1,
  parseRuntimeEvaluationPolicyV1,
  parseRuntimeEvaluationRequestV1,
  parseRuntimeEvaluationVerdictV1,
  type EvaluationEvidenceProjectionV1,
  type RuntimeEvaluationDecisionV1,
  type RuntimeEvaluationHookKindV1,
  type RuntimeEvaluationPolicyV1,
  type RuntimeEvaluationRequestV1,
  type RuntimeEvaluationVerdictV1,
} from "../kestrel/contracts/evaluation.js";
import type { ModelRequest } from "../kestrel/contracts/model-io.js";
import type { RuntimeStore } from "../kestrel/contracts/store.js";
import type {
  ExecutionBoundaryDecisionV1,
} from "../kestrel/contracts/execution-boundary-policy.js";
import type { ExecutionBoundaryPolicyRuntime } from "../security/ExecutionBoundaryPolicy.js";
import type {
  RuntimeEvaluationJudgeResultV1,
  RuntimeEvaluatorRegistry,
} from "./RuntimeEvaluatorRegistry.js";
import { RuntimeEvaluationFailure } from "./RuntimeEvaluatorRegistry.js";

export const RUNTIME_EVALUATION_LIFECYCLE_EVENT_TYPES = Object.freeze([
  "evaluation.requested",
  "evaluation.started",
  "evaluation.completed",
  "evaluation.failed",
  "evaluation.skipped",
  "evaluation.action.selected",
] as const satisfies readonly RunEventType[]);

export interface RuntimeEvaluationRuntimeConfiguration {
  policy: RuntimeEvaluationPolicyV1;
  executionProfileFingerprint: string;
  evaluatorRegistry: RuntimeEvaluatorRegistry;
  invokeJudge(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<RuntimeEvaluationJudgeResultV1>;
}

export interface RuntimeEvaluationEvidenceInputV1 {
  evidenceId: string;
  kind: EvaluationEvidenceProjectionV1["evidence"][number]["kind"];
  value: unknown;
}

export interface RuntimeEvaluationHookInputV1 {
  runId: string;
  sessionId: string;
  threadId?: string | undefined;
  stepIndex: number;
  hookKind: RuntimeEvaluationHookKindV1;
  sourceId: string;
  objective: string;
  candidateOutput?: string | undefined;
  evidence?: RuntimeEvaluationEvidenceInputV1[] | undefined;
  finalRevisionsUsed?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface RuntimeEvaluationHookResultV1 {
  request: RuntimeEvaluationRequestV1;
  verdict?: RuntimeEvaluationVerdictV1 | undefined;
  decision: RuntimeEvaluationDecisionV1;
  sanitizedCandidate?: string | undefined;
  assistantOutputBoundaryDecision?: ExecutionBoundaryDecisionV1 | undefined;
}

interface RuntimeEvaluationCoordinatorOptions
  extends RuntimeEvaluationRuntimeConfiguration {
  store: Pick<RuntimeStore, "appendArtifacts" | "getArtifact" | "listArtifacts">;
  executionBoundaryRuntime: ExecutionBoundaryPolicyRuntime;
  appendLifecycleEvent(input: {
    runId: string;
    sessionId: string;
    type: (typeof RUNTIME_EVALUATION_LIFECYCLE_EVENT_TYPES)[number] | "execution_boundary.decision";
    level: "INFO" | "WARN" | "ERROR";
    metadata: Record<string, unknown>;
    stepIndex?: number | undefined;
  }): Promise<void>;
  now?: (() => Date) | undefined;
}

interface EvaluationBudgetState {
  evaluationsUsed: number;
  intermediateEvaluationsUsed: number;
  finalEvaluationsUsed: number;
  totalTokensUsed: number;
  totalCostUsd: number;
  finalRevisionsUsed: number;
}

const ARTIFACT_TYPES = {
  request: "runtime_evaluation.request.v1",
  attempt: "runtime_evaluation.attempt.v1",
  verdict: "runtime_evaluation.verdict.v1",
  failure: "runtime_evaluation.failure.v1",
  decision: "runtime_evaluation.decision.v1",
  actionDecision: "runtime_evaluation.action_decision.v1",
} as const;

export class RuntimeEvaluationCoordinator {
  readonly policy: RuntimeEvaluationPolicyV1;
  readonly executionProfileFingerprint: string;
  private readonly options: RuntimeEvaluationCoordinatorOptions;
  private readonly runLocks = new Map<string, Promise<void>>();

  constructor(options: RuntimeEvaluationCoordinatorOptions) {
    this.policy = parseRuntimeEvaluationPolicyV1(options.policy);
    if (/^[0-9a-f]{64}$/u.test(options.executionProfileFingerprint) === false) {
      throw new Error(
        "Runtime evaluation execution profile fingerprint must be 64 lowercase hex characters.",
      );
    }
    this.executionProfileFingerprint = options.executionProfileFingerprint;
    this.options = options;
  }

  matchesHook(kind: RuntimeEvaluationHookKindV1, sourceId: string): boolean {
    const hook = this.policy.hooks.find((entry) => entry.kind === kind);
    if (hook === undefined) return false;
    return kind === "pre_delivery" || hook.selectorIds.includes(sourceId);
  }

  async bindRecoveryDecision(input: {
    decision: RuntimeEvaluationDecisionV1;
    recoveryDecisionId: string;
    stepIndex: number;
  }): Promise<RuntimeEvaluationDecisionV1> {
    const decision = parseRuntimeEvaluationDecisionV1(input.decision);
    if (
      decision.profileFingerprint !== this.executionProfileFingerprint ||
      decision.policyRevision !== this.policy.revision
    ) {
      throw new Error(
        "Runtime evaluation recovery binding does not match the resolved policy.",
      );
    }
    const bound = parseRuntimeEvaluationDecisionV1({
      ...decision,
      decisionId: `evaluation-decision:${shortDigest({
        evaluationDecisionId: decision.decisionId,
        recoveryDecisionId: input.recoveryDecisionId,
      })}`,
      recoveryDecisionId: input.recoveryDecisionId,
    });
    await this.persistArtifact({
      runId: bound.runId,
      sessionId: bound.sessionId,
      stepIndex: input.stepIndex,
      artifactId: artifactId(bound.requestId, "action-decision"),
      type: ARTIFACT_TYPES.actionDecision,
      payload: { decision: structuredClone(bound) },
    });
    await this.options.appendLifecycleEvent({
      runId: bound.runId,
      sessionId: bound.sessionId,
      type: "evaluation.action.selected",
      level: bound.disposition === "continue" ? "INFO" : "WARN",
      metadata: {
        requestId: bound.requestId,
        evaluationDecisionId: bound.decisionId,
        recoveryDecisionId: input.recoveryDecisionId,
        disposition: bound.disposition,
      },
      stepIndex: input.stepIndex,
    });
    return bound;
  }

  async evaluateHook(
    input: RuntimeEvaluationHookInputV1,
  ): Promise<RuntimeEvaluationHookResultV1 | undefined> {
    if (this.matchesHook(input.hookKind, input.sourceId) === false) return;
    return this.withRunLock(input.runId, () => this.evaluateHookLocked(input));
  }

  private async evaluateHookLocked(
    input: RuntimeEvaluationHookInputV1,
  ): Promise<RuntimeEvaluationHookResultV1> {
    throwIfAborted(input.signal);
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const evidence = await this.buildSanitizedProjection(input, now);
    const requestId = evaluationRequestId({
      runId: input.runId,
      stepIndex: input.stepIndex,
      hookKind: input.hookKind,
      sourceId: input.sourceId,
      candidateDigest:
        evidence.sanitizedCandidate === undefined
          ? undefined
          : digestCanonicalValue(evidence.sanitizedCandidate),
      objectiveDigest: digestCanonicalValue(input.objective.trim()),
      evidenceDigest: digestCanonicalValue(input.evidence ?? []),
      evaluatorId: this.policy.evaluator.evaluatorId,
      evaluatorVersion: this.policy.evaluator.evaluatorVersion,
      profileFingerprint: this.executionProfileFingerprint,
      policyRevision: this.policy.revision,
    });
    const existingDecision = await this.readArtifact(
      input.sessionId,
      artifactId(requestId, "decision"),
      ARTIFACT_TYPES.decision,
    );
    if (existingDecision !== undefined) {
      const request = parseRuntimeEvaluationRequestV1(
        requireRecord(
          (await this.readArtifact(
            input.sessionId,
            artifactId(requestId, "request"),
            ARTIFACT_TYPES.request,
          ))?.request,
          "Persisted runtime evaluation request",
        ),
      );
      const verdictArtifact = await this.readArtifact(
        input.sessionId,
        artifactId(requestId, "verdict"),
        ARTIFACT_TYPES.verdict,
      );
      return {
        request,
        ...(verdictArtifact !== undefined
          ? { verdict: parseRuntimeEvaluationVerdictV1(verdictArtifact.verdict) }
          : {}),
        decision: parseRuntimeEvaluationDecisionV1(existingDecision.decision),
        ...(evidence.sanitizedCandidate !== undefined
          ? { sanitizedCandidate: evidence.sanitizedCandidate }
          : {}),
        ...(evidence.assistantOutputBoundaryDecision !== undefined
          ? {
              assistantOutputBoundaryDecision:
                evidence.assistantOutputBoundaryDecision,
            }
          : {}),
      };
    }

    const budget = await this.loadBudgetState(input);
    const persistedRequest = await this.readArtifact(
      input.sessionId,
      artifactId(requestId, "request"),
      ARTIFACT_TYPES.request,
    );
    const request = persistedRequest === undefined
      ? parseRuntimeEvaluationRequestV1({
          version: RUNTIME_EVALUATION_REQUEST_VERSION,
          requestId,
          evaluator: this.policy.evaluator,
          assets: this.policy.assets,
          judge: this.policy.judge,
          projection: evidence.projection,
          projectionDigest: digestCanonicalValue(evidence.projection),
          budget: toBudgetSnapshot(budget),
          createdAt: now,
        })
      : parseRuntimeEvaluationRequestV1(
          requireRecord(
            persistedRequest.request,
            "Persisted runtime evaluation request",
          ),
        );
    if (persistedRequest === undefined) {
      await this.persistArtifact({
        runId: input.runId,
        sessionId: input.sessionId,
        stepIndex: input.stepIndex,
        artifactId: artifactId(requestId, "request"),
        type: ARTIFACT_TYPES.request,
        payload: { request: structuredClone(request) },
      });
      await this.appendLifecycle(input, "evaluation.requested", "INFO", {
        request: structuredClone(request),
      });
    }

    const existingVerdictArtifact = await this.readArtifact(
      input.sessionId,
      artifactId(requestId, "verdict"),
      ARTIFACT_TYPES.verdict,
    );
    if (existingVerdictArtifact !== undefined) {
      const verdict = parseRuntimeEvaluationVerdictV1(
        existingVerdictArtifact.verdict,
      );
      return this.persistDecisionForVerdict(input, request, verdict, evidence);
    }

    const existingAttempt = await this.readArtifact(
      input.sessionId,
      artifactId(requestId, "attempt"),
      ARTIFACT_TYPES.attempt,
    );
    if (existingAttempt !== undefined) {
      await this.persistArtifact({
        runId: input.runId,
        sessionId: input.sessionId,
        stepIndex: input.stepIndex,
        artifactId: artifactId(requestId, "failure"),
        type: ARTIFACT_TYPES.failure,
        payload: {
          requestId,
          reasonCode: "EVALUATION_CALL_INTERRUPTED",
          failedAt: requireString(
            existingAttempt.startedAt,
            "Persisted evaluation attempt startedAt",
          ),
        },
      });
      await this.appendLifecycle(input, "evaluation.failed", "WARN", {
        requestId,
        reasonCode: "EVALUATION_CALL_INTERRUPTED",
      });
      return this.persistFailureDecision(
        input,
        request,
        "EVALUATION_CALL_INTERRUPTED",
        evidence,
      );
    }

    const capacityReason = evaluationCapacityReason(
      input.hookKind,
      budget,
      this.policy,
    );
    if (capacityReason !== undefined) {
      const disposition = input.hookKind === "pre_delivery" ? "review" : "skipped";
      const decision = await this.persistDecision({
        input,
        request,
        budget,
        disposition,
        reasonCode: capacityReason,
      });
      await this.appendLifecycle(
        input,
        disposition === "skipped" ? "evaluation.skipped" : "evaluation.action.selected",
        disposition === "skipped" ? "INFO" : "WARN",
        { requestId, decision: structuredClone(decision) },
      );
      return {
        request,
        decision,
        ...(evidence.sanitizedCandidate !== undefined
          ? { sanitizedCandidate: evidence.sanitizedCandidate }
          : {}),
        ...(evidence.assistantOutputBoundaryDecision !== undefined
          ? { assistantOutputBoundaryDecision: evidence.assistantOutputBoundaryDecision }
          : {}),
      };
    }

    await this.persistArtifact({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      artifactId: artifactId(requestId, "attempt"),
      type: ARTIFACT_TYPES.attempt,
      payload: {
        requestId,
        hookKind: input.hookKind,
        startedAt: now,
      },
    });
    await this.appendLifecycle(input, "evaluation.started", "INFO", {
      requestId,
      evaluator: structuredClone(this.policy.evaluator),
      judge: secretFreeJudgeIdentity(this.policy),
    });

    let verdict: RuntimeEvaluationVerdictV1;
    try {
      const evaluator = this.options.evaluatorRegistry.require(
        this.policy.evaluator,
      );
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new RuntimeEvaluationFailure(
          "EVALUATION_TIMEOUT",
          "Runtime evaluation exceeded its configured timeout.",
        )),
        this.policy.budget.timeoutMs,
      );
      const onAbort = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const evaluatedVerdict = await evaluator.evaluate(request, {
            signal: controller.signal,
            invokeJudge: (judgeRequest) =>
              this.options.invokeJudge(judgeRequest, controller.signal),
          });
        throwIfAborted(controller.signal);
        verdict = parseRuntimeEvaluationVerdictV1(evaluatedVerdict);
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
      }
      throwIfAborted(input.signal);
      assertVerdictIdentity(verdict, request, this.policy);
      assertVerdictBudget(verdict, budget, this.policy);
    } catch (error) {
      if (input.signal?.aborted === true) throw input.signal.reason ?? error;
      const reasonCode = evaluationFailureReason(error);
      await this.persistArtifact({
        runId: input.runId,
        sessionId: input.sessionId,
        stepIndex: input.stepIndex,
        artifactId: artifactId(requestId, "failure"),
        type: ARTIFACT_TYPES.failure,
        payload: { requestId, reasonCode, failedAt: new Date().toISOString() },
      });
      await this.appendLifecycle(input, "evaluation.failed", "WARN", {
        requestId,
        reasonCode,
      });
      return this.persistFailureDecision(input, request, reasonCode, evidence);
    }

    await this.persistArtifact({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      artifactId: artifactId(requestId, "verdict"),
      type: ARTIFACT_TYPES.verdict,
      payload: { verdict: structuredClone(verdict) },
    });
    await this.appendLifecycle(input, "evaluation.completed", "INFO", {
      requestId,
      verdict: structuredClone(verdict),
    });
    return this.persistDecisionForVerdict(input, request, verdict, evidence);
  }

  private async buildSanitizedProjection(
    input: RuntimeEvaluationHookInputV1,
    createdAt: string,
  ): Promise<{
    projection: EvaluationEvidenceProjectionV1;
    sanitizedCandidate?: string | undefined;
    assistantOutputBoundaryDecision?: ExecutionBoundaryDecisionV1 | undefined;
  }> {
    let sanitizedCandidate = input.candidateOutput;
    let assistantOutputBoundaryDecision: ExecutionBoundaryDecisionV1 | undefined;
    if (sanitizedCandidate !== undefined) {
      const evaluated = await this.options.executionBoundaryRuntime.evaluateAndPersist({
        boundary: "assistant_output",
        identity: {
          runId: input.runId,
          sessionId: input.sessionId,
          stepIndex: input.stepIndex,
        },
        source: "runtime",
        trust: "data",
        sourceId: `evaluation-candidate:${input.runId}:${input.stepIndex}`,
        value: { assistantText: sanitizedCandidate },
        persist: (decision) => this.persistBoundaryDecision(input, decision),
      });
      sanitizedCandidate = evaluated.value.assistantText;
      assistantOutputBoundaryDecision = evaluated.decision;
    }
    const projection = buildEvaluationEvidenceProjectionV1({
      ...input,
      profileFingerprint: this.executionProfileFingerprint,
      policyRevision: this.policy.revision,
      ...(sanitizedCandidate !== undefined
        ? { candidateOutput: sanitizedCandidate }
        : {}),
      createdAt,
    });
    const evaluatedProjection = await this.options.executionBoundaryRuntime.evaluateAndPersist({
      boundary: "model_request",
      identity: {
        runId: input.runId,
        sessionId: input.sessionId,
        stepIndex: input.stepIndex,
      },
      source: "runtime",
      trust: "data",
      sourceId: `evaluation-projection:${input.runId}:${input.stepIndex}:${input.hookKind}:${input.sourceId}`,
      value: projection,
      persist: (decision) => this.persistBoundaryDecision(input, decision),
    });
    return {
      projection: parseEvaluationEvidenceProjectionV1(evaluatedProjection.value),
      ...(sanitizedCandidate !== undefined ? { sanitizedCandidate } : {}),
      ...(assistantOutputBoundaryDecision !== undefined
        ? { assistantOutputBoundaryDecision }
        : {}),
    };
  }

  private async persistDecisionForVerdict(
    input: RuntimeEvaluationHookInputV1,
    request: RuntimeEvaluationRequestV1,
    verdict: RuntimeEvaluationVerdictV1,
    evidence: {
      sanitizedCandidate?: string | undefined;
      assistantOutputBoundaryDecision?: ExecutionBoundaryDecisionV1 | undefined;
    },
  ): Promise<RuntimeEvaluationHookResultV1> {
    const budget = await this.loadBudgetState(input);
    const mapped = mapRuntimeEvaluationVerdict({
      hookKind: input.hookKind,
      verdict,
      policy: this.policy,
      finalRevisionsUsed: budget.finalRevisionsUsed,
    });
    const decision = await this.persistDecision({
      input,
      request,
      verdict,
      budget,
      disposition: mapped.disposition,
      reasonCode: mapped.reasonCode,
    });
    await this.appendLifecycle(input, "evaluation.action.selected", mapped.disposition === "continue" ? "INFO" : "WARN", {
      requestId: request.requestId,
      decision: structuredClone(decision),
    });
    return {
      request,
      verdict,
      decision,
      ...(evidence.sanitizedCandidate !== undefined
        ? { sanitizedCandidate: evidence.sanitizedCandidate }
        : {}),
      ...(evidence.assistantOutputBoundaryDecision !== undefined
        ? { assistantOutputBoundaryDecision: evidence.assistantOutputBoundaryDecision }
        : {}),
    };
  }

  private async persistFailureDecision(
    input: RuntimeEvaluationHookInputV1,
    request: RuntimeEvaluationRequestV1,
    reasonCode: string,
    evidence: {
      sanitizedCandidate?: string | undefined;
      assistantOutputBoundaryDecision?: ExecutionBoundaryDecisionV1 | undefined;
    },
  ): Promise<RuntimeEvaluationHookResultV1> {
    const budget = await this.loadBudgetState(input);
    const decision = await this.persistDecision({
      input,
      request,
      budget,
      disposition: input.hookKind === "pre_delivery" ? "review" : "continue",
      reasonCode:
        input.hookKind === "pre_delivery"
          ? reasonCode
          : `ADVISORY_${reasonCode}`,
    });
    await this.appendLifecycle(input, "evaluation.action.selected", input.hookKind === "pre_delivery" ? "WARN" : "INFO", {
      requestId: request.requestId,
      decision: structuredClone(decision),
    });
    return {
      request,
      decision,
      ...(evidence.sanitizedCandidate !== undefined
        ? { sanitizedCandidate: evidence.sanitizedCandidate }
        : {}),
      ...(evidence.assistantOutputBoundaryDecision !== undefined
        ? { assistantOutputBoundaryDecision: evidence.assistantOutputBoundaryDecision }
        : {}),
    };
  }

  private async persistDecision(input: {
    input: RuntimeEvaluationHookInputV1;
    request: RuntimeEvaluationRequestV1;
    verdict?: RuntimeEvaluationVerdictV1 | undefined;
    budget: EvaluationBudgetState;
    disposition: RuntimeEvaluationDecisionV1["disposition"];
    reasonCode: string;
  }): Promise<RuntimeEvaluationDecisionV1> {
    const createdAt = (this.options.now ?? (() => new Date()))().toISOString();
    const decision = parseRuntimeEvaluationDecisionV1({
      version: RUNTIME_EVALUATION_DECISION_VERSION,
      decisionId: `evaluation-decision:${shortDigest({
        requestId: input.request.requestId,
        verdictId: input.verdict?.verdictId,
        disposition: input.disposition,
        reasonCode: input.reasonCode,
      })}`,
      requestId: input.request.requestId,
      ...(input.verdict !== undefined ? { verdictId: input.verdict.verdictId } : {}),
      runId: input.input.runId,
      sessionId: input.input.sessionId,
      profileFingerprint: this.executionProfileFingerprint,
      policyRevision: this.policy.revision,
      thresholds: this.policy.thresholds,
      budget: toBudgetSnapshot(input.budget),
      disposition: input.disposition,
      reasonCode: input.reasonCode,
      createdAt,
    });
    await this.persistArtifact({
      runId: input.input.runId,
      sessionId: input.input.sessionId,
      stepIndex: input.input.stepIndex,
      artifactId: artifactId(input.request.requestId, "decision"),
      type: ARTIFACT_TYPES.decision,
      payload: { decision: structuredClone(decision) },
    });
    return decision;
  }

  private async loadBudgetState(
    input: RuntimeEvaluationHookInputV1,
  ): Promise<EvaluationBudgetState> {
    const [attempts, verdictArtifacts] = await Promise.all([
      this.options.store.listArtifacts({
        sessionId: input.sessionId,
        runId: input.runId,
        type: ARTIFACT_TYPES.attempt,
        limit: 16,
      }),
      this.options.store.listArtifacts({
        sessionId: input.sessionId,
        runId: input.runId,
        type: ARTIFACT_TYPES.verdict,
        limit: 16,
      }),
    ]);
    const attemptKinds = attempts.map((artifact) =>
      requireString(artifact.payload.hookKind, "Evaluation attempt hookKind"),
    );
    let totalTokensUsed = 0;
    let totalCostUsd = 0;
    for (const artifact of verdictArtifacts) {
      const verdict = parseRuntimeEvaluationVerdictV1(artifact.payload.verdict);
      totalTokensUsed += verdict.usage.totalTokens;
      totalCostUsd += verdict.usage.costUsd;
    }
    return {
      evaluationsUsed: attempts.length,
      intermediateEvaluationsUsed: attemptKinds.filter(
        (kind) => kind !== "pre_delivery",
      ).length,
      finalEvaluationsUsed: attemptKinds.filter(
        (kind) => kind === "pre_delivery",
      ).length,
      totalTokensUsed,
      totalCostUsd,
      finalRevisionsUsed: Math.max(0, input.finalRevisionsUsed ?? 0),
    };
  }

  private async persistBoundaryDecision(
    input: RuntimeEvaluationHookInputV1,
    decision: ExecutionBoundaryDecisionV1,
  ): Promise<void> {
    await this.options.appendLifecycleEvent({
      runId: input.runId,
      sessionId: input.sessionId,
      type: "execution_boundary.decision",
      level:
        decision.outcome === "DENY" || decision.outcome === "QUARANTINE"
          ? "WARN"
          : "INFO",
      metadata: { ...decision },
      stepIndex: input.stepIndex,
    });
  }

  private async appendLifecycle(
    input: RuntimeEvaluationHookInputV1,
    type: (typeof RUNTIME_EVALUATION_LIFECYCLE_EVENT_TYPES)[number],
    level: "INFO" | "WARN" | "ERROR",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.options.appendLifecycleEvent({
      runId: input.runId,
      sessionId: input.sessionId,
      type,
      level,
      metadata,
      stepIndex: input.stepIndex,
    });
  }

  private async persistArtifact(input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    artifactId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const existing = await this.options.store.getArtifact({
      artifactId: input.artifactId,
      sessionId: input.sessionId,
    });
    if (existing !== null) {
      if (
        existing.type !== input.type ||
        digestCanonicalValue(existing.payload) !== digestCanonicalValue(input.payload)
      ) {
        throw new Error(
          `Runtime evaluation artifact '${input.artifactId}' conflicts with persisted evidence.`,
        );
      }
      return;
    }
    await this.options.store.appendArtifacts(
      input.runId,
      input.sessionId,
      input.stepIndex,
      [{ id: input.artifactId, type: input.type, payload: input.payload }],
    );
  }

  private async readArtifact(
    sessionId: string,
    artifactIdValue: string,
    expectedType: string,
  ): Promise<Record<string, unknown> | undefined> {
    const artifact = await this.options.store.getArtifact({
      artifactId: artifactIdValue,
      sessionId,
    });
    if (artifact === null) return;
    if (artifact.type !== expectedType) {
      throw new Error(
        `Runtime evaluation artifact '${artifactIdValue}' has the wrong type.`,
      );
    }
    return artifact.payload;
  }

  private async withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => current);
    this.runLocks.set(runId, queued);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.runLocks.get(runId) === queued) this.runLocks.delete(runId);
    }
  }
}

export function buildEvaluationEvidenceProjectionV1(input: {
  runId: string;
  sessionId: string;
  threadId?: string | undefined;
  stepIndex: number;
  profileFingerprint: string;
  policyRevision: string;
  hookKind: RuntimeEvaluationHookKindV1;
  sourceId: string;
  objective: string;
  candidateOutput?: string | undefined;
  evidence?: RuntimeEvaluationEvidenceInputV1[] | undefined;
  createdAt: string;
}): EvaluationEvidenceProjectionV1 {
  const truncations: EvaluationEvidenceProjectionV1["truncations"] = [];
  const objective = boundedText(input.objective, 1_200, "objective", truncations);
  const candidateOutput = input.candidateOutput === undefined
    ? undefined
    : boundedText(input.candidateOutput, 6_500, "candidateOutput", truncations);
  const boundedEvidence = input.evidence ?? [];
  if (boundedEvidence.length > 8) {
    truncations.push({
      field: "evidence",
      originalDigest: digestCanonicalValue(boundedEvidence),
      retainedChars: 3_200,
    });
  }
  const evidence = boundedEvidence.slice(0, 8).map((item, index) => {
    const summary = boundedText(
      stableStringify(item.value),
      400,
      `evidence.${index}`,
      truncations,
    );
    return {
      evidenceId: item.evidenceId,
      kind: item.kind,
      summary,
      digest: digestCanonicalValue(item.value),
    };
  });
  return parseEvaluationEvidenceProjectionV1({
    version: EVALUATION_EVIDENCE_PROJECTION_VERSION,
    identity: {
      runId: input.runId,
      sessionId: input.sessionId,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      stepIndex: input.stepIndex,
      profileFingerprint: input.profileFingerprint,
      policyRevision: input.policyRevision,
    },
    hook: { kind: input.hookKind, sourceId: input.sourceId },
    objective,
    ...(candidateOutput !== undefined ? { candidateOutput } : {}),
    evidence,
    truncations,
    createdAt: input.createdAt,
  });
}

export function mapRuntimeEvaluationVerdict(input: {
  hookKind: RuntimeEvaluationHookKindV1;
  verdict: RuntimeEvaluationVerdictV1;
  policy: RuntimeEvaluationPolicyV1;
  finalRevisionsUsed: number;
}): Pick<RuntimeEvaluationDecisionV1, "disposition" | "reasonCode"> {
  if (input.hookKind !== "pre_delivery") {
    return { disposition: "continue", reasonCode: "ADVISORY_RECORDED" };
  }
  const integrity = input.verdict.assertions.find(
    (assertion) => assertion.assertionId === "evaluation_integrity",
  );
  if (
    integrity?.passed === false &&
    input.verdict.confidence >=
      input.policy.thresholds.integrityQuarantineConfidence
  ) {
    return { disposition: "quarantine", reasonCode: "EVALUATION_QUARANTINED" };
  }
  if (
    input.verdict.assertions
      .filter((assertion) => assertion.required)
      .every((assertion) => assertion.passed) &&
    input.verdict.score >= input.policy.thresholds.passScore &&
    input.verdict.confidence >= input.policy.thresholds.minimumConfidence
  ) {
    return { disposition: "continue", reasonCode: "EVALUATION_PASSED" };
  }
  if (input.verdict.confidence < input.policy.thresholds.minimumConfidence) {
    return { disposition: "review", reasonCode: "EVALUATION_LOW_CONFIDENCE" };
  }
  if (
    input.verdict.repairable &&
    input.finalRevisionsUsed < input.policy.budget.maxFinalRevisions
  ) {
    return { disposition: "revise", reasonCode: "EVALUATION_REJECTED" };
  }
  return {
    disposition: "review",
    reasonCode:
      input.finalRevisionsUsed >= input.policy.budget.maxFinalRevisions
        ? "EVALUATION_REJECTED_AFTER_REVISION"
        : "EVALUATION_REJECTED",
  };
}

function evaluationCapacityReason(
  hookKind: RuntimeEvaluationHookKindV1,
  budget: EvaluationBudgetState,
  policy: RuntimeEvaluationPolicyV1,
): string | undefined {
  if (
    budget.totalTokensUsed >= policy.budget.maxTotalTokens ||
    budget.totalCostUsd >= policy.budget.maxTotalCostUsd
  ) {
    return "EVALUATION_BUDGET_EXHAUSTED";
  }
  if (hookKind !== "pre_delivery") {
    if (
      budget.intermediateEvaluationsUsed >=
      policy.budget.maxIntermediateEvaluations
    ) {
      return "FINAL_CAPACITY_RESERVED";
    }
  } else if (
    budget.finalEvaluationsUsed >= policy.budget.reservedFinalEvaluations
  ) {
    return "EVALUATION_FINAL_BUDGET_EXHAUSTED";
  }
  if (budget.evaluationsUsed >= policy.budget.maxEvaluationsPerRun) {
    return "EVALUATION_BUDGET_EXHAUSTED";
  }
  return;
}

function evaluationFailureReason(error: unknown): string {
  if (error instanceof RuntimeEvaluationFailure) return error.code;
  return "EVALUATOR_OUTPUT_MALFORMED";
}

function assertVerdictBudget(
  verdict: RuntimeEvaluationVerdictV1,
  budget: EvaluationBudgetState,
  policy: RuntimeEvaluationPolicyV1,
): void {
  if (
    verdict.usage.inputTokens > policy.budget.maxInputTokensPerEvaluation ||
    verdict.usage.outputTokens > policy.budget.maxOutputTokensPerEvaluation ||
    verdict.usage.totalTokens >
      policy.budget.maxInputTokensPerEvaluation +
        policy.budget.maxOutputTokensPerEvaluation ||
    budget.totalTokensUsed + verdict.usage.totalTokens >
      policy.budget.maxTotalTokens ||
    budget.totalCostUsd + verdict.usage.costUsd >
      policy.budget.maxTotalCostUsd
  ) {
    throw new RuntimeEvaluationFailure(
      "EVALUATION_BUDGET_EXCEEDED",
      "Runtime evaluation exceeded its configured token or spend budget.",
    );
  }
}

function assertVerdictIdentity(
  verdict: RuntimeEvaluationVerdictV1,
  request: RuntimeEvaluationRequestV1,
  policy: RuntimeEvaluationPolicyV1,
): void {
  if (
    verdict.requestId !== request.requestId ||
    verdict.evaluator.evaluatorId !== policy.evaluator.evaluatorId ||
    verdict.evaluator.evaluatorVersion !== policy.evaluator.evaluatorVersion ||
    verdict.judge.provider !== policy.judge.provider ||
    verdict.judge.requestedModel !== policy.judge.model
  ) {
    throw new Error("Runtime evaluation verdict identity is stale or mismatched.");
  }
}

function toBudgetSnapshot(
  budget: EvaluationBudgetState,
): RuntimeEvaluationRequestV1["budget"] {
  return {
    evaluationsUsed: budget.evaluationsUsed,
    intermediateEvaluationsUsed: budget.intermediateEvaluationsUsed,
    totalTokensUsed: budget.totalTokensUsed,
    totalCostUsd: budget.totalCostUsd,
    finalRevisionsUsed: budget.finalRevisionsUsed,
  };
}

function secretFreeJudgeIdentity(policy: RuntimeEvaluationPolicyV1) {
  return {
    provider: policy.judge.provider,
    model: policy.judge.model,
    modelRegistrationRevision: policy.judge.modelRegistrationRevision,
    ...(policy.judge.credentialReference !== undefined
      ? { credentialReference: structuredClone(policy.judge.credentialReference) }
      : {}),
  };
}

function evaluationRequestId(input: Record<string, unknown>): string {
  return `evaluation-request:${shortDigest(input)}`;
}

function artifactId(requestId: string, kind: string): string {
  return `${requestId}:${kind}`;
}

function shortDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function boundedText(
  value: string,
  maxChars: number,
  field: string,
  truncations: EvaluationEvidenceProjectionV1["truncations"],
): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized || "(empty)";
  truncations.push({
    field,
    originalDigest: digestCanonicalValue(normalized),
    retainedChars: maxChars,
  });
  return normalized.slice(0, maxChars);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortCanonical(entry)]),
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("Runtime evaluation cancelled.");
  }
}
