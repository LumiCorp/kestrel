export type RuntimeWaitKind = "approval" | "effect" | "region_merge" | "tool" | "user";
export type CanonicalRuntimeWaitKind = "approval" | "tool" | "user";

export interface RuntimeWaitMatcher {
  kind: RuntimeWaitKind;
  eventType: string;
  timeoutMs?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ActiveRuntimeWaitState extends RuntimeWaitMatcher {
  source: "waitingFor";
  resumeStepAgent?: string | undefined;
  resumeToken?: string | undefined;
  reason?: string | undefined;
  blockedAction?: unknown | undefined;
  resumeInstruction?: string | undefined;
}

export interface CanonicalRuntimeWaitingFor {
  kind: CanonicalRuntimeWaitKind;
  eventType: string;
  reason: string;
  resumeInstruction: string;
  blockedAction?: unknown | undefined;
  resumeStepAgent?: string | undefined;
  resumeToken?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ClearRuntimeWaitStateOptions {
  clearConsumedAskUserAction?: boolean | undefined;
}

export function readActiveWaitState(
  reactState: Record<string, unknown> | undefined,
): ActiveRuntimeWaitState | undefined {
  if (reactState === undefined) {
    return undefined;
  }

  return readCanonicalWaitingFor(asRecord(reactState.waitingFor));
}

export function clearRuntimeWaitState(
  reactState: Record<string, unknown>,
  options: ClearRuntimeWaitStateOptions = {},
): Record<string, unknown> {
  const nextAction = asRecord(reactState.nextAction);
  return {
    ...reactState,
    waitingFor: undefined,
    ...(options.clearConsumedAskUserAction === true && nextAction?.kind === "ask_user"
      ? { nextAction: undefined }
      : {}),
  };
}

export function readWaitResumeStepAgent(
  reactState: Record<string, unknown> | undefined,
): string | undefined {
  return readActiveWaitState(reactState)?.resumeStepAgent;
}

export function buildWaitResumeToken(input: {
  waitFor: RuntimeWaitMatcher | undefined;
  resumeStepAgent: string | undefined;
}): string {
  if (input.waitFor === undefined) {
    return "";
  }
  return JSON.stringify({
    kind: input.waitFor.kind,
    eventType: input.waitFor.eventType,
    resumeStepAgent: input.resumeStepAgent ?? "",
    metadata: sortValue(input.waitFor.metadata),
  });
}

export function buildCanonicalWaitingFor(input: {
  waitFor: RuntimeWaitMatcher;
  resumeStepAgent?: string | undefined;
  resumeToken?: string | undefined;
  reason?: string | undefined;
  resumeInstruction?: string | undefined;
  blockedAction?: unknown | undefined;
}): CanonicalRuntimeWaitingFor {
  const metadata = asRecord(input.waitFor.metadata);
  const reason = input.reason ??
    readNonEmptyString(metadata?.reason) ??
    readNonEmptyString(metadata?.prompt) ??
    `${input.waitFor.kind} wait`;
  const resumeInstruction = input.resumeInstruction ??
    readNonEmptyString(metadata?.resumeInstruction) ??
    readNonEmptyString(metadata?.resumeReply) ??
    readNonEmptyString(metadata?.prompt) ??
    `Resume when ${input.waitFor.eventType} is received.`;
  return {
    kind: toCanonicalWaitKind(input.waitFor.kind),
    eventType: input.waitFor.eventType,
    reason,
    resumeInstruction,
    ...(input.blockedAction !== undefined ? { blockedAction: input.blockedAction } : {}),
    ...(input.resumeStepAgent !== undefined ? { resumeStepAgent: input.resumeStepAgent } : {}),
    ...(input.resumeToken !== undefined ? { resumeToken: input.resumeToken } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function readCanonicalWaitingFor(value: Record<string, unknown> | undefined): ActiveRuntimeWaitState | undefined {
  if (value === undefined) {
    return undefined;
  }
  const kind = readWaitKind(value.kind);
  const eventType = readNonEmptyString(value.eventType);
  if (kind === undefined || eventType === undefined) {
    return undefined;
  }
  const timeoutMs = readNonNegativeNumber(value.timeoutMs);
  const metadata = asRecord(value.metadata);
  const resumeStepAgent = readNonEmptyString(value.resumeStepAgent);
  const resumeToken = readNonEmptyString(value.resumeToken);
  const reason = readNonEmptyString(value.reason);
  const resumeInstruction = readNonEmptyString(value.resumeInstruction);
  return {
    source: "waitingFor",
    kind,
    eventType,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(resumeStepAgent !== undefined ? { resumeStepAgent } : {}),
    ...(resumeToken !== undefined ? { resumeToken } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(resumeInstruction !== undefined ? { resumeInstruction } : {}),
    ...(value.blockedAction !== undefined ? { blockedAction: value.blockedAction } : {}),
  };
}

function readWaitKind(value: unknown): RuntimeWaitKind | undefined {
  return value === "approval" || value === "effect" || value === "region_merge" || value === "tool" || value === "user"
    ? value
    : undefined;
}

function toCanonicalWaitKind(kind: RuntimeWaitKind): CanonicalRuntimeWaitKind {
  if (kind === "approval") {
    return "approval";
  }
  if (kind === "user") {
    return "user";
  }
  return "tool";
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}
