import { normalizeVisibleTodoState } from "../runtime/visibleTodos.js";

export interface LoopProgressSnapshotV1 {
  version: "loop_progress_v1";
  epoch: number;
  externalInput: {
    kind: string;
    status: string;
    eventType: string;
    payload: unknown;
  };
  actionSignature: string;
  nextStepAgent: string;
  actionResult: {
    kind: string;
    status: string;
    toolName: string;
    resultIdentity: string;
  };
  feedback: Record<string, unknown>;
  waitToken: string;
  pendingExecution: unknown;
}

/**
 * Canonical semantic feedback projection shared by loop admission and runtime
 * transition telemetry. Volatile timestamps and presentation-only fields are
 * intentionally excluded so deterministic replay observes the same progress.
 */
export function normalizeAgentFeedbackForLoopGuard(
  reactState: Record<string, unknown>,
): Record<string, unknown> {
  const ledgerEvidence = asArray(reactState.evidenceLedger)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map(normalizeEvidenceEntry);
  const identityHistory = asArray(reactState.evidenceIdentityHistory)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map(normalizeEvidenceEntry)
    .filter((entry) => entry.resultIdentity.length > 0);
  const unidentifiedLedgerEvidence = ledgerEvidence.filter(
    (entry) => entry.resultIdentity.length === 0,
  );
  const evidenceBySemanticIdentity = new Map<string, Record<string, unknown>>();
  for (const entry of identityHistory.length > 0
    ? [...identityHistory, ...unidentifiedLedgerEvidence]
    : ledgerEvidence) {
    evidenceBySemanticIdentity.set(stableJson(entry), entry);
  }
  const evidence = [...evidenceBySemanticIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
  const visibleTodos = normalizeVisibleTodoState(reactState.visibleTodos);
  const lastActionResult = asRecord(reactState.lastActionResult);
  return {
    evidence,
    visibleTodos: visibleTodos?.items.map((item) => ({
      id: item.id,
      status: item.status,
    })),
    blockers: asArray(reactState.blockers)
      .map(asRecord)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map((entry) => ({
        code: asString(entry.code) ?? "",
        target: asString(entry.target) ?? "",
        requirementId: asString(entry.requirementId) ?? "",
      })),
    capabilities: readCapabilityClasses(reactState),
    lastActionResultKind: asString(lastActionResult?.kind) ?? "",
    lastActionResultStatus: asString(lastActionResult?.status) ?? "",
    lastActionTool:
      asString(lastActionResult?.toolName) ?? asString(lastActionResult?.name) ?? "",
    lastActionResultIdentity:
      asString(lastActionResult?.resultIdentity) ??
      asString(lastActionResult?.callId) ??
      asString(lastActionResult?.id) ??
      "",
  };
}

export function projectLoopProgress(input: {
  reactState: Record<string, unknown>;
  actionSignature: string;
  nextStepAgent?: string | undefined;
  waitToken: string;
  pendingExecution: unknown;
}): LoopProgressSnapshotV1 {
  const loopGuard = asRecord(input.reactState.loopGuard);
  const lastActionResult = asRecord(input.reactState.lastActionResult);
  const isExternalInput = lastActionResult?.kind === "user_reply";
  return {
    version: "loop_progress_v1",
    epoch: readNonNegativeInteger(loopGuard?.epoch),
    externalInput: {
      kind: isExternalInput ? "user_reply" : "",
      status: isExternalInput ? asString(lastActionResult?.status) ?? "" : "",
      eventType: isExternalInput
        ? asString(lastActionResult?.responseEventType) ?? ""
        : "",
      payload: isExternalInput ? normalizeValue(lastActionResult?.responsePayload) : undefined,
    },
    actionSignature: input.actionSignature,
    nextStepAgent: input.nextStepAgent ?? "",
    actionResult: {
      kind: asString(lastActionResult?.kind) ?? "",
      status: asString(lastActionResult?.status) ?? "",
      toolName:
        asString(lastActionResult?.toolName) ?? asString(lastActionResult?.name) ?? "",
      resultIdentity:
        asString(lastActionResult?.resultIdentity) ??
        asString(lastActionResult?.callId) ??
        asString(lastActionResult?.id) ??
        "",
    },
    feedback: normalizeAgentFeedbackForLoopGuard(input.reactState),
    waitToken: input.waitToken,
    pendingExecution: normalizeValue(input.pendingExecution),
  };
}

export function stableLoopProgressHash(value: unknown): string {
  return stableJson(value);
}

function normalizeEvidenceEntry(entry: Record<string, unknown>) {
  const target = asRecord(entry.target);
  const claimImpact = asRecord(entry.claimImpact);
  const facts = asRecord(entry.facts);
  return {
    resultIdentity: asString(entry.resultIdentity) ?? "",
    kind: asString(entry.kind) ?? "",
    status: asString(entry.status) ?? "",
    target: {
      type: asString(target?.type) ?? "",
      value: asString(target?.normalizedValue) ?? asString(target?.value) ?? "",
    },
    revision:
      asString(facts?.revision) ??
      asString(facts?.contentRevision) ??
      asString(facts?.expectedRevision) ??
      asString(entry.revision) ??
      "",
    claimImpact: {
      success: asString(claimImpact?.success) ?? "",
      scope: asString(claimImpact?.scope) ?? "",
      target: asString(claimImpact?.target) ?? "",
      requirementIds: asArray(claimImpact?.requirementIds)
        .map(asString)
        .filter((value): value is string => value !== undefined)
        .sort(),
    },
  };
}

function readCapabilityClasses(reactState: Record<string, unknown>): string[] {
  const capabilities = new Set<string>();
  const add = (value: unknown) => {
    for (const item of asArray(value)) {
      const capability = asString(item)?.trim();
      if (capability !== undefined && capability.length > 0) capabilities.add(capability);
    }
  };
  for (const observation of asArray(reactState.observations)) {
    add(asRecord(observation)?.capabilityClasses);
  }
  const lastActionResult = asRecord(reactState.lastActionResult);
  add(lastActionResult?.capabilityClasses);
  for (const item of asArray(lastActionResult?.items)) {
    add(asRecord(item)?.capabilityClasses);
  }
  return [...capabilities].sort((left, right) => left.localeCompare(right));
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "ts" && key !== "timestamp")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeValue(entry)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value)) ?? "";
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
