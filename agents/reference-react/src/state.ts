import { readAgentState } from "../../../src/runtime/state.js";
import type {
  RuntimeAgentState,
  RuntimeCanonicalWaitingForState,
} from "../../../src/runtime/state.js";

import type {
  ReactAction,
  ReactExecState,
  ReactTerminalState,
  ReactWaitState,
} from "./types.js";

type ReferenceReactStateRecord = Record<string, unknown>;

export interface ReferenceReactTerminalPatch extends Partial<ReactTerminalState> {
  message?: string | undefined;
}

export interface ReferenceReactAgentState extends Omit<
  RuntimeAgentState,
  "exec" | "waitingFor" | "terminal" | "nextAction" | "lastAction"
> {
  exec: ReactExecState;
  nextAction?: ReactAction | ReferenceReactStateRecord | undefined;
  lastAction?: ReactAction | ReferenceReactStateRecord | undefined;
  lastActionResult?: unknown;
  waitingFor?: ReactWaitState | RuntimeCanonicalWaitingForState | ReferenceReactStateRecord | undefined;
  terminal?: ReferenceReactTerminalPatch | undefined;
  finalOutput?: unknown;
  retryContext?: ReferenceReactStateRecord | undefined;
}

export type ReferenceReactExecStatePatch = Partial<ReactExecState>;

/**
 * Returns the mutable local agent loop slice from session state.
 * This keeps the runtime contract unchanged while enforcing basic shape.
 */
export function getAgentState(value: unknown): ReferenceReactAgentState {
  const record =
    typeof value === "object" && value !== null && Array.isArray(value) === false
      ? (value as Record<string, unknown>)
      : {};
  const agent = readAgentState({
    runtime: {
      schemaVersion: 1,
    },
    agent: record,
  }) as ReferenceReactAgentState;
  return {
    ...agent,
    ...(Array.isArray(record.evidenceLedger) ? { evidenceLedger: record.evidenceLedger } : {}),
  } as ReferenceReactAgentState;
}

export function getAgentStateFromRuntimeState(value: unknown): ReferenceReactAgentState {
  const state =
    typeof value === "object" && value !== null && Array.isArray(value) === false
      ? (value as Record<string, unknown>)
      : {};
  const agent = getAgentState(state.agent);
  const agentRecord =
    typeof state.agent === "object" && state.agent !== null && Array.isArray(state.agent) === false
      ? (state.agent as Record<string, unknown>)
      : {};
  const evidenceLedger = Array.isArray(state.evidenceLedger)
    ? state.evidenceLedger
    : Array.isArray(agentRecord.evidenceLedger)
      ? agentRecord.evidenceLedger
    : undefined;
  return {
    ...agent,
    ...(evidenceLedger !== undefined ? { evidenceLedger } : {}),
  } as ReferenceReactAgentState;
}

export function createReferenceReactNextActionPatch(
  nextAction: ReferenceReactAgentState["nextAction"],
): Pick<ReferenceReactAgentState, "nextAction"> {
  return { nextAction };
}

export function createReferenceReactLastActionResultPatch(
  lastActionResult: ReferenceReactAgentState["lastActionResult"],
): Pick<ReferenceReactAgentState, "lastActionResult"> {
  return { lastActionResult };
}

export function createReferenceReactWaitingForPatch(
  waitingFor: ReferenceReactAgentState["waitingFor"],
): Pick<ReferenceReactAgentState, "waitingFor"> {
  return { waitingFor };
}

export function createReferenceReactTerminalPatch(
  terminal: ReferenceReactAgentState["terminal"],
): Pick<ReferenceReactAgentState, "terminal"> {
  return { terminal };
}

export function createReferenceReactFinalOutputPatch(
  finalOutput: ReferenceReactAgentState["finalOutput"],
): Pick<ReferenceReactAgentState, "finalOutput"> {
  return { finalOutput };
}

export function createReferenceReactRetryContextPatch(
  retryContext: ReferenceReactAgentState["retryContext"],
): Pick<ReferenceReactAgentState, "retryContext"> {
  return { retryContext };
}

export function applyReferenceReactExecPatch(
  reactPatch: ReferenceReactStateRecord,
  execPatch: ReferenceReactExecStatePatch,
): ReferenceReactAgentState {
  const baseState = getAgentState(reactPatch);
  return {
    ...baseState,
    exec: {
      ...baseState.exec,
      ...execPatch,
    },
  };
}
