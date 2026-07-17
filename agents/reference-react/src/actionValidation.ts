import { asArray, asRecord, asString } from "../../shared/valueAccess.js";
import type { ReactAction } from "./types.js";

export const COMPILED_ACTION_KINDS = [
  "resolve_tool",
  "tool",
  "tool_batch",
  "effect",
  "ask_user",
  "cannot_satisfy",
  "handoff_to_build",
  "finalize",
] as const;

export type CompiledActionKind = (typeof COMPILED_ACTION_KINDS)[number];

export interface CompiledActionValidationFailure {
  code: "DECISION_PARSE_FAILED" | "DECISION_SCHEMA_FAILED";
  schemaCategory: "parse" | "schema";
  message: string;
  details: {
    statePath: string;
    reason: string;
    receivedKind?: string | undefined;
    expectedKinds?: readonly string[] | undefined;
  };
}

export type CompiledActionValidationResult =
  | {
      ok: true;
      action: ReactAction;
      kind: CompiledActionKind;
      executable: boolean;
    }
  | {
      ok: false;
      failure: CompiledActionValidationFailure;
    };

const EXECUTABLE_ACTION_KINDS = new Set<CompiledActionKind>([
  "tool",
  "tool_batch",
  "effect",
  "ask_user",
  "cannot_satisfy",
  "handoff_to_build",
  "finalize",
]);

export function readCompiledActionKind(value: unknown): string | undefined {
  return asString(asRecord(value)?.kind);
}

export function isCompiledExecutableNextAction(value: unknown): boolean {
  const validation = validateCompiledNextAction(value);
  return validation.ok && validation.executable;
}

export function validateCompiledNextAction(value: unknown): CompiledActionValidationResult {
  const record = asRecord(value);
  if (record === undefined) {
    return invalidAction("DECISION_PARSE_FAILED", "parse", {
      statePath: "state.agent.nextAction",
      reason: "missing_compiled_next_action",
      message: "Execution dispatch requires state.agent.nextAction before Acter can run.",
    });
  }

  const kind = asString(record.kind);
  if (kind === undefined || kind.trim().length === 0) {
    return invalidAction("DECISION_PARSE_FAILED", "parse", {
      statePath: "state.agent.nextAction.kind",
      reason: "missing_compiled_next_action_kind",
      message: "Compiled nextAction requires a non-empty kind.",
    });
  }
  if (isCompiledActionKind(kind) === false) {
    return invalidAction("DECISION_SCHEMA_FAILED", "schema", {
      statePath: "state.agent.nextAction.kind",
      reason: "unsupported_compiled_next_action_kind",
      message: `Compiled nextAction kind '${kind}' is unsupported.`,
      receivedKind: kind,
      expectedKinds: COMPILED_ACTION_KINDS,
    });
  }

  const shapeFailure = validateCompiledActionShape(record, kind);
  if (shapeFailure !== undefined) {
    return {
      ok: false,
      failure: shapeFailure,
    };
  }

  return {
    ok: true,
    action: record as unknown as ReactAction,
    kind,
    executable: EXECUTABLE_ACTION_KINDS.has(kind),
  };
}

function validateCompiledActionShape(
  action: Record<string, unknown>,
  kind: CompiledActionKind,
): CompiledActionValidationFailure | undefined {
  if (kind === "resolve_tool") {
    return requireNonEmptyString(action.intent, "state.agent.nextAction.intent");
  }
  if (kind === "tool") {
    return requireNonEmptyString(action.name, "state.agent.nextAction.name") ??
      requireRecord(action.input, "state.agent.nextAction.input");
  }
  if (kind === "tool_batch") {
    const items = asArray(action.items);
    if (items.length === 0) {
      return parseFailure("state.agent.nextAction.items", "invalid_compiled_next_action", "tool_batch action requires at least one item.");
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = asRecord(items[index]);
      if (item === undefined) {
        return parseFailure(`state.agent.nextAction.items[${index}]`, "invalid_compiled_next_action", "tool_batch item must be an object.");
      }
      const itemFailure =
        requireNonEmptyString(item.name, `state.agent.nextAction.items[${index}].name`) ??
        requireRecord(item.input, `state.agent.nextAction.items[${index}].input`);
      if (itemFailure !== undefined) {
        return itemFailure;
      }
    }
    return ;
  }
  if (kind === "effect") {
    return requireNonEmptyString(action.type, "state.agent.nextAction.type") ??
      requireRecord(action.payload, "state.agent.nextAction.payload");
  }
  if (kind === "ask_user") {
    return requireNonEmptyString(action.prompt, "state.agent.nextAction.prompt") ??
      requireRecord(action.waitFor, "state.agent.nextAction.waitFor") ??
      requireNonEmptyString(asRecord(action.waitFor)?.eventType, "state.agent.nextAction.waitFor.eventType");
  }
  if (kind === "cannot_satisfy") {
    return requireNonEmptyString(action.reasonCode, "state.agent.nextAction.reasonCode") ??
      requireNonEmptyString(action.message, "state.agent.nextAction.message");
  }
  if (kind === "handoff_to_build") {
    return requireNonEmptyString(action.message, "state.agent.nextAction.message") ??
      requireRecord(action.continuation, "state.agent.nextAction.continuation");
  }
  return requireRecord(action.input, "state.agent.nextAction.input") ??
    requireNonEmptyString(asRecord(action.input)?.message, "state.agent.nextAction.input.message");
}

function isCompiledActionKind(kind: string): kind is CompiledActionKind {
  return (COMPILED_ACTION_KINDS as readonly string[]).includes(kind);
}

function requireNonEmptyString(value: unknown, statePath: string): CompiledActionValidationFailure | undefined {
  const text = asString(value);
  return text !== undefined && text.trim().length > 0
    ? undefined
    : parseFailure(statePath, "invalid_compiled_next_action", `${statePath} must be a non-empty string.`);
}

function requireRecord(value: unknown, statePath: string): CompiledActionValidationFailure | undefined {
  return asRecord(value) !== undefined
    ? undefined
    : parseFailure(statePath, "invalid_compiled_next_action", `${statePath} must be an object.`);
}

function parseFailure(
  statePath: string,
  reason: string,
  message: string,
): CompiledActionValidationFailure {
  return buildFailure("DECISION_SCHEMA_FAILED", "schema", {
    statePath,
    reason,
    message,
  });
}

function buildFailure(
  code: "DECISION_PARSE_FAILED" | "DECISION_SCHEMA_FAILED",
  schemaCategory: "parse" | "schema",
  input: {
    statePath: string;
    reason: string;
    message: string;
    receivedKind?: string | undefined;
    expectedKinds?: readonly string[] | undefined;
  },
): CompiledActionValidationFailure {
  return {
    code,
    schemaCategory,
    message: input.message,
    details: {
      statePath: input.statePath,
      reason: input.reason,
      ...(input.receivedKind !== undefined ? { receivedKind: input.receivedKind } : {}),
      ...(input.expectedKinds !== undefined ? { expectedKinds: input.expectedKinds } : {}),
    },
  };
}

function invalidAction(
  code: "DECISION_PARSE_FAILED" | "DECISION_SCHEMA_FAILED",
  schemaCategory: "parse" | "schema",
  input: {
    statePath: string;
    reason: string;
    message: string;
    receivedKind?: string | undefined;
    expectedKinds?: readonly string[] | undefined;
  },
): CompiledActionValidationResult {
  return {
    ok: false,
    failure: buildFailure(code, schemaCategory, input),
  };
}
