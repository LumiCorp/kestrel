export type VisibleTodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface VisibleTodoItem {
  id: string;
  text: string;
  status: VisibleTodoStatus;
  note?: string | undefined;
}

export interface VisibleTodoState {
  objective: string;
  items: VisibleTodoItem[];
}

export interface VisibleTodoCompletionAnalysis {
  openItems: VisibleTodoItem[];
  blockedItems: VisibleTodoItem[];
  complete: boolean;
}

export interface VisibleTodoResidualGapData {
  openGap?: string | undefined;
  knownWarnings: string[];
  residualTodoIds: string[];
}

export interface VisibleTodoFinalizeReadinessAnalysis {
  openItems: VisibleTodoItem[];
  actionableOpenItems: VisibleTodoItem[];
  residualOpenItems: VisibleTodoItem[];
  blockingOpenItems: VisibleTodoItem[];
  complete: boolean;
}

export interface VisibleTodoValidationError {
  code: "VISIBLE_TODOS_INVALID";
  message: string;
  path: string;
}

export type VisibleTodoValidationResult =
  | { ok: true; value: VisibleTodoState }
  | { ok: false; error: VisibleTodoValidationError };

type VisibleTodoItemValidationResult =
  | { ok: true; value: VisibleTodoItem }
  | { ok: false; error: VisibleTodoValidationError };

const VALID_TODO_STATUSES = new Set<VisibleTodoStatus>(["pending", "in_progress", "done", "blocked"]);
const MAX_TODO_ITEMS = 40;
const MAX_TODO_TEXT_LENGTH = 1000;
const MAX_TODO_NOTE_LENGTH = 2000;

export const VISIBLE_TODOS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    objective: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TODO_TEXT_LENGTH,
      description: "The concrete requested outcome tracked by this checklist.",
    },
    items: {
      type: "array",
      minItems: 1,
      maxItems: MAX_TODO_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 120 },
          text: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TODO_TEXT_LENGTH,
            description: "Concrete task work, validation, a result, or a blocker. Never use a todo item for closing todos, finalization, or reporting itself.",
          },
          status: { type: "string", enum: ["pending", "in_progress", "done", "blocked"] },
          note: { type: "string", minLength: 1, maxLength: MAX_TODO_NOTE_LENGTH },
        },
        required: ["id", "text", "status"],
      },
    },
  },
  required: ["objective", "items"],
};

export function validateVisibleTodoState(value: unknown): VisibleTodoValidationResult {
  const record = asRecord(value);
  if (record === undefined) {
    return invalid("$", "state.agent.visibleTodos must be an object");
  }
  const rootExtraKey = readUnexpectedKey(record, ["objective", "items"]);
  if (rootExtraKey !== undefined) {
    return invalid(rootExtraKey, "state.agent.visibleTodos contains an unsupported field");
  }
  const objective = normalizeString(record.objective, MAX_TODO_TEXT_LENGTH);
  if (objective === undefined) {
    return invalid("objective", "state.agent.visibleTodos.objective must be a non-empty string");
  }
  if (Array.isArray(record.items) === false) {
    return invalid("items", "state.agent.visibleTodos.items must be an array");
  }
  if (record.items.length < 1 || record.items.length > MAX_TODO_ITEMS) {
    return invalid("items", `state.agent.visibleTodos.items must contain 1-${MAX_TODO_ITEMS} items`);
  }

  const ids = new Set<string>();
  const items: VisibleTodoItem[] = [];
  for (const [index, itemValue] of record.items.entries()) {
    const item = normalizeVisibleTodoItem(itemValue, index);
    if (item.ok === false) {
      return item;
    }
    if (ids.has(item.value.id)) {
      return invalid(`items.${index}.id`, "state.agent.visibleTodos item ids must be unique");
    }
    ids.add(item.value.id);
    items.push(item.value);
  }

  return {
    ok: true,
    value: { objective, items },
  };
}

export function normalizeVisibleTodoState(value: unknown): VisibleTodoState | undefined {
  const result = validateVisibleTodoState(value);
  return result.ok ? result.value : undefined;
}

export function analyzeVisibleTodosCompletion(todos: VisibleTodoState | undefined): VisibleTodoCompletionAnalysis {
  const items = todos?.items ?? [];
  const openItems = items.filter((item) => item.status !== "done");
  const blockedItems = items.filter((item) => item.status === "blocked");
  return {
    openItems,
    blockedItems,
    complete: todos === undefined || openItems.length === 0,
  };
}

export function normalizeVisibleTodoResidualGapData(value: unknown): VisibleTodoResidualGapData | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  const openGap = normalizeString(record.openGap, MAX_TODO_NOTE_LENGTH);
  const knownWarnings = Array.isArray(record.knownWarnings)
    ? record.knownWarnings
        .map((item) => normalizeString(item, MAX_TODO_NOTE_LENGTH))
        .filter((item): item is string => item !== undefined)
    : [];
  if (openGap === undefined && knownWarnings.length === 0) {
    return ;
  }
  const residualTodoIds = Array.isArray(record.residualTodoIds)
    ? record.residualTodoIds
        .map((item) => normalizeString(item, 120))
        .filter((item): item is string => item !== undefined)
    : [];
  return {
    ...(openGap !== undefined ? { openGap } : {}),
    knownWarnings,
    residualTodoIds,
  };
}

export function analyzeVisibleTodoFinalizeReadiness(input: {
  todos: VisibleTodoState | undefined;
  residualGap?: VisibleTodoResidualGapData | undefined;
}): VisibleTodoFinalizeReadinessAnalysis {
  const items = input.todos?.items ?? [];
  const openItems = items.filter((item) => item.status !== "done");
  const actionableOpenItems = openItems.filter((item) =>
    item.status === "pending" || item.status === "in_progress"
  );
  if (input.todos === undefined || openItems.length === 0) {
    return {
      openItems,
      actionableOpenItems,
      residualOpenItems: [],
      blockingOpenItems: actionableOpenItems,
      complete: true,
    };
  }
  if (actionableOpenItems.length > 0 || input.residualGap === undefined) {
    return {
      openItems,
      actionableOpenItems,
      residualOpenItems: [],
      blockingOpenItems: actionableOpenItems.length > 0 ? actionableOpenItems : openItems,
      complete: false,
    };
  }
  const residualGap = input.residualGap;
  const residualIds = new Set(residualGap.residualTodoIds);
  const residualOpenItems = openItems.filter((item) =>
    item.status === "blocked" &&
      (residualIds.size === 0 || residualIds.has(item.id))
  );
  if (residualOpenItems.length !== openItems.length) {
    return {
      openItems,
      actionableOpenItems,
      residualOpenItems,
      blockingOpenItems: openItems.filter((item) =>
        residualOpenItems.some((residual) => residual.id === item.id) === false
      ),
      complete: false,
    };
  }

  return {
    openItems,
    actionableOpenItems,
    residualOpenItems,
    blockingOpenItems: [],
    complete: true,
  };
}

export function renderVisibleTodosForModel(todos: VisibleTodoState | undefined): string | undefined {
  if (todos === undefined) {
    return ;
  }
  const lines = ["Current work:"];
  for (const item of todos.items) {
    const note = item.note !== undefined ? ` - ${item.note}` : "";
    lines.push(`- ${item.status}: ${item.text}${note}`);
  }
  return lines.join("\n");
}

function normalizeVisibleTodoItem(
  value: unknown,
  index: number,
): VisibleTodoItemValidationResult {
  const record = asRecord(value);
  if (record === undefined) {
    return invalid(`items.${index}`, "state.agent.visibleTodos.items[] must be an object");
  }
  const extraKey = readUnexpectedKey(record, ["id", "text", "status", "note"]);
  if (extraKey !== undefined) {
    return invalid(`items.${index}.${extraKey}`, "state.agent.visibleTodos item contains an unsupported field");
  }
  const id = normalizeString(record.id, 120);
  if (id === undefined) {
    return invalid(`items.${index}.id`, "state.agent.visibleTodos item id must be a non-empty string");
  }
  const text = normalizeString(record.text, MAX_TODO_TEXT_LENGTH);
  if (text === undefined) {
    return invalid(`items.${index}.text`, "state.agent.visibleTodos item text must be a non-empty string");
  }
  if (typeof record.status !== "string" || VALID_TODO_STATUSES.has(record.status as VisibleTodoStatus) === false) {
    return invalid(`items.${index}.status`, "state.agent.visibleTodos item status is invalid");
  }
  const note = record.note !== undefined ? normalizeString(record.note, MAX_TODO_NOTE_LENGTH) : undefined;
  if (record.note !== undefined && note === undefined) {
    return invalid(`items.${index}.note`, "state.agent.visibleTodos item note must be a non-empty string");
  }
  return {
    ok: true,
    value: {
      id,
      text,
      status: record.status as VisibleTodoStatus,
      ...(note !== undefined ? { note } : {}),
    },
  };
}

function invalid(path: string, message: string): { ok: false; error: VisibleTodoValidationError } {
  return {
    ok: false,
    error: {
      code: "VISIBLE_TODOS_INVALID",
      message,
      path,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    return ;
  }
  return normalized;
}

function readUnexpectedKey(record: Record<string, unknown>, allowed: string[]): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(record).find((key) => allowedSet.has(key) === false);
}
