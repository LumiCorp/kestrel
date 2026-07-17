import type { ContextCheckpointRecord, DelegationRecord, ThreadRecord } from "../kestrel/contracts/orchestration.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";

import type {
  ChildThreadBudget,
  ChildThreadPolicy,
  ChildThreadSupervisionPolicy,
  FanInDispositionSummary,
  SupervisionChildOutcomeState,
  SupervisionChildSummary,
  SupervisionSummary,
} from "./contracts.js";

export function defaultSupervisionGroupId(parentThreadId: string): string {
  return `supervision:${parentThreadId}`;
}

export function fanInCheckpointId(parentThreadId: string, groupId: string): string {
  return `checkpoint-fanin:${parentThreadId}:${groupId}`;
}

export function readSupervisionPolicy(
  policy: DelegationRecord["policy"] | ChildThreadPolicy | undefined,
): ChildThreadSupervisionPolicy | undefined {
  const value = asRecord(policy)?.supervision;
  if (asRecord(value) === undefined) {
    return ;
  }
  return value as ChildThreadSupervisionPolicy;
}

export function writeSupervisionPolicy(
  policy: DelegationRecord["policy"] | ChildThreadPolicy | undefined,
  supervision: ChildThreadSupervisionPolicy,
): Record<string, unknown> {
  return {
    ...(asRecord(policy) ?? {}),
    supervision,
  };
}

export function normalizeLaunchPolicy(input: {
  policy?: ChildThreadPolicy | undefined;
  parentThreadId: string;
  rolePrompt?: string | undefined;
  goal?: string | undefined;
  budget?: ChildThreadBudget | undefined;
  supervisionGroupId?: string | undefined;
  reconciliationIntent?: "auto_when_safe" | "manual_review" | undefined;
}): ChildThreadPolicy {
  const existingSupervision = readSupervisionPolicy(input.policy);
  const supervision: ChildThreadSupervisionPolicy = {
    groupId: input.supervisionGroupId ?? existingSupervision?.groupId ?? defaultSupervisionGroupId(input.parentThreadId),
    ...(input.rolePrompt !== undefined
      ? { rolePrompt: input.rolePrompt }
      : existingSupervision?.rolePrompt !== undefined
        ? { rolePrompt: existingSupervision.rolePrompt }
        : {}),
    ...(input.goal !== undefined
      ? { goal: input.goal }
      : existingSupervision?.goal !== undefined
        ? { goal: existingSupervision.goal }
        : {}),
    ...(input.budget !== undefined
      ? { budget: input.budget }
      : existingSupervision?.budget !== undefined
        ? { budget: existingSupervision.budget }
        : {}),
    reconciliationIntent:
      input.reconciliationIntent ?? existingSupervision?.reconciliationIntent ?? "auto_when_safe",
    resultState: "running",
  };
  const {
    depth,
    maxDepth,
    rootDelegationId,
    parentTaskId,
    supervision: _supervision,
    ...restPolicy
  } = input.policy ?? {};
  const normalizedDepth = normalizePolicyInteger(depth);
  const normalizedMaxDepth = normalizePolicyInteger(maxDepth);
  const normalizedRootDelegationId = normalizePolicyString(rootDelegationId);
  const normalizedParentTaskId = normalizePolicyString(parentTaskId);
  return {
    ...restPolicy,
    ...(input.budget?.allowApprovalInheritance !== undefined
      ? { allowApprovalInheritance: input.budget.allowApprovalInheritance }
      : {}),
    ...(input.budget?.maxTurns !== undefined ? { maxTurns: input.budget.maxTurns } : {}),
    ...(input.budget?.maxRuntimeMs !== undefined ? { maxRuntimeMs: input.budget.maxRuntimeMs } : {}),
    ...(normalizedDepth !== undefined ? { depth: normalizedDepth } : {}),
    ...(normalizedMaxDepth !== undefined ? { maxDepth: normalizedMaxDepth } : {}),
    ...(normalizedRootDelegationId !== undefined ? { rootDelegationId: normalizedRootDelegationId } : {}),
    ...(normalizedParentTaskId !== undefined ? { parentTaskId: normalizedParentTaskId } : {}),
    supervision,
  };
}

function normalizePolicyInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return ;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizePolicyString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function updateDelegationOutcomePolicy(input: {
  record: DelegationRecord;
  resultState: SupervisionChildOutcomeState;
  outcomeReason?: string | undefined;
  supersededBy?: string | undefined;
  latestFanInDisposition?: ChildThreadSupervisionPolicy["latestFanInDisposition"];
  latestFanInCheckpointId?: string | undefined;
}): DelegationRecord {
  const current = readSupervisionPolicy(input.record.policy);
  const supervision: ChildThreadSupervisionPolicy = {
    groupId: current?.groupId ?? defaultSupervisionGroupId(input.record.parentThreadId),
    ...(current?.rolePrompt !== undefined ? { rolePrompt: current.rolePrompt } : {}),
    ...(current?.goal !== undefined ? { goal: current.goal } : {}),
    ...(current?.budget !== undefined ? { budget: current.budget } : {}),
    ...(current?.reconciliationIntent !== undefined
      ? { reconciliationIntent: current.reconciliationIntent }
      : {}),
    resultState: input.resultState,
    ...(input.outcomeReason !== undefined ? { outcomeReason: input.outcomeReason } : {}),
    ...(input.supersededBy !== undefined ? { supersededBy: input.supersededBy, supersededAt: new Date().toISOString() } : {}),
    ...(input.latestFanInDisposition !== undefined ? { latestFanInDisposition: input.latestFanInDisposition } : {}),
    ...(input.latestFanInCheckpointId !== undefined
      ? { latestFanInCheckpointId: input.latestFanInCheckpointId }
      : {}),
  };
  return {
    ...input.record,
    policy: writeSupervisionPolicy(input.record.policy, supervision),
    updatedAt: new Date().toISOString(),
  };
}

export function deriveDelegationOutcomeState(input: {
  record: DelegationRecord;
  session?: SessionRecord | null | undefined;
  finalizedPayload?: unknown;
}): SupervisionChildOutcomeState {
  const supervision = readSupervisionPolicy(input.record.policy);
  if (supervision?.resultState === "superseded") {
    return "superseded";
  }
  if (input.record.status === "WAITING") {
    return "blocked";
  }
  if (input.record.status === "FAILED" || input.record.status === "CANCELLED") {
    return "failed";
  }
  if (input.record.status === "RUNNING" || input.record.status === "PENDING") {
    return "running";
  }
  if (input.record.status === "COMPLETED" && isPartialResult(input.session, input.finalizedPayload)) {
    return "partial";
  }
  if (input.record.status === "COMPLETED") {
    return "completed";
  }
  return "running";
}

export function toSupervisionChildSummary(input: {
  delegation: DelegationRecord;
  childThread: ThreadRecord | null;
}): SupervisionChildSummary {
  const supervision = readSupervisionPolicy(input.delegation.policy);
  const outcomeState =
    supervision?.resultState ??
    (input.delegation.status === "WAITING"
      ? "blocked"
      : input.delegation.status === "FAILED" || input.delegation.status === "CANCELLED"
        ? "failed"
        : input.delegation.status === "COMPLETED"
          ? "completed"
          : "running");
  return {
    delegationId: input.delegation.delegationId,
    threadId: input.delegation.childThreadId,
    title: input.delegation.title,
    status: input.delegation.status,
    outcomeState,
    actionable: outcomeState === "blocked" || outcomeState === "failed" || outcomeState === "partial",
    updatedAt: input.delegation.updatedAt,
    ...(supervision?.rolePrompt !== undefined ? { rolePrompt: supervision.rolePrompt } : {}),
    ...(supervision?.goal !== undefined ? { goal: supervision.goal } : {}),
    ...(input.delegation.result !== undefined ? { result: input.delegation.result } : {}),
    ...(input.delegation.resultSummary !== undefined ? { resultSummary: input.delegation.resultSummary } : {}),
    ...(input.delegation.result?.error?.code !== undefined
      ? { errorCode: input.delegation.result.error.code }
      : {}),
    ...(input.delegation.errorMessage !== undefined ? { errorMessage: input.delegation.errorMessage } : {}),
    ...(input.delegation.result?.references !== undefined
      ? { references: input.delegation.result.references }
      : {}),
    ...(input.delegation.waitEventType !== undefined ? { waitEventType: input.delegation.waitEventType } : {}),
    ...(supervision?.supersededAt !== undefined ? { supersededAt: supervision.supersededAt } : {}),
    ...(supervision?.latestFanInDisposition !== undefined
      ? { latestFanInDisposition: supervision.latestFanInDisposition }
      : {}),
    ...(supervision?.latestFanInCheckpointId !== undefined
      ? { latestFanInCheckpointId: supervision.latestFanInCheckpointId }
      : {}),
  };
}

export function buildSupervisionSummary(input: {
  parentThreadId: string;
  children: SupervisionChildSummary[];
  checkpoint?: ContextCheckpointRecord | undefined;
  latestDecision?: FanInDispositionSummary | undefined;
}): SupervisionSummary | undefined {
  if (input.children.length === 0) {
    return ;
  }
  const activeChildren = input.children.filter((child) => isTerminalOutcome(child.outcomeState) === false);
  const terminalChildren = input.children.filter((child) => isTerminalOutcome(child.outcomeState));
  const dominant = input.children
    .filter((child) => child.outcomeState === "blocked" && child.supersededAt === undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return {
    groupId: defaultSupervisionGroupId(input.parentThreadId),
    status:
      input.latestDecision?.status === "auto_applied"
        ? "auto_reconciled"
        : input.latestDecision?.status === "accepted"
          ? "accepted"
          : input.latestDecision?.status === "deferred"
            ? "deferred"
            : input.checkpoint?.status === "PENDING"
              ? "waiting_fan_in"
              : "active",
    childCount: input.children.length,
    activeCount: activeChildren.length,
    terminalCount: terminalChildren.length,
    ...(dominant !== undefined ? { dominantBlockerDelegationId: dominant.delegationId } : {}),
    ...(input.checkpoint !== undefined ? { checkpointId: input.checkpoint.checkpointId } : {}),
    nextAction:
      input.checkpoint?.status === "PENDING"
        ? "Review fan-in checkpoint."
        : dominant !== undefined
          ? `Focus child ${dominant.threadId}.`
          : activeChildren.length === 0
            ? "Review reconciled child outcomes."
            : "Monitor active child threads.",
  };
}

export function classifyFanIn(input: {
  parentThreadId: string;
  children: SupervisionChildSummary[];
  checkpoint?: ContextCheckpointRecord | undefined;
}):
  | { kind: "none" }
  | { kind: "pending_checkpoint"; checkpointId: string; reason: string; selectedDelegationIds: string[] }
  | { kind: "auto_apply"; summary: string; selectedDelegationIds: string[] } {
  const relevant = input.children.filter((child) => child.supersededAt === undefined);
  if (relevant.length === 0) {
    return { kind: "none" };
  }
  if (relevant.length < 2) {
    return { kind: "none" };
  }
  if (relevant.some((child) => isTerminalOutcome(child.outcomeState) === false)) {
    return { kind: "none" };
  }
  const selectedDelegationIds = relevant.map((child) => child.delegationId);
  const hasReviewState = relevant.some(
    (child) => child.outcomeState === "partial" || child.outcomeState === "failed" || child.outcomeState === "blocked",
  );
  if (hasReviewState) {
    return {
      kind: "pending_checkpoint",
      checkpointId: input.checkpoint?.checkpointId ?? fanInCheckpointId(input.parentThreadId, defaultSupervisionGroupId(input.parentThreadId)),
      reason: "Child results require operator reconciliation before the parent can continue.",
      selectedDelegationIds,
    };
  }
  return {
    kind: "auto_apply",
    selectedDelegationIds,
    summary: relevant
      .map((child) => `${child.title}: ${child.resultSummary ?? "completed"}`)
      .join(" | "),
  };
}

export function latestFanInDisposition(input: {
  checkpoint?: ContextCheckpointRecord | undefined;
  children: SupervisionChildSummary[];
}): FanInDispositionSummary | undefined {
  const firstDisposition = input.children.find((child) => child.latestFanInDisposition !== undefined);
  if (input.checkpoint?.status === "PENDING") {
    return {
      status: "pending_checkpoint",
      checkpointId: input.checkpoint.checkpointId,
      summary: input.checkpoint.reason,
      at: input.checkpoint.createdAt,
    };
  }
  if (firstDisposition?.latestFanInDisposition !== undefined) {
    return {
      status: firstDisposition.latestFanInDisposition,
      ...(firstDisposition.latestFanInCheckpointId !== undefined
        ? { checkpointId: firstDisposition.latestFanInCheckpointId }
        : {}),
    };
  }
  return ;
}

function isTerminalOutcome(state: SupervisionChildOutcomeState): boolean {
  return (
    state === "partial" ||
    state === "failed" ||
    state === "completed" ||
    state === "superseded"
  );
}

function isPartialResult(session: SessionRecord | null | undefined, finalizedPayload: unknown): boolean {
  const finalized = asRecord(finalizedPayload);
  if (finalized?.data !== undefined && asRecord(finalized.data)?.partial === true) {
    return true;
  }
  const reactState = asRecord(session?.state)?.react;
  const terminal = asRecord(asRecord(reactState)?.terminal);
  return terminal?.reasonCode === "research_stalled_partial" || terminal?.partialAnswer === true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}
