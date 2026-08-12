/** Read-only compatibility for recovery evidence written by retired runtimes. */
export const RECOVERY_DECISION_VERSION = "recovery_decision_v1" as const;
export const RECOVERY_REVIEW_BINDING_VERSION =
  "recovery_review_binding_v1" as const;

export type RecoveryScopeV1 = "model_call" | "tool_call" | "run";
export type RecoveryCandidateDispositionV1 = "selected" | "rejected" | "skipped";

export interface RecoveryDecisionV1 {
  version: typeof RECOVERY_DECISION_VERSION;
  decisionId: string;
  runId: string;
  sessionId: string;
  callId?: string | undefined;
  stepIndex?: number | undefined;
  policyId: string;
  policyRevision: string;
  executionProfileFingerprint: string;
  trigger: {
    scope: RecoveryScopeV1;
    failureCode: string;
    visibleOutputStarted: boolean;
  };
  candidates: Array<{
    stageId: string;
    candidateId: string;
    disposition: RecoveryCandidateDispositionV1;
    reasonCode: string;
  }>;
  budget: {
    remainingMs: number;
    tokensUsed: number;
    toolCallsUsed: number;
  };
  compatibility?: {
    status: "compatible" | "incompatible";
    profile?: string | undefined;
    reasonCode?: string | undefined;
  } | undefined;
  outcome:
    | {
        status: "selected";
        action:
          | "retry_same_route"
          | "alternate_model"
          | "alternate_tool"
          | "deterministic_workflow";
        stageId: string;
        candidateId: string;
      }
    | {
        status: "waiting";
        action: "human_review";
        stageId: string;
        reviewBindingId: string;
      }
    | {
        status: "exhausted";
        action: "terminal_failure";
        terminalCode: string;
      };
  createdAt: string;
}

export interface RecoveryReviewBindingV1 {
  version: typeof RECOVERY_REVIEW_BINDING_VERSION;
  bindingId: string;
  decisionId: string;
  threadId: string;
  runId: string;
  executionProfileFingerprint: string;
  policyRevision: string;
  allowedOptionIds: string[];
  requestedAt: string;
  expiresAt?: string | undefined;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PROFILE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

export function parseRecoveryDecisionV1(value: unknown): RecoveryDecisionV1 {
  const record = requireRecord(value, "Recovery decision");
  rejectUnknownFields(record, new Set([
    "version", "decisionId", "runId", "sessionId", "callId", "stepIndex",
    "policyId", "policyRevision", "executionProfileFingerprint", "trigger",
    "candidates", "budget", "compatibility", "outcome", "createdAt",
  ]), "Recovery decision");
  if (record.version !== RECOVERY_DECISION_VERSION) {
    throw new Error(`Recovery decision version must be '${RECOVERY_DECISION_VERSION}'.`);
  }
  const trigger = requireRecord(record.trigger, "Recovery decision trigger");
  rejectUnknownFields(trigger, new Set(["scope", "failureCode", "visibleOutputStarted"]), "Recovery decision trigger");
  const budget = requireRecord(record.budget, "Recovery decision budget");
  rejectUnknownFields(budget, new Set(["remainingMs", "tokensUsed", "toolCallsUsed"]), "Recovery decision budget");
  const candidates = requireArray(record.candidates, "Recovery decision candidates").map((candidate, index) => {
    const item = requireRecord(candidate, `Recovery decision candidates[${index}]`);
    rejectUnknownFields(item, new Set(["stageId", "candidateId", "disposition", "reasonCode"]), `Recovery decision candidates[${index}]`);
    if (item.disposition !== "selected" && item.disposition !== "rejected" && item.disposition !== "skipped") {
      throw new Error(`Recovery decision candidates[${index}] disposition is invalid.`);
    }
    return {
      stageId: requireString(item.stageId, `Recovery decision candidates[${index}] stageId`),
      candidateId: requireString(item.candidateId, `Recovery decision candidates[${index}] candidateId`),
      disposition: item.disposition as RecoveryCandidateDispositionV1,
      reasonCode: requireCode(item.reasonCode, `Recovery decision candidates[${index}] reasonCode`),
    };
  });
  const compatibility = record.compatibility === undefined
    ? undefined
    : parseDecisionCompatibility(record.compatibility);
  return {
    version: RECOVERY_DECISION_VERSION,
    decisionId: requireString(record.decisionId, "Recovery decision decisionId"),
    runId: requireString(record.runId, "Recovery decision runId"),
    sessionId: requireString(record.sessionId, "Recovery decision sessionId"),
    ...(record.callId !== undefined ? { callId: requireString(record.callId, "Recovery decision callId") } : {}),
    ...(record.stepIndex !== undefined ? { stepIndex: requireNonNegativeInteger(record.stepIndex, "Recovery decision stepIndex") } : {}),
    policyId: requireString(record.policyId, "Recovery decision policyId"),
    policyRevision: requireHash(record.policyRevision, "Recovery decision policyRevision"),
    executionProfileFingerprint: requireProfileFingerprint(record.executionProfileFingerprint, "Recovery decision executionProfileFingerprint"),
    trigger: {
      scope: requireScope(trigger.scope, "Recovery decision trigger scope"),
      failureCode: requireCode(trigger.failureCode, "Recovery decision trigger failureCode"),
      visibleOutputStarted: requireBoolean(trigger.visibleOutputStarted, "Recovery decision trigger visibleOutputStarted"),
    },
    candidates,
    budget: {
      remainingMs: requireNonNegativeNumber(budget.remainingMs, "Recovery decision budget remainingMs"),
      tokensUsed: requireNonNegativeNumber(budget.tokensUsed, "Recovery decision budget tokensUsed"),
      toolCallsUsed: requireNonNegativeNumber(budget.toolCallsUsed, "Recovery decision budget toolCallsUsed"),
    },
    ...(compatibility !== undefined ? { compatibility } : {}),
    outcome: parseDecisionOutcome(record.outcome),
    createdAt: requireTimestamp(record.createdAt, "Recovery decision createdAt"),
  };
}

export function parseRecoveryReviewBindingV1(value: unknown): RecoveryReviewBindingV1 {
  const record = requireRecord(value, "Recovery review binding");
  rejectUnknownFields(record, new Set([
    "version", "bindingId", "decisionId", "threadId", "runId",
    "executionProfileFingerprint", "policyRevision", "allowedOptionIds",
    "requestedAt", "expiresAt",
  ]), "Recovery review binding");
  if (record.version !== RECOVERY_REVIEW_BINDING_VERSION) {
    throw new Error(`Recovery review binding version must be '${RECOVERY_REVIEW_BINDING_VERSION}'.`);
  }
  const allowedOptionIds = requireStringArray(record.allowedOptionIds, "Recovery review binding allowedOptionIds");
  const requestedAt = requireTimestamp(record.requestedAt, "Recovery review binding requestedAt");
  const expiresAt = record.expiresAt === undefined
    ? undefined
    : requireTimestamp(record.expiresAt, "Recovery review binding expiresAt");
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(requestedAt)) {
    throw new Error("Recovery review binding expiresAt must be after requestedAt.");
  }
  return {
    version: RECOVERY_REVIEW_BINDING_VERSION,
    bindingId: requireString(record.bindingId, "Recovery review binding bindingId"),
    decisionId: requireString(record.decisionId, "Recovery review binding decisionId"),
    threadId: requireString(record.threadId, "Recovery review binding threadId"),
    runId: requireString(record.runId, "Recovery review binding runId"),
    executionProfileFingerprint: requireProfileFingerprint(record.executionProfileFingerprint, "Recovery review binding executionProfileFingerprint"),
    policyRevision: requireHash(record.policyRevision, "Recovery review binding policyRevision"),
    allowedOptionIds,
    requestedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function parseDecisionOutcome(value: unknown): RecoveryDecisionV1["outcome"] {
  const record = requireRecord(value, "Recovery decision outcome");
  if (record.status === "selected") {
    rejectUnknownFields(record, new Set(["status", "action", "stageId", "candidateId"]), "Recovery decision outcome");
    if (record.action !== "retry_same_route" && record.action !== "alternate_model" && record.action !== "alternate_tool" && record.action !== "deterministic_workflow") {
      throw new Error("Recovery decision selected outcome action is invalid.");
    }
    return {
      status: "selected",
      action: record.action,
      stageId: requireString(record.stageId, "Recovery decision outcome stageId"),
      candidateId: requireString(record.candidateId, "Recovery decision outcome candidateId"),
    };
  }
  if (record.status === "waiting") {
    rejectUnknownFields(record, new Set(["status", "action", "stageId", "reviewBindingId"]), "Recovery decision outcome");
    if (record.action !== "human_review") throw new Error("Recovery decision waiting outcome action is invalid.");
    return {
      status: "waiting",
      action: "human_review",
      stageId: requireString(record.stageId, "Recovery decision outcome stageId"),
      reviewBindingId: requireString(record.reviewBindingId, "Recovery decision outcome reviewBindingId"),
    };
  }
  if (record.status === "exhausted") {
    rejectUnknownFields(record, new Set(["status", "action", "terminalCode"]), "Recovery decision outcome");
    if (record.action !== "terminal_failure") throw new Error("Recovery decision exhausted outcome action is invalid.");
    return {
      status: "exhausted",
      action: "terminal_failure",
      terminalCode: requireCode(record.terminalCode, "Recovery decision outcome terminalCode"),
    };
  }
  throw new Error("Recovery decision outcome status is invalid.");
}

function parseDecisionCompatibility(value: unknown): NonNullable<RecoveryDecisionV1["compatibility"]> {
  const record = requireRecord(value, "Recovery decision compatibility");
  rejectUnknownFields(record, new Set(["status", "profile", "reasonCode"]), "Recovery decision compatibility");
  if (record.status !== "compatible" && record.status !== "incompatible") {
    throw new Error("Recovery decision compatibility status is invalid.");
  }
  return {
    status: record.status,
    ...(record.profile !== undefined ? { profile: requireString(record.profile, "Recovery decision compatibility profile") } : {}),
    ...(record.reasonCode !== undefined ? { reasonCode: requireCode(record.reasonCode, "Recovery decision compatibility reasonCode") } : {}),
  };
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`${label} contains unknown field '${unknown}'.`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) throw new Error(`${label} must be a non-empty trimmed string.`);
  return value;
}

function requireCode(value: unknown, label: string): string {
  const code = requireString(value, label);
  if (!/^[A-Z][A-Z0-9_]*$/u.test(code)) throw new Error(`${label} must be an exact uppercase code.`);
  return code;
}

function requireHash(value: unknown, label: string): string {
  const hash = requireString(value, label);
  if (!SHA256_PATTERN.test(hash)) throw new Error(`${label} must use sha256:<64 lowercase hex>.`);
  return hash;
}

function requireProfileFingerprint(value: unknown, label: string): string {
  const fingerprint = requireString(value, label);
  if (!PROFILE_FINGERPRINT_PATTERN.test(fingerprint)) throw new Error(`${label} must use 64 lowercase hex characters.`);
  return fingerprint;
}

function requireScope(value: unknown, label: string): RecoveryScopeV1 {
  if (value !== "model_call" && value !== "tool_call" && value !== "run") throw new Error(`${label} is invalid.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number.`);
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be a valid timestamp.`);
  return timestamp;
}

function requireStringArray(value: unknown, label: string): string[] {
  const items = requireArray(value, label).map((item, index) => requireString(item, `${label}[${index}]`));
  if (items.length === 0) throw new Error(`${label} must not be empty.`);
  if (new Set(items).size !== items.length) throw new Error(`${label} must contain unique values.`);
  return items;
}
