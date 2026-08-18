import { createHash } from "node:crypto";

import type { MissionControlProjectRepository } from "../kestrel/contracts/store.js";
import {
  MissionControlAttemptVersionConflictError,
} from "./executionAuthority.js";
import {
  MissionControlItemVersionConflictError,
  MissionControlProjectService,
  MissionControlTransitionError,
  type MissionControlExecutionAttempt,
  type MissionControlHistoryEntry,
  type MissionControlOutboxIntent,
  type MissionControlProjectDocument,
  type MissionControlProjectMutationResult,
  type MissionControlProjectStateRecord,
  type MissionControlWorkItem,
  parseMissionControlProjectDocument,
  requireMissionControlActionId,
  requireMissionControlExpectedRevision,
  requireMissionControlProjectId,
} from "./projectAuthority.js";
import {
  parseMissionControlReviewCandidate,
  parseMissionControlReviewEvidenceReferences,
  type MissionControlAcceptanceDecision,
  type MissionControlChangeEvidenceReference,
  type MissionControlConditionalEvidenceKind,
  type MissionControlConditionalEvidenceReference,
  type MissionControlFrozenEvidenceReference,
  type MissionControlReviewBundle,
  type MissionControlReviewCandidate,
  type MissionControlReviewDecision,
  type MissionControlReviewEvidenceReferences,
  type MissionControlValidationEvidenceReference,
} from "./reviewContracts.js";

interface ReviewActionBase {
  projectId: string;
  actionId: string;
  actionTs: string;
  expectedRevision: number;
  itemId: string;
  expectedItemVersion: number;
  attemptId: string;
  expectedAttemptVersion: number;
}

export type MissionControlReviewAction =
  | (ReviewActionBase & {
      type: "review.admit";
      candidate: MissionControlReviewCandidate;
      evidence: MissionControlReviewEvidenceReferences;
    })
  | (ReviewActionBase & {
      type: "review.accept";
      candidateFingerprint: string;
      bundleId: string;
      operatorId: string;
    })
  | (ReviewActionBase & {
      type: "review.request_changes";
      candidateFingerprint: string;
      bundleId: string;
      operatorId: string;
      reason?: string | undefined;
    });

export interface MissionControlResolvedChangeEvidence {
  referenceId: string;
  workspaceRoot: string;
  candidateFingerprint: string;
  outcome: "changes" | "no_change";
  conflicted: boolean;
}

export interface MissionControlResolvedValidationEvidence {
  referenceId: string;
  actionId: string;
  candidateFingerprint: string;
  outcome: "passed" | "failed" | "stale" | "waived";
  authorizationId?: string | undefined;
}

export interface MissionControlResolvedConditionalEvidence {
  kind: MissionControlConditionalEvidenceKind;
  referenceId: string;
  candidateFingerprint: string;
  status: "satisfied" | "failed" | "stale";
  sessionId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
}

export interface MissionControlResolvedLinkedRun {
  sessionId: string;
  threadId: string;
  runId: string;
  status: "completed" | "failed" | "cancelled" | "running" | "waiting";
}

export interface MissionControlResolvedReviewEvidence {
  change: MissionControlResolvedChangeEvidence;
  validationResults: MissionControlResolvedValidationEvidence[];
  conditional: MissionControlResolvedConditionalEvidence[];
  linkedRuns: MissionControlResolvedLinkedRun[];
}

export interface MissionControlReviewEvidenceResolver {
  resolve(input: {
    projectId: string;
    itemId: string;
    attemptId: string;
    sessionId: string;
    threadId: string;
    runId: string;
    candidate: MissionControlReviewCandidate;
    references: MissionControlReviewEvidenceReferences;
  }): Promise<MissionControlResolvedReviewEvidence>;
  currentCandidate(input: {
    projectId: string;
    itemId: string;
    attemptId: string;
    sessionId: string;
    threadId: string;
    runId: string;
    workspaceRoot: string;
  }): Promise<{ candidateFingerprint: string }>;
}

export type MissionControlReviewGateReason =
  | "completion_contract_missing"
  | "implementation_incomplete"
  | "attempt_identity_mismatch"
  | "candidate_mismatch"
  | "change_missing"
  | "change_conflicted"
  | "change_outcome_mismatch"
  | "validation_missing"
  | "validation_failed"
  | "validation_stale"
  | "validation_mixed_candidate"
  | "validation_waiver_unauthorized"
  | "conditional_evidence_missing"
  | "conditional_evidence_failed"
  | "conditional_evidence_stale"
  | "conditional_evidence_mixed_candidate"
  | "linked_work_unsettled"
  | "bundle_mismatch";

export class MissionControlReviewGateError extends Error {
  readonly code = "MISSION_CONTROL_REVIEW_EVIDENCE_REJECTED";

  constructor(
    readonly reason: MissionControlReviewGateReason,
    message: string,
  ) {
    super(message);
    this.name = "MissionControlReviewGateError";
  }
}

export class MissionControlReviewService {
  private readonly store: Pick<
    MissionControlProjectRepository,
    "getMissionControlProjectState" | "updateMissionControlProjectState"
  >;
  private readonly evidence: MissionControlReviewEvidenceResolver;
  readonly projects: MissionControlProjectService;

  constructor(
    store: Pick<
      MissionControlProjectRepository,
      "getMissionControlProjectState" | "updateMissionControlProjectState"
    >,
    evidence: MissionControlReviewEvidenceResolver,
    private readonly onProjectChanged?: (
      project: MissionControlProjectStateRecord,
    ) => void,
  ) {
    this.store = store;
    this.evidence = evidence;
    this.projects = new MissionControlProjectService(store, onProjectChanged);
  }

  async execute(
    actionValue: unknown,
  ): Promise<MissionControlProjectMutationResult> {
    const action = parseMissionControlReviewAction(actionValue);
    const existing = await this.projects.getProject(action.projectId);
    if (
      existing.document.history.some(
        (entry) => entry.actionId === action.actionId,
      )
    ) {
      return this.persist(action);
    }
    if (action.type === "review.admit") {
      return this.admit(action);
    }
    if (action.type === "review.accept") {
      await this.assertCurrentCandidate(action);
    }
    return this.persist(action);
  }

  private async persist(
    action: MissionControlReviewAction,
  ): Promise<MissionControlProjectMutationResult> {
    const result = await this.store.updateMissionControlProjectState({
      projectId: action.projectId,
      actionId: action.actionId,
      requestFingerprint: fingerprint(action),
      expectedRevision: action.expectedRevision,
      apply: (current) => reduceMissionControlReviewAction(current, action),
    });
    if (result.duplicate === false) this.publish(result.project);
    return result;
  }

  private async admit(
    action: Extract<MissionControlReviewAction, { type: "review.admit" }>,
  ): Promise<MissionControlProjectMutationResult> {
    const project = await this.projects.getProject(action.projectId);
    const item = requireItem(project.document, action);
    const attempt = requireAttempt(item, action);
    if (item.phase !== "active") {
      throw gate(
        "implementation_incomplete",
        "Mission Control Review can admit evidence only from Active.",
      );
    }
    const run = requireCompletedCurrentRun(item, attempt);
    if (item.completionContract === undefined) {
      throw gate(
        "completion_contract_missing",
        "Mission Control Review requires an explicit completion contract.",
      );
    }
    const resolved = await this.evidence.resolve({
      projectId: action.projectId,
      itemId: item.id,
      attemptId: attempt.id,
      sessionId: run.sessionId,
      threadId: run.threadId,
      runId: run.runId,
      candidate: action.candidate,
      references: action.evidence,
    });
    const bundle = buildReviewBundle({
      action,
      item,
      attempt,
      run,
      resolved,
    });
    const result = await this.store.updateMissionControlProjectState({
      projectId: action.projectId,
      actionId: action.actionId,
      requestFingerprint: fingerprint(action),
      expectedRevision: action.expectedRevision,
      apply: (current) =>
        reduceMissionControlReviewAction(current, action, bundle),
    });
    if (result.duplicate === false) this.publish(result.project);
    return result;
  }

  private publish(project: MissionControlProjectStateRecord): void {
    try {
      this.onProjectChanged?.(project);
    } catch {
      // Observers cannot turn a committed authoritative mutation into failure.
    }
  }

  private async assertCurrentCandidate(
    action: Extract<MissionControlReviewAction, { type: "review.accept" }>,
  ): Promise<void> {
    const project = await this.projects.getProject(action.projectId);
    const item = requireItem(project.document, action);
    const attempt = requireAttempt(item, action);
    const bundle = requireCurrentBundle(item, action.bundleId);
    const run = requireCompletedCurrentRun(item, attempt);
    const current = await this.evidence.currentCandidate({
      projectId: action.projectId,
      itemId: item.id,
      attemptId: attempt.id,
      sessionId: run.sessionId,
      threadId: run.threadId,
      runId: run.runId,
      workspaceRoot: bundle.candidate.workspaceRoot,
    });
    if (
      current.candidateFingerprint !== bundle.candidate.candidateFingerprint ||
      action.candidateFingerprint !== bundle.candidate.candidateFingerprint
    ) {
      throw gate(
        "candidate_mismatch",
        "The reviewed candidate changed before acceptance.",
      );
    }
  }
}

export function parseMissionControlReviewAction(
  value: unknown,
): MissionControlReviewAction {
  const record = object(value, "Mission Control review action");
  const type = text(record.type, "type", 128);
  const base = {
    projectId: requireMissionControlProjectId(record.projectId),
    actionId: requireMissionControlActionId(record.actionId),
    actionTs: timestamp(record.actionTs, "actionTs"),
    expectedRevision: requireMissionControlExpectedRevision(
      record.expectedRevision,
    ),
    itemId: text(record.itemId, "itemId", 256),
    expectedItemVersion: positiveInteger(
      record.expectedItemVersion,
      "expectedItemVersion",
    ),
    attemptId: text(record.attemptId, "attemptId", 256),
    expectedAttemptVersion: positiveInteger(
      record.expectedAttemptVersion,
      "expectedAttemptVersion",
    ),
  };
  switch (type) {
    case "review.admit":
      exactKeys(record, [
        ...BASE_KEYS,
        "candidate",
        "evidence",
      ]);
      return {
        ...base,
        type,
        candidate: parseMissionControlReviewCandidate(record.candidate),
        evidence: parseMissionControlReviewEvidenceReferences(record.evidence),
      };
    case "review.accept":
      exactKeys(record, [
        ...BASE_KEYS,
        "candidateFingerprint",
        "bundleId",
        "operatorId",
      ]);
      return {
        ...base,
        type,
        candidateFingerprint: candidateFingerprint(
          record.candidateFingerprint,
          "candidateFingerprint",
        ),
        bundleId: bundleId(record.bundleId),
        operatorId: text(record.operatorId, "operatorId", 256),
      };
    case "review.request_changes":
      exactKeys(record, [
        ...BASE_KEYS,
        "candidateFingerprint",
        "bundleId",
        "operatorId",
        "reason",
      ]);
      return {
        ...base,
        type,
        candidateFingerprint: candidateFingerprint(
          record.candidateFingerprint,
          "candidateFingerprint",
        ),
        bundleId: bundleId(record.bundleId),
        operatorId: text(record.operatorId, "operatorId", 256),
        ...(record.reason === undefined
          ? {}
          : { reason: text(record.reason, "reason", 32_000) }),
      };
    default:
      throw new Error(`Unsupported Mission Control review action: ${type}.`);
  }
}

export function reduceMissionControlReviewAction(
  currentValue: MissionControlProjectDocument,
  action: MissionControlReviewAction,
  admittedBundle?: MissionControlReviewBundle | undefined,
): {
  document: MissionControlProjectDocument;
  effects: MissionControlOutboxIntent[];
} {
  const current = parseMissionControlProjectDocument(
    currentValue,
    action.projectId,
  );
  const item = requireItem(current, action);
  const attempt = requireAttempt(item, action);
  const revision = action.expectedRevision + 1;
  switch (action.type) {
    case "review.admit": {
      if (item.phase !== "active") {
        throw new MissionControlTransitionError(
          "Mission Control Review can admit evidence only from Active.",
        );
      }
      requireCompletedCurrentRun(item, attempt);
      if (admittedBundle === undefined) {
        throw new MissionControlTransitionError(
          "Mission Control Review admission requires evaluated evidence.",
        );
      }
      if (
        admittedBundle.projectId !== action.projectId ||
        admittedBundle.itemId !== item.id ||
        admittedBundle.attemptId !== attempt.id ||
        admittedBundle.candidate.candidateFingerprint !==
          action.candidate.candidateFingerprint
      ) {
        throw gate(
          "bundle_mismatch",
          "The frozen Review bundle does not match the current work item.",
        );
      }
      return changed(current, action, revision, {
        ...item,
        phase: "review",
        reviewBundles: [...(item.reviewBundles ?? []), admittedBundle],
        currentReviewBundleId: admittedBundle.id,
        version: item.version + 1,
        updatedAt: action.actionTs,
      });
    }
    case "review.accept": {
      if (item.phase !== "review") {
        throw new MissionControlTransitionError(
          "Mission Control acceptance is available only from Review.",
        );
      }
      const bundle = requireCurrentBundle(item, action.bundleId);
      if (
        action.candidateFingerprint !== bundle.candidate.candidateFingerprint ||
        bundle.attemptId !== attempt.id
      ) {
        throw gate(
          "bundle_mismatch",
          "Mission Control acceptance must name the exact current candidate and bundle.",
        );
      }
      const acceptance: MissionControlAcceptanceDecision = {
        decision: "accepted",
        projectId: action.projectId,
        itemId: item.id,
        attemptId: attempt.id,
        candidateFingerprint: bundle.candidate.candidateFingerprint,
        bundleId: bundle.id,
        operatorId: action.operatorId,
        actionId: action.actionId,
        decidedAt: action.actionTs,
      };
      return changed(current, action, revision, {
        ...item,
        phase: "done",
        reviewDecisions: [...(item.reviewDecisions ?? []), acceptance],
        version: item.version + 1,
        updatedAt: action.actionTs,
      });
    }
    case "review.request_changes": {
      if (item.phase !== "review") {
        throw new MissionControlTransitionError(
          "Changes can be requested only from Mission Control Review.",
        );
      }
      const bundle = requireCurrentBundle(item, action.bundleId);
      if (
        action.candidateFingerprint !== bundle.candidate.candidateFingerprint ||
        bundle.attemptId !== attempt.id
      ) {
        throw gate(
          "bundle_mismatch",
          "Request changes must name the exact current candidate and bundle.",
        );
      }
      const decision: MissionControlReviewDecision = {
        decision: "changes_requested",
        projectId: action.projectId,
        itemId: item.id,
        attemptId: attempt.id,
        candidateFingerprint: bundle.candidate.candidateFingerprint,
        bundleId: bundle.id,
        operatorId: action.operatorId,
        actionId: action.actionId,
        decidedAt: action.actionTs,
        ...(action.reason === undefined ? {} : { reason: action.reason }),
      };
      return changed(current, action, revision, {
        ...item,
        phase: "ready",
        currentReviewBundleId: undefined,
        reviewDecisions: [...(item.reviewDecisions ?? []), decision],
        version: item.version + 1,
        updatedAt: action.actionTs,
      });
    }
  }
}

function buildReviewBundle(input: {
  action: Extract<MissionControlReviewAction, { type: "review.admit" }>;
  item: MissionControlWorkItem;
  attempt: MissionControlExecutionAttempt;
  run: MissionControlExecutionAttempt["runs"][number];
  resolved: MissionControlResolvedReviewEvidence;
}): MissionControlReviewBundle {
  const contract = input.item.completionContract;
  if (contract === undefined) {
    throw gate(
      "completion_contract_missing",
      "Mission Control Review requires an explicit completion contract.",
    );
  }
  const { action, resolved } = input;
  assertExactReferenceSet(
    [resolved.change.referenceId],
    [action.evidence.change],
    "change_missing",
    "The authoritative change reference is missing.",
  );
  if (
    resolved.change.candidateFingerprint !== action.candidate.candidateFingerprint
  ) {
    throw gate(
      "candidate_mismatch",
      "Change evidence belongs to a different candidate.",
    );
  }
  if (resolved.change.workspaceRoot !== action.candidate.workspaceRoot) {
    throw gate(
      "attempt_identity_mismatch",
      "Change evidence belongs to a different workspace.",
    );
  }
  if (resolved.change.conflicted) {
    throw gate(
      "change_conflicted",
      "Conflicted change evidence cannot enter Review.",
    );
  }
  if (resolved.change.outcome !== contract.changeOutcome) {
    throw gate(
      "change_outcome_mismatch",
      "The authoritative change result does not match the completion contract.",
    );
  }
  const validationEvidence = evaluateValidation(input);
  const conditionalEvidence = evaluateConditional(input);
  for (const linkedRun of resolved.linkedRuns) {
    if (linkedRun.status === "running" || linkedRun.status === "waiting") {
      throw gate(
        "linked_work_unsettled",
        `Linked run ${linkedRun.runId} is still ${linkedRun.status}.`,
      );
    }
  }
  const change: MissionControlChangeEvidenceReference = {
    kind: "change",
    owner: "workspace_changes",
    referenceId: resolved.change.referenceId,
    workspaceRoot: resolved.change.workspaceRoot,
    candidateFingerprint: resolved.change.candidateFingerprint,
    outcome: resolved.change.outcome,
  };
  const evidence = [
    {
      kind: "execution" as const,
      owner: "runtime" as const,
      referenceId: input.run.commandId,
      sessionId: input.run.sessionId,
      threadId: input.run.threadId,
      runId: input.run.runId,
      outcome: "completed" as const,
    },
    change,
    ...validationEvidence,
    ...conditionalEvidence,
  ].sort(compareEvidence);
  const bundleWithoutId = {
    projectId: action.projectId,
    itemId: input.item.id,
    attemptId: input.attempt.id,
    candidate: action.candidate,
    contract,
    evidence,
    actionId: action.actionId,
    frozenAt: action.actionTs,
  };
  return {
    id: `sha256:${createHash("sha256")
      .update(stableJson(bundleWithoutId))
      .digest("hex")}`,
    ...bundleWithoutId,
  };
}

function evaluateValidation(input: {
  action: Extract<MissionControlReviewAction, { type: "review.admit" }>;
  item: MissionControlWorkItem;
  resolved: MissionControlResolvedReviewEvidence;
}): MissionControlValidationEvidenceReference[] {
  const contract = input.item.completionContract!.validation;
  const { action, resolved } = input;
  assertExactReferenceSet(
    resolved.validationResults.map((entry) => entry.referenceId),
    action.evidence.validationResults,
    "validation_missing",
    "One or more validation references could not be resolved.",
  );
  if (contract.mode === "not_applicable") {
    if (resolved.validationResults.length !== 0) {
      throw gate(
        "validation_failed",
        "A not-applicable validation contract cannot mix result records.",
      );
    }
    return [{
      kind: "validation",
      owner: "workspace_validation",
      referenceId: `contract:${action.actionId}:not_applicable`,
      candidateFingerprint: action.candidate.candidateFingerprint,
      outcome: "not_applicable",
    }];
  }
  if (contract.mode === "waived") {
    if (resolved.validationResults.length !== 0) {
      throw gate(
        "validation_failed",
        "A validation waiver cannot mix result records.",
      );
    }
    if (contract.authorizationId.trim().length === 0) {
      throw gate(
        "validation_waiver_unauthorized",
        "Validation waiver authorization is missing.",
      );
    }
    return [{
      kind: "validation",
      owner: "workspace_validation",
      referenceId: `authorization:${contract.authorizationId}`,
      candidateFingerprint: action.candidate.candidateFingerprint,
      outcome: "waived",
      authorizationId: contract.authorizationId,
    }];
  }
  const byAction = new Map(
    resolved.validationResults.map((result) => [result.actionId, result]),
  );
  for (const actionId of contract.actionIds) {
    const result = byAction.get(actionId);
    if (result === undefined) {
      throw gate(
        "validation_missing",
        `Required validation ${actionId} has no result.`,
      );
    }
    if (
      result.candidateFingerprint !== action.candidate.candidateFingerprint
    ) {
      throw gate(
        "validation_mixed_candidate",
        `Validation ${actionId} belongs to a different candidate.`,
      );
    }
    if (result.outcome === "stale") {
      throw gate(
        "validation_stale",
        `Validation ${actionId} is stale.`,
      );
    }
    if (result.outcome !== "passed") {
      throw gate(
        result.outcome === "waived"
          ? "validation_waiver_unauthorized"
          : "validation_failed",
        `Validation ${actionId} did not pass.`,
      );
    }
  }
  return resolved.validationResults.map((result) => {
    if (
      result.candidateFingerprint !== action.candidate.candidateFingerprint
    ) {
      throw gate(
        "validation_mixed_candidate",
        `Validation ${result.actionId} belongs to a different candidate.`,
      );
    }
    if (result.outcome !== "passed") {
      throw gate(
        result.outcome === "stale"
          ? "validation_stale"
          : "validation_failed",
        `Validation ${result.actionId} did not pass.`,
      );
    }
    return {
      kind: "validation",
      owner: "workspace_validation",
      referenceId: result.referenceId,
      candidateFingerprint: result.candidateFingerprint,
      actionId: result.actionId,
      outcome: "passed",
    };
  });
}

function evaluateConditional(input: {
  action: Extract<MissionControlReviewAction, { type: "review.admit" }>;
  item: MissionControlWorkItem;
  resolved: MissionControlResolvedReviewEvidence;
}): MissionControlConditionalEvidenceReference[] {
  const { action, resolved } = input;
  const requested = [
    ...action.evidence.automatedReviews.map((referenceId) => ({
      kind: "automated_review" as const,
      referenceId,
    })),
    ...action.evidence.deliveries.map((referenceId) => ({
      kind: "delivery" as const,
      referenceId,
    })),
    ...action.evidence.artifacts.map((referenceId) => ({
      kind: "artifact" as const,
      referenceId,
    })),
    ...action.evidence.checkpoints.map((referenceId) => ({
      kind: "checkpoint" as const,
      referenceId,
    })),
    ...action.evidence.previews.map((referenceId) => ({
      kind: "preview" as const,
      referenceId,
    })),
  ];
  assertExactReferenceSet(
    resolved.conditional.map((entry) => `${entry.kind}:${entry.referenceId}`),
    requested.map((entry) => `${entry.kind}:${entry.referenceId}`),
    "conditional_evidence_missing",
    "One or more conditional evidence references could not be resolved.",
  );
  for (const kind of input.item.completionContract!.requiredEvidence) {
    if (resolved.conditional.some((entry) => entry.kind === kind) === false) {
      throw gate(
        "conditional_evidence_missing",
        `Required ${kind} evidence is missing.`,
      );
    }
  }
  return resolved.conditional.map((entry) => {
    if (
      entry.candidateFingerprint !== action.candidate.candidateFingerprint
    ) {
      throw gate(
        "conditional_evidence_mixed_candidate",
        `${entry.kind} evidence belongs to a different candidate.`,
      );
    }
    if (entry.status === "stale") {
      throw gate(
        "conditional_evidence_stale",
        `${entry.kind} evidence is stale.`,
      );
    }
    if (entry.status !== "satisfied") {
      throw gate(
        "conditional_evidence_failed",
        `${entry.kind} evidence is not satisfied.`,
      );
    }
    return {
      kind: entry.kind,
      owner: conditionalOwner(entry.kind),
      referenceId: entry.referenceId,
      candidateFingerprint: entry.candidateFingerprint,
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
      ...(entry.runId === undefined ? {} : { runId: entry.runId }),
      outcome: "satisfied",
    };
  });
}

function requireItem(
  current: MissionControlProjectDocument,
  action: ReviewActionBase,
): MissionControlWorkItem {
  const item = current.items[action.itemId];
  if (item === undefined) {
    throw new MissionControlTransitionError(
      `Mission Control item not found: ${action.itemId}.`,
    );
  }
  if (item.version !== action.expectedItemVersion) {
    throw new MissionControlItemVersionConflictError(
      item.id,
      action.expectedItemVersion,
      item.version,
    );
  }
  return item;
}

function requireAttempt(
  item: MissionControlWorkItem,
  action: ReviewActionBase,
): MissionControlExecutionAttempt {
  const attempt = item.attempts.find((entry) => entry.id === action.attemptId);
  if (attempt === undefined) {
    throw new MissionControlTransitionError(
      `Mission Control attempt not found: ${action.attemptId}.`,
    );
  }
  if (attempt.version !== action.expectedAttemptVersion) {
    throw new MissionControlAttemptVersionConflictError(
      attempt.id,
      action.expectedAttemptVersion,
      attempt.version,
    );
  }
  return attempt;
}

function requireCompletedCurrentRun(
  item: MissionControlWorkItem,
  attempt: MissionControlExecutionAttempt,
): MissionControlExecutionAttempt["runs"][number] {
  if (
    item.currentAttemptId !== attempt.id ||
    attempt.status !== "completed" ||
    attempt.currentRunId === undefined
  ) {
    throw gate(
      "implementation_incomplete",
      "Mission Control Review requires the completed current implementation attempt.",
    );
  }
  const run = attempt.runs.find((entry) => entry.runId === attempt.currentRunId);
  if (run === undefined) {
    throw gate(
      "attempt_identity_mismatch",
      "The completed attempt has no exact authoritative run.",
    );
  }
  return run;
}

function requireCurrentBundle(
  item: MissionControlWorkItem,
  expectedBundleId: string,
): MissionControlReviewBundle {
  if (item.currentReviewBundleId !== expectedBundleId) {
    throw gate(
      "bundle_mismatch",
      "The requested Review bundle is not the current frozen bundle.",
    );
  }
  const bundle = (item.reviewBundles ?? []).find(
    (entry) => entry.id === expectedBundleId,
  );
  if (bundle === undefined) {
    throw gate(
      "bundle_mismatch",
      "The requested Review bundle is not persisted.",
    );
  }
  return bundle;
}

function changed(
  current: MissionControlProjectDocument,
  action: MissionControlReviewAction,
  revision: number,
  item: MissionControlWorkItem,
): {
  document: MissionControlProjectDocument;
  effects: MissionControlOutboxIntent[];
} {
  return {
    document: {
      ...current,
      items: {
        ...current.items,
        [item.id]: item,
      },
      history: [
        ...current.history,
        {
          actionId: action.actionId,
          actionType: action.type,
          revision,
          timestamp: action.actionTs,
          itemId: action.itemId,
          attemptId: action.attemptId,
          disposition: "applied",
        } satisfies MissionControlHistoryEntry,
      ],
    },
    effects: [],
  };
}

function assertExactReferenceSet(
  resolved: string[],
  requested: string[],
  reason: MissionControlReviewGateReason,
  message: string,
): void {
  if (
    resolved.length !== requested.length ||
    [...resolved].sort().some((value, index) => value !== [...requested].sort()[index])
  ) {
    throw gate(reason, message);
  }
}

function conditionalOwner(
  kind: MissionControlConditionalEvidenceKind,
): MissionControlConditionalEvidenceReference["owner"] {
  switch (kind) {
    case "automated_review":
      return "workspace_review";
    case "delivery":
      return "workspace_delivery";
    case "artifact":
      return "runtime_artifacts";
    case "checkpoint":
      return "workspace_checkpoints";
    case "preview":
      return "preview";
  }
}

function compareEvidence(
  left: MissionControlFrozenEvidenceReference,
  right: MissionControlFrozenEvidenceReference,
): number {
  return `${left.kind}:${left.referenceId}`.localeCompare(
    `${right.kind}:${right.referenceId}`,
  );
}

function fingerprint(action: MissionControlReviewAction): string {
  return createHash("sha256").update(stableJson(action)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function gate(
  reason: MissionControlReviewGateReason,
  message: string,
): MissionControlReviewGateError {
  return new MissionControlReviewGateError(reason, message);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  allowedKeys: string[],
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).filter((key) => allowed.has(key) === false);
  if (unexpected.length > 0) {
    throw new Error(`Unexpected Mission Control review fields: ${unexpected.sort().join(", ")}.`);
  }
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error(`${field} exceeds ${maximum} characters.`);
  }
  return normalized;
}

function timestamp(value: unknown, field: string): string {
  const normalized = text(value, field, 64);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return normalized;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isInteger(value) === false || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function candidateFingerprint(value: unknown, field: string): string {
  const normalized = text(value, field, 256);
  if (/^sha256:[a-f0-9]{64}$/u.test(normalized) === false) {
    throw new Error(`${field} must be a sha256 candidate fingerprint.`);
  }
  return normalized;
}

function bundleId(value: unknown): string {
  const normalized = text(value, "bundleId", 80);
  if (/^sha256:[a-f0-9]{64}$/u.test(normalized) === false) {
    throw new Error("bundleId must be a content-addressed identity.");
  }
  return normalized;
}

const BASE_KEYS = [
  "type",
  "projectId",
  "actionId",
  "actionTs",
  "expectedRevision",
  "itemId",
  "expectedItemVersion",
  "attemptId",
  "expectedAttemptVersion",
] as const;
