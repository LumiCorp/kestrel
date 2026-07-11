import type { ToolExecutionClass } from "../mode/contracts.js";

export interface OperatorControlPolicyFields {
  allowToolClasses?: ToolExecutionClass[] | undefined;
  allowCapabilities?: string[] | undefined;
}

export type OperatorControlPolicyParseResult =
  | {
      ok: true;
      value: OperatorControlPolicyFields;
    }
  | {
      ok: false;
      field: "allowToolClasses" | "allowCapabilities";
      message: string;
    };

export function parseOperatorControlPolicyFields(input: {
  allowToolClasses?: unknown;
  allowCapabilities?: unknown;
}): OperatorControlPolicyParseResult {
  const allowToolClasses = parseToolClasses(input.allowToolClasses);
  if (allowToolClasses.ok === false) {
    return allowToolClasses;
  }
  const allowCapabilities = parseCapabilities(input.allowCapabilities);
  if (allowCapabilities.ok === false) {
    return allowCapabilities;
  }
  return {
    ok: true,
    value: {
      ...(allowToolClasses.value !== undefined ? { allowToolClasses: allowToolClasses.value } : {}),
      ...(allowCapabilities.value !== undefined ? { allowCapabilities: allowCapabilities.value } : {}),
    },
  };
}

function parseToolClasses(value: unknown): {
  ok: true;
  value: ToolExecutionClass[] | undefined;
} | {
  ok: false;
  field: "allowToolClasses";
  message: string;
} {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (Array.isArray(value) === false) {
    return {
      ok: false,
      field: "allowToolClasses",
      message: "allowToolClasses must be an array when present",
    };
  }
  const parsed: ToolExecutionClass[] = [];
  for (const entry of value) {
    if (
      entry !== "read_only" &&
      entry !== "planning_write" &&
      entry !== "sandboxed_only" &&
      entry !== "external_side_effect"
    ) {
      return {
        ok: false,
        field: "allowToolClasses",
        message: "allowToolClasses contains an invalid tool class",
      };
    }
    parsed.push(entry);
  }
  return { ok: true, value: parsed };
}

function parseCapabilities(value: unknown): {
  ok: true;
  value: string[] | undefined;
} | {
  ok: false;
  field: "allowCapabilities";
  message: string;
} {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (Array.isArray(value) === false) {
    return {
      ok: false,
      field: "allowCapabilities",
      message: "allowCapabilities must be an array when present",
    };
  }
  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return {
        ok: false,
        field: "allowCapabilities",
        message: "allowCapabilities must contain non-empty strings",
      };
    }
    parsed.push(entry);
  }
  return { ok: true, value: parsed };
}
