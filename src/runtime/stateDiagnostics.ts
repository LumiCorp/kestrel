import type { RunEvent } from "../kestrel/contracts/events.js";
import { readActiveWaitState } from "./waitState.js";

export interface RuntimeStateDiagnosticInput {
  sessionId: string;
  runId: string;
  version: number;
  expectedVersion?: number | undefined;
  snapshotKind?: "full" | "delta" | undefined;
  stepAgent?: string | undefined;
  nextStepAgent?: string | undefined;
  stepIndex?: number | undefined;
  state: Record<string, unknown>;
  statePatch?: Record<string, unknown> | undefined;
}

export function buildRuntimeStatePersistedEvent(input: RuntimeStateDiagnosticInput): RunEvent {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    type: "runtime.state_persisted",
    level: "INFO",
    timestamp: new Date().toISOString(),
    metadata: buildRuntimeStateDiagnosticMetadata(input),
  };
}

export function buildRuntimeStateDiagnosticMetadata(
  input: RuntimeStateDiagnosticInput,
): Record<string, unknown> {
  const agent = asRecord(input.state.agent);
  const exec = asRecord(agent?.exec);
  const wait = readActiveWaitState(agent);
  const nextAction = agent?.nextAction;
  const nextActionRecord = asRecord(nextAction);
  const pendingApproval = exec?.pendingApproval;
  const pendingApprovalRecord = asRecord(pendingApproval);
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    version: input.version,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    ...(input.snapshotKind !== undefined ? { snapshotKind: input.snapshotKind } : {}),
    ...(input.stepAgent !== undefined ? { stepAgent: input.stepAgent } : {}),
    ...(input.nextStepAgent !== undefined ? { nextStepAgent: input.nextStepAgent } : {}),
    agentNextActionShape: describeValueShape(nextAction),
    ...(typeof nextActionRecord?.kind === "string" ? { agentNextActionKind: nextActionRecord.kind } : {}),
    ...(typeof nextActionRecord?.name === "string" ? { agentNextActionName: nextActionRecord.name } : {}),
    pendingApprovalPresent: pendingApproval !== undefined,
    pendingApprovalShape: describeValueShape(pendingApproval),
    ...(typeof pendingApprovalRecord?.purpose === "string"
      ? { pendingApprovalPurpose: pendingApprovalRecord.purpose }
      : {}),
    waitShape: describeValueShape(wait),
    ...(wait?.source !== undefined ? { waitSource: wait.source } : {}),
    ...(wait?.kind !== undefined ? { waitKind: wait.kind } : {}),
    ...(wait?.eventType !== undefined ? { waitEventType: wait.eventType } : {}),
    statePatchKeys: Object.keys(input.statePatch ?? {}).sort((left, right) => left.localeCompare(right)),
  };
}

export function readInvalidStatePath(error: { details?: Record<string, unknown> } | undefined): string | undefined {
  return typeof error?.details?.path === "string" ? error.details.path : undefined;
}

function describeValueShape(value: unknown): string {
  if (value === undefined) {
    return "absent";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}
