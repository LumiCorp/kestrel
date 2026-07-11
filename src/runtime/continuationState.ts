import {
  type ContinuationOfferV1,
  type ContinuationRequiredMode,
  type ContinuationRequiredToolClass,
} from "./continuationOffer.js";

export type RuntimeContinuationStatus =
  | "awaiting_user"
  | "approved"
  | "executing"
  | "invalidated"
  | "completed";

export type RuntimeContinuationInvalidationReason =
  | "missing_continuation"
  | "missing_plan_document"
  | "continuation_id_mismatch"
  | "continuation_already_consumed";

export interface RuntimeContinuationStateV1 {
  version: "runtime_continuation_v1";
  id: string;
  kind: "implementation";
  objective: string;
  requiredToolClass: ContinuationRequiredToolClass;
  requiredCapabilities: string[];
  requiredMode: ContinuationRequiredMode;
  sourceRunId: string;
  resumeStepAgent: string;
  status: RuntimeContinuationStatus;
  createdAt: string;
  resumeMessage?: string | undefined;
  planDocumentPath?: string | undefined;
  workspaceRoot?: string | undefined;
  proposedNextAction?: string | undefined;
  handoffMessage?: string | undefined;
  invalidatedAt?: string | undefined;
  invalidationReason?: RuntimeContinuationInvalidationReason | undefined;
}

export function createRuntimeContinuationState(input: {
  offer: ContinuationOfferV1;
  resumeStepAgent: string;
  createdAt?: string | undefined;
  planDocumentPath?: string | undefined;
  workspaceRoot?: string | undefined;
  proposedNextAction?: string | undefined;
  handoffMessage?: string | undefined;
}): RuntimeContinuationStateV1 {
  return {
    version: "runtime_continuation_v1",
    id: buildRuntimeContinuationId(input.offer.sourceRunId),
    kind: "implementation",
    objective: input.offer.objective,
    requiredToolClass: input.offer.requiredToolClass,
    requiredCapabilities: [...input.offer.requiredCapabilities],
    requiredMode: input.offer.requiredMode,
    sourceRunId: input.offer.sourceRunId,
    resumeStepAgent: input.resumeStepAgent,
    status: "awaiting_user",
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.offer.resumeMessage !== undefined ? { resumeMessage: input.offer.resumeMessage } : {}),
    ...(input.planDocumentPath !== undefined ? { planDocumentPath: input.planDocumentPath } : {}),
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.proposedNextAction !== undefined ? { proposedNextAction: input.proposedNextAction } : {}),
    ...(input.handoffMessage !== undefined ? { handoffMessage: input.handoffMessage } : {}),
  };
}

export function normalizeRuntimeContinuationState(
  value: unknown,
): RuntimeContinuationStateV1 | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const version = readString(record.version);
  const id = readNonEmptyString(record.id);
  const kind = readString(record.kind);
  const objective = readNonEmptyString(record.objective);
  const requiredToolClass = readToolExecutionClass(record.requiredToolClass);
  const requiredCapabilities = readStringArray(record.requiredCapabilities);
  const requiredMode = readRequiredMode(record.requiredMode);
  const sourceRunId = readNonEmptyString(record.sourceRunId);
  const resumeStepAgent = readNonEmptyString(record.resumeStepAgent);
  const status = readRuntimeContinuationStatus(record.status);
  const createdAt = readNonEmptyString(record.createdAt);
  if (
    version !== "runtime_continuation_v1" ||
    kind !== "implementation" ||
    id === undefined ||
    objective === undefined ||
    requiredToolClass === undefined ||
    requiredMode === undefined ||
    sourceRunId === undefined ||
    resumeStepAgent === undefined ||
    status === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }

  return {
    version: "runtime_continuation_v1",
    id,
    kind: "implementation",
    objective,
    requiredToolClass,
    requiredCapabilities,
    requiredMode,
    sourceRunId,
    resumeStepAgent,
    status,
    createdAt,
    ...(readNonEmptyString(record.resumeMessage) !== undefined
      ? { resumeMessage: readNonEmptyString(record.resumeMessage) }
      : {}),
    ...(readNonEmptyString(record.planDocumentPath) !== undefined
      ? { planDocumentPath: readNonEmptyString(record.planDocumentPath) }
      : {}),
    ...(readNonEmptyString(record.workspaceRoot) !== undefined
      ? { workspaceRoot: readNonEmptyString(record.workspaceRoot) }
      : {}),
    ...(readNonEmptyString(record.proposedNextAction) !== undefined
      ? { proposedNextAction: readNonEmptyString(record.proposedNextAction) }
      : {}),
    ...(readNonEmptyString(record.handoffMessage) !== undefined
      ? { handoffMessage: readNonEmptyString(record.handoffMessage) }
      : {}),
    ...(readNonEmptyString(record.invalidatedAt) !== undefined
      ? { invalidatedAt: readNonEmptyString(record.invalidatedAt) }
      : {}),
    ...(readInvalidationReason(record.invalidationReason) !== undefined
      ? { invalidationReason: readInvalidationReason(record.invalidationReason) }
      : {}),
  };
}

export function continuationStateToOffer(
  value: RuntimeContinuationStateV1,
): ContinuationOfferV1 {
  return {
    version: "continuation_offer_v1",
    kind: "implementation",
    objective: value.objective,
    requiredToolClass: value.requiredToolClass,
    requiredCapabilities: [...value.requiredCapabilities],
    requiredMode: value.requiredMode,
    sourceRunId: value.sourceRunId,
    ...(value.resumeMessage !== undefined ? { resumeMessage: value.resumeMessage } : {}),
  };
}

export function approveRuntimeContinuation(
  value: RuntimeContinuationStateV1,
): RuntimeContinuationStateV1 {
  return {
    ...value,
    status: "approved",
    invalidatedAt: undefined,
    invalidationReason: undefined,
  };
}

export function invalidateRuntimeContinuation(
  value: RuntimeContinuationStateV1,
  reason: RuntimeContinuationInvalidationReason,
): RuntimeContinuationStateV1 {
  return {
    ...value,
    status: "invalidated",
    invalidationReason: reason,
    invalidatedAt: new Date().toISOString(),
  };
}

export function buildRuntimeContinuationId(sourceRunId: string): string {
  return `continuation:${sourceRunId}`;
}

function readRuntimeContinuationStatus(value: unknown): RuntimeContinuationStatus | undefined {
  return value === "awaiting_user" ||
      value === "approved" ||
      value === "executing" ||
      value === "invalidated" ||
      value === "completed"
    ? value
    : undefined;
}

function readToolExecutionClass(value: unknown): ContinuationRequiredToolClass | undefined {
  return value === "read_only" ||
      value === "sandboxed_only" ||
      value === "external_side_effect"
    ? value
    : undefined;
}

function readRequiredMode(value: unknown): ContinuationRequiredMode | undefined {
  return value === "plan" || value === "build" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((item) => readNonEmptyString(item))
    .filter((item): item is string => item !== undefined);
}

function readInvalidationReason(value: unknown): RuntimeContinuationInvalidationReason | undefined {
  return value === "missing_continuation" ||
      value === "missing_plan_document" ||
      value === "continuation_id_mismatch" ||
      value === "continuation_already_consumed"
    ? value
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  const text = readString(value)?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
