import { createHash } from "node:crypto";

export type MissionControlConditionalEvidenceKind =
  | "automated_review"
  | "delivery"
  | "artifact"
  | "checkpoint"
  | "preview";

export type MissionControlValidationContract =
  | {
      mode: "required";
      actionIds: string[];
    }
  | {
      mode: "not_applicable";
      reason: string;
    }
  | {
      mode: "waived";
      authorizationId: string;
      reason: string;
    };

export interface MissionControlCompletionContract {
  workType: "code" | "non_code";
  changeOutcome: "changes" | "no_change";
  validation: MissionControlValidationContract;
  requiredEvidence: MissionControlConditionalEvidenceKind[];
}

export interface MissionControlReviewEvidenceReferences {
  change: string;
  validationResults: string[];
  automatedReviews: string[];
  deliveries: string[];
  artifacts: string[];
  checkpoints: string[];
  previews: string[];
}

export interface MissionControlReviewCandidate {
  workspaceRoot: string;
  candidateFingerprint: string;
  commitSha?: string | undefined;
}

export interface MissionControlExecutionEvidenceReference {
  kind: "execution";
  owner: "runtime";
  referenceId: string;
  sessionId: string;
  threadId: string;
  runId: string;
  outcome: "completed";
}

export interface MissionControlChangeEvidenceReference {
  kind: "change";
  owner: "workspace_changes";
  referenceId: string;
  workspaceRoot: string;
  candidateFingerprint: string;
  outcome: "changes" | "no_change";
}

export interface MissionControlValidationEvidenceReference {
  kind: "validation";
  owner: "workspace_validation";
  referenceId: string;
  candidateFingerprint: string;
  actionId?: string | undefined;
  outcome: "passed" | "not_applicable" | "waived";
  authorizationId?: string | undefined;
}

export interface MissionControlConditionalEvidenceReference {
  kind: MissionControlConditionalEvidenceKind;
  owner:
    | "workspace_review"
    | "workspace_delivery"
    | "runtime_artifacts"
    | "workspace_checkpoints"
    | "preview";
  referenceId: string;
  candidateFingerprint: string;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  outcome: "satisfied";
}

export type MissionControlFrozenEvidenceReference =
  | MissionControlExecutionEvidenceReference
  | MissionControlChangeEvidenceReference
  | MissionControlValidationEvidenceReference
  | MissionControlConditionalEvidenceReference;

export interface MissionControlReviewBundle {
  id: string;
  projectId: string;
  itemId: string;
  attemptId: string;
  candidate: MissionControlReviewCandidate;
  contract: MissionControlCompletionContract;
  evidence: MissionControlFrozenEvidenceReference[];
  actionId: string;
  frozenAt: string;
}

export interface MissionControlAcceptanceDecision {
  decision: "accepted";
  projectId: string;
  itemId: string;
  attemptId: string;
  candidateFingerprint: string;
  bundleId: string;
  operatorId: string;
  actionId: string;
  decidedAt: string;
}

export interface MissionControlRequestChangesDecision {
  decision: "changes_requested";
  projectId: string;
  itemId: string;
  attemptId: string;
  candidateFingerprint: string;
  bundleId: string;
  operatorId: string;
  actionId: string;
  decidedAt: string;
  reason?: string | undefined;
}

export type MissionControlReviewDecision =
  | MissionControlAcceptanceDecision
  | MissionControlRequestChangesDecision;

export function parseMissionControlCompletionContract(
  value: unknown,
  field = "completionContract",
): MissionControlCompletionContract {
  const record = object(value, field);
  exactKeys(record, ["workType", "changeOutcome", "validation", "requiredEvidence"], field);
  if (record.workType !== "code" && record.workType !== "non_code") {
    throw new Error(`${field}.workType is invalid.`);
  }
  if (record.changeOutcome !== "changes" && record.changeOutcome !== "no_change") {
    throw new Error(`${field}.changeOutcome is invalid.`);
  }
  const requiredEvidence = stringArray(
    record.requiredEvidence,
    `${field}.requiredEvidence`,
  ).map((kind) => conditionalKind(kind, `${field}.requiredEvidence`));
  if (new Set(requiredEvidence).size !== requiredEvidence.length) {
    throw new Error(`${field}.requiredEvidence must not contain duplicates.`);
  }
  return {
    workType: record.workType,
    changeOutcome: record.changeOutcome,
    validation: parseValidationContract(record.validation, `${field}.validation`),
    requiredEvidence,
  };
}

export function parseMissionControlReviewEvidenceReferences(
  value: unknown,
  field = "evidence",
): MissionControlReviewEvidenceReferences {
  const record = object(value, field);
  exactKeys(record, [
    "change",
    "validationResults",
    "automatedReviews",
    "deliveries",
    "artifacts",
    "checkpoints",
    "previews",
  ], field);
  return {
    change: text(record.change, `${field}.change`),
    validationResults: uniqueStrings(
      record.validationResults,
      `${field}.validationResults`,
    ),
    automatedReviews: uniqueStrings(
      record.automatedReviews,
      `${field}.automatedReviews`,
    ),
    deliveries: uniqueStrings(record.deliveries, `${field}.deliveries`),
    artifacts: uniqueStrings(record.artifacts, `${field}.artifacts`),
    checkpoints: uniqueStrings(record.checkpoints, `${field}.checkpoints`),
    previews: uniqueStrings(record.previews, `${field}.previews`),
  };
}

export function parseMissionControlReviewCandidate(
  value: unknown,
  field = "candidate",
): MissionControlReviewCandidate {
  const record = object(value, field);
  exactKeys(record, ["workspaceRoot", "candidateFingerprint", "commitSha"], field);
  return {
    workspaceRoot: text(record.workspaceRoot, `${field}.workspaceRoot`, 4_096),
    candidateFingerprint: fingerprint(
      record.candidateFingerprint,
      `${field}.candidateFingerprint`,
    ),
    ...(record.commitSha === undefined
      ? {}
      : { commitSha: sha(record.commitSha, `${field}.commitSha`) }),
  };
}

export function parseMissionControlReviewBundle(
  value: unknown,
  field = "reviewBundle",
): MissionControlReviewBundle {
  const record = object(value, field);
  exactKeys(record, [
    "id",
    "projectId",
    "itemId",
    "attemptId",
    "candidate",
    "contract",
    "evidence",
    "actionId",
    "frozenAt",
  ], field);
  if (Array.isArray(record.evidence) === false) {
    throw new Error(`${field}.evidence must be an array.`);
  }
  const parsed = {
    id: bundleId(record.id, `${field}.id`),
    projectId: text(record.projectId, `${field}.projectId`, 256),
    itemId: text(record.itemId, `${field}.itemId`, 256),
    attemptId: text(record.attemptId, `${field}.attemptId`, 256),
    candidate: parseMissionControlReviewCandidate(
      record.candidate,
      `${field}.candidate`,
    ),
    contract: parseMissionControlCompletionContract(
      record.contract,
      `${field}.contract`,
    ),
    evidence: record.evidence.map((entry, index) =>
      parseFrozenEvidence(entry, `${field}.evidence.${index}`),
    ),
    actionId: text(record.actionId, `${field}.actionId`, 256),
    frozenAt: timestamp(record.frozenAt, `${field}.frozenAt`),
  };
  const { id, ...content } = parsed;
  const expectedId = `sha256:${createHash("sha256")
    .update(stableJson(content))
    .digest("hex")}`;
  if (id !== expectedId) {
    throw new Error(`${field}.id does not match its frozen bundle content.`);
  }
  const candidateFingerprint = parsed.candidate.candidateFingerprint;
  for (const evidence of parsed.evidence) {
    if (
      "candidateFingerprint" in evidence &&
      evidence.candidateFingerprint !== candidateFingerprint
    ) {
      throw new Error(`${field}.evidence contains a mixed candidate.`);
    }
  }
  if (
    parsed.evidence.filter((evidence) => evidence.kind === "execution").length !== 1 ||
    parsed.evidence.filter((evidence) => evidence.kind === "change").length !== 1
  ) {
    throw new Error(`${field}.evidence must contain one execution and one change reference.`);
  }
  return parsed;
}

export function parseMissionControlReviewDecision(
  value: unknown,
  field = "reviewDecision",
): MissionControlReviewDecision {
  const record = object(value, field);
  const decision = record.decision;
  if (decision !== "accepted" && decision !== "changes_requested") {
    throw new Error(`${field}.decision is invalid.`);
  }
  exactKeys(record, [
    "decision",
    "projectId",
    "itemId",
    "attemptId",
    "candidateFingerprint",
    "bundleId",
    "operatorId",
    "actionId",
    "decidedAt",
    ...(decision === "changes_requested" ? ["reason"] : []),
  ], field);
  const base = {
    projectId: text(record.projectId, `${field}.projectId`, 256),
    itemId: text(record.itemId, `${field}.itemId`, 256),
    attemptId: text(record.attemptId, `${field}.attemptId`, 256),
    candidateFingerprint: fingerprint(
      record.candidateFingerprint,
      `${field}.candidateFingerprint`,
    ),
    bundleId: bundleId(record.bundleId, `${field}.bundleId`),
    operatorId: text(record.operatorId, `${field}.operatorId`, 256),
    actionId: text(record.actionId, `${field}.actionId`, 256),
    decidedAt: timestamp(record.decidedAt, `${field}.decidedAt`),
  };
  return decision === "accepted"
    ? { ...base, decision }
    : {
        ...base,
        decision,
        ...(record.reason === undefined
          ? {}
          : { reason: text(record.reason, `${field}.reason`, 32_000) }),
      };
}

function parseValidationContract(
  value: unknown,
  field: string,
): MissionControlValidationContract {
  const record = object(value, field);
  const mode = record.mode;
  switch (mode) {
    case "required": {
      exactKeys(record, ["mode", "actionIds"], field);
      const actionIds = uniqueStrings(record.actionIds, `${field}.actionIds`);
      if (actionIds.length === 0) {
        throw new Error(`${field}.actionIds must identify at least one required validation.`);
      }
      return { mode, actionIds };
    }
    case "not_applicable":
      exactKeys(record, ["mode", "reason"], field);
      return { mode, reason: text(record.reason, `${field}.reason`, 32_000) };
    case "waived":
      exactKeys(record, ["mode", "authorizationId", "reason"], field);
      return {
        mode,
        authorizationId: text(
          record.authorizationId,
          `${field}.authorizationId`,
          256,
        ),
        reason: text(record.reason, `${field}.reason`, 32_000),
      };
    default:
      throw new Error(`${field}.mode is invalid.`);
  }
}

function parseFrozenEvidence(
  value: unknown,
  field: string,
): MissionControlFrozenEvidenceReference {
  const record = object(value, field);
  const kind = record.kind;
  switch (kind) {
    case "execution":
      exactKeys(record, [
        "kind",
        "owner",
        "referenceId",
        "sessionId",
        "threadId",
        "runId",
        "outcome",
      ], field);
      if (record.owner !== "runtime" || record.outcome !== "completed") {
        throw new Error(`${field} execution evidence is invalid.`);
      }
      return {
        kind,
        owner: record.owner,
        referenceId: text(record.referenceId, `${field}.referenceId`, 256),
        sessionId: text(record.sessionId, `${field}.sessionId`, 256),
        threadId: text(record.threadId, `${field}.threadId`, 256),
        runId: text(record.runId, `${field}.runId`, 256),
        outcome: record.outcome,
      };
    case "change":
      exactKeys(record, [
        "kind",
        "owner",
        "referenceId",
        "workspaceRoot",
        "candidateFingerprint",
        "outcome",
      ], field);
      if (
        record.owner !== "workspace_changes" ||
        (record.outcome !== "changes" && record.outcome !== "no_change")
      ) {
        throw new Error(`${field} change evidence is invalid.`);
      }
      return {
        kind,
        owner: record.owner,
        referenceId: text(record.referenceId, `${field}.referenceId`, 256),
        workspaceRoot: text(record.workspaceRoot, `${field}.workspaceRoot`, 4_096),
        candidateFingerprint: fingerprint(
          record.candidateFingerprint,
          `${field}.candidateFingerprint`,
        ),
        outcome: record.outcome,
      };
    case "validation": {
      exactKeys(record, [
        "kind",
        "owner",
        "referenceId",
        "candidateFingerprint",
        "actionId",
        "outcome",
        "authorizationId",
      ], field);
      if (
        record.owner !== "workspace_validation" ||
        (record.outcome !== "passed" &&
          record.outcome !== "not_applicable" &&
          record.outcome !== "waived")
      ) {
        throw new Error(`${field} validation evidence is invalid.`);
      }
      if (record.outcome === "passed" && record.actionId === undefined) {
        throw new Error(`${field}.actionId is required for passed validation.`);
      }
      if (record.outcome === "waived" && record.authorizationId === undefined) {
        throw new Error(`${field}.authorizationId is required for waived validation.`);
      }
      return {
        kind,
        owner: record.owner,
        referenceId: text(record.referenceId, `${field}.referenceId`, 256),
        candidateFingerprint: fingerprint(
          record.candidateFingerprint,
          `${field}.candidateFingerprint`,
        ),
        ...(record.actionId === undefined
          ? {}
          : { actionId: text(record.actionId, `${field}.actionId`, 256) }),
        outcome: record.outcome,
        ...(record.authorizationId === undefined
          ? {}
          : {
              authorizationId: text(
                record.authorizationId,
                `${field}.authorizationId`,
                256,
              ),
            }),
      };
    }
    case "automated_review":
    case "delivery":
    case "artifact":
    case "checkpoint":
    case "preview": {
      exactKeys(record, [
        "kind",
        "owner",
        "referenceId",
        "candidateFingerprint",
        "sessionId",
        "threadId",
        "runId",
        "outcome",
      ], field);
      const owner = conditionalOwner(kind);
      if (record.owner !== owner || record.outcome !== "satisfied") {
        throw new Error(`${field} conditional evidence is invalid.`);
      }
      return {
        kind,
        owner,
        referenceId: text(record.referenceId, `${field}.referenceId`, 256),
        candidateFingerprint: fingerprint(
          record.candidateFingerprint,
          `${field}.candidateFingerprint`,
        ),
        ...(record.sessionId === undefined
          ? {}
          : { sessionId: text(record.sessionId, `${field}.sessionId`, 256) }),
        ...(record.threadId === undefined
          ? {}
          : { threadId: text(record.threadId, `${field}.threadId`, 256) }),
        ...(record.runId === undefined
          ? {}
          : { runId: text(record.runId, `${field}.runId`, 256) }),
        outcome: record.outcome,
      };
    }
    default:
      throw new Error(`${field}.kind is invalid.`);
  }
}

function conditionalKind(
  value: string,
  field: string,
): MissionControlConditionalEvidenceKind {
  if (
    value !== "automated_review" &&
    value !== "delivery" &&
    value !== "artifact" &&
    value !== "checkpoint" &&
    value !== "preview"
  ) {
    throw new Error(`${field} contains an invalid evidence kind.`);
  }
  return value;
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

function uniqueStrings(value: unknown, field: string): string[] {
  const values = stringArray(value, field);
  if (new Set(values).size !== values.length) {
    throw new Error(`${field} must not contain duplicates.`);
  }
  return values;
}

function stringArray(value: unknown, field: string): string[] {
  if (Array.isArray(value) === false) {
    throw new Error(`${field} must be an array.`);
  }
  return value.map((entry, index) => text(entry, `${field}.${index}`, 256));
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (allowedSet.has(key) === false) {
      throw new Error(`${field}.${key} is not allowed.`);
    }
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

function fingerprint(value: unknown, field: string): string {
  const normalized = text(value, field, 256);
  if (/^sha256:[a-f0-9]{64}$/u.test(normalized) === false) {
    throw new Error(`${field} must be a sha256 candidate fingerprint.`);
  }
  return normalized;
}

function sha(value: unknown, field: string): string {
  const normalized = text(value, field, 128).toLowerCase();
  if (/^[a-f0-9]{40,64}$/u.test(normalized) === false) {
    throw new Error(`${field} must be an immutable commit SHA.`);
  }
  return normalized;
}

function bundleId(value: unknown, field: string): string {
  const normalized = text(value, field, 80);
  if (/^sha256:[a-f0-9]{64}$/u.test(normalized) === false) {
    throw new Error(`${field} must be a content-addressed bundle identity.`);
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
