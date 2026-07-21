import type {
  ModelToolIntent,
  ModelToolSpec,
} from "../../../src/kestrel/contracts/model-io.js";
import {
  normalizeContinuationOffer,
} from "../../../src/runtime/continuationOffer.js";
import {
  buildKestrelAgentToolSurface,
  providerToolAliasForCanonicalName as providerToolAliasForCanonicalNameFromContext,
  type KestrelAgentCannotSatisfyReasonCode,
  type KestrelAgentFinalizeStatus,
  type KestrelAgentToolActionKind,
  type KestrelAgentToolAliasEntry,
  type KestrelAgentToolAliasRegistry,
} from "../../../src/runtime/KestrelAgentContextBuilder.js";
import {
  validateVisibleTodoState,
  type VisibleTodoState,
} from "../../../src/runtime/visibleTodos.js";
import { asRecord, asString } from "../../shared/valueAccess.js";
import type { ReactAction } from "./types.js";

export type ModelToolActionKind = KestrelAgentToolActionKind;

export type ModelToolAliasEntry = KestrelAgentToolAliasEntry;

export type ModelToolAliasRegistry = KestrelAgentToolAliasRegistry;

export interface NormalizedModelToolTurn {
  action?: ReactAction | undefined;
  assistantProgress?: string | undefined;
  visibleTodos?: VisibleTodoState | undefined;
  transcriptToolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string | undefined }>;
  provenance: {
    providerToolCallIds: string[];
    providerNames: string[];
    canonicalNames: string[];
  };
}

export class ModelToolCallActionError extends Error {
  readonly code: "MODEL_TOOL_CALL_INVALID";
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = "MODEL_TOOL_CALL_INVALID";
    this.details = details;
  }
}

export function buildModelToolAliasRegistry(
  workspaceTools: ModelToolSpec[],
  options: {
    controlToolNames?: readonly string[] | undefined;
    finalizeStatuses?: readonly KestrelAgentFinalizeStatus[] | undefined;
    cannotSatisfyReasonCodes?: readonly KestrelAgentCannotSatisfyReasonCode[] | undefined;
  } = {},
): ModelToolAliasRegistry {
  return buildKestrelAgentToolSurface({
    workspaceTools,
    controlToolNames: options.controlToolNames,
    finalizeStatuses: options.finalizeStatuses,
    cannotSatisfyReasonCodes: options.cannotSatisfyReasonCodes,
  });
}

export const providerToolAliasForCanonicalName = providerToolAliasForCanonicalNameFromContext;

const DEFAULT_ASSISTANT_PROGRESS = "I’m continuing the requested work.";

export function normalizeModelToolCallsToAgentTurn(input: {
  toolIntents: ModelToolIntent[];
  aliasRegistry: ModelToolAliasRegistry;
  sourceRunId: string;
}): NormalizedModelToolTurn {
  if (input.toolIntents.length === 0) {
    throw new ModelToolCallActionError(
      "No tool call was returned. If the work is finished, call kestrel_finalize with a user-facing summary. Otherwise call the next workspace tool.",
      {
      reason: "missing_model_tool_call",
      },
    );
  }

  const providerToolCallIds = input.toolIntents.flatMap((intent) => intent.id !== undefined ? [intent.id] : []);
  const providerNames = input.toolIntents.map((intent) => intent.name);
  const canonicalNames: string[] = [];
  const transcriptToolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string | undefined }> = [];
  const workspaceActions: Array<{ name: string; input: Record<string, unknown> }> = [];
  const terminalActions: ReactAction[] = [];
  let visibleTodos: VisibleTodoState | undefined;
  let assistantProgress: string | undefined;

  for (const [index, intent] of input.toolIntents.entries()) {
    const entry = input.aliasRegistry.byProviderName.get(intent.name);
    if (entry === undefined) {
      throw new ModelToolCallActionError(`Unknown model tool '${intent.name}'.`, {
        reason: "unknown_model_tool_alias",
        providerName: intent.name,
        index,
      });
    }
    canonicalNames.push(entry.canonicalName);
    const progress = asString(intent.input.assistantProgress)?.trim();
    const requiresAssistantProgress = entry.canonicalName !== "kestrel.finalize" &&
      entry.canonicalName !== "kestrel.cannot_satisfy" &&
      entry.canonicalName !== "kestrel.ask_user" &&
      entry.canonicalName !== "kestrel.switch_mode";
    const { assistantProgress: _assistantProgress, ...toolInput } = intent.input;
    if (
      assistantProgress === undefined &&
      requiresAssistantProgress &&
      progress !== undefined &&
      progress.length > 0 &&
      progress.length <= 600
    ) {
      assistantProgress = progress;
    }
    transcriptToolCalls.push({
      name: entry.canonicalName,
      input: toolInput,
      ...(intent.id !== undefined ? { id: intent.id } : {}),
    });
    if (entry.kind === "workspace") {
      workspaceActions.push({
        name: entry.canonicalName,
        input: toolInput,
      });
      continue;
    }
    if (entry.canonicalName === "kestrel.todo_update") {
      const todoResult = validateVisibleTodoState(toolInput);
      if (todoResult.ok === false) {
        throw new ModelToolCallActionError(todoResult.error.message, {
          reason: "invalid_visible_todos",
          path: `toolCalls[${index}].input.${todoResult.error.path}`,
        });
      }
      visibleTodos = todoResult.value;
      continue;
    }
    terminalActions.push(normalizeControlToolCall({
      canonicalName: entry.canonicalName,
      input: toolInput,
      inputSchema: entry.inputSchema,
      sourceRunId: input.sourceRunId,
      index,
    }));
  }

  if (terminalActions.length > 1) {
    throw new ModelToolCallActionError("Only one terminal control tool may be called in a turn.", {
      reason: "multiple_terminal_control_tools",
      canonicalNames,
    });
  }
  if (terminalActions.length === 1 && workspaceActions.length > 0) {
    throw new ModelToolCallActionError("Terminal control tools cannot be mixed with workspace tool calls.", {
      reason: "terminal_control_mixed_with_workspace_tools",
      canonicalNames,
    });
  }

  const terminalAction = terminalActions[0];
  const singleWorkspaceAction = workspaceActions.length === 1 ? workspaceActions[0] : undefined;
  const action = terminalAction ??
    (workspaceActions.length === 0
      ? undefined
      : singleWorkspaceAction !== undefined
        ? {
            kind: "tool" as const,
            name: singleWorkspaceAction.name,
            input: singleWorkspaceAction.input,
          }
        : {
            kind: "tool_batch" as const,
            items: workspaceActions.map((item) => ({
              name: item.name,
              input: item.input,
            })),
          });
  if (action === undefined && visibleTodos === undefined) {
    throw new ModelToolCallActionError("Model tool call turn did not include an executable action or todo update.", {
      reason: "no_executable_action",
      canonicalNames,
    });
  }

  if (assistantProgress === undefined && terminalAction === undefined) {
    assistantProgress = DEFAULT_ASSISTANT_PROGRESS;
  }

  return {
    ...(action !== undefined ? { action } : {}),
    ...(assistantProgress !== undefined ? { assistantProgress } : {}),
    ...(visibleTodos !== undefined ? { visibleTodos } : {}),
    transcriptToolCalls,
    provenance: {
      providerToolCallIds,
      providerNames,
      canonicalNames,
    },
  };
}

function normalizeControlToolCall(input: {
  canonicalName: string;
  input: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  sourceRunId: string;
  index: number;
}): ReactAction {
  if (input.canonicalName === "kestrel.finalize") {
    const status = asString(input.input.status);
    const message = asString(input.input.message);
    if (status !== "goal_satisfied" && status !== "out_of_scope") {
      throw invalidControlInput(input, "kestrel.finalize requires status goal_satisfied or out_of_scope.", "status");
    }
    if (message === undefined || message.trim().length === 0) {
      throw invalidControlInput(input, "kestrel.finalize requires a non-empty message.", "message");
    }
    const data = asRecord(input.input.data);
    return {
      kind: "finalize",
      finalizeReason: status,
      input: {
        message,
        ...(data !== undefined ? { data } : {}),
      },
    };
  }
  if (input.canonicalName === "kestrel.ask_user") {
    const prompt = asString(input.input.prompt);
    if (prompt === undefined || prompt.trim().length === 0) {
      throw invalidControlInput(input, "kestrel.ask_user requires a non-empty prompt.", "prompt");
    }
    return {
      kind: "ask_user",
      prompt,
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          waitContractVersion: 1,
          reason: "model_requested_clarification",
          prompt,
        },
      },
    };
  }
  if (input.canonicalName === "kestrel.cannot_satisfy") {
    const reasonCode = asString(input.input.reasonCode);
    const message = asString(input.input.message);
    const allowedReasonCodes = readAdvertisedStringEnum(input.inputSchema, "reasonCode")
      ?.filter(isCannotSatisfyReasonCode);
    if (reasonCode === undefined || isCannotSatisfyReasonCode(reasonCode) === false) {
      throw invalidControlInput(input, "kestrel.cannot_satisfy reasonCode is invalid.", "reasonCode");
    }
    if (
      allowedReasonCodes !== undefined &&
      allowedReasonCodes.length > 0 &&
      allowedReasonCodes.includes(reasonCode) === false
    ) {
      throw invalidControlInput(input, "kestrel.cannot_satisfy reasonCode is invalid.", "reasonCode");
    }
    if (message === undefined || message.trim().length === 0) {
      throw invalidControlInput(input, "kestrel.cannot_satisfy requires a non-empty message.", "message");
    }
    const details = asRecord(input.input.details);
    return {
      kind: "cannot_satisfy",
      reasonCode,
      message,
      ...(details !== undefined ? { details } : {}),
    };
  }
  if (input.canonicalName === "kestrel.handoff_to_build") {
    const message = asString(input.input.message);
    const continuationInput = asRecord(input.input.continuation);
    if (message === undefined || message.trim().length === 0) {
      throw invalidControlInput(input, "kestrel.handoff_to_build requires a non-empty message.", "message");
    }
    if (continuationInput === undefined) {
      throw invalidControlInput(input, "kestrel.handoff_to_build requires continuation.", "continuation");
    }
    const continuation = normalizeContinuationOffer({
      ...continuationInput,
      version: "continuation_offer_v1",
      kind: "implementation",
      requiredMode: "build",
      sourceRunId: input.sourceRunId,
    }, input.sourceRunId);
    if (continuation === undefined) {
      throw invalidControlInput(input, "kestrel.handoff_to_build continuation is invalid.", "continuation");
    }
    const data = asRecord(input.input.data);
    return {
      kind: "handoff_to_build",
      message,
      continuation,
      ...(data !== undefined ? { data } : {}),
    };
  }
  if (input.canonicalName === "kestrel.switch_mode") {
    const mode = asString(input.input.mode);
    const message = asString(input.input.message);
    if (mode !== "chat" && mode !== "plan" && mode !== "build") {
      throw invalidControlInput(input, "kestrel.switch_mode mode is invalid.", "mode");
    }
    if (message === undefined || message.trim().length === 0) {
      throw invalidControlInput(input, "kestrel.switch_mode requires a non-empty message.", "message");
    }
    return {
      kind: "switch_mode",
      mode,
      message,
    };
  }
  throw new ModelToolCallActionError(`Unsupported control tool '${input.canonicalName}'.`, {
    reason: "unsupported_control_tool",
    canonicalName: input.canonicalName,
  });
}

function readAdvertisedStringEnum(
  inputSchema: Record<string, unknown>,
  propertyName: string,
): string[] | undefined {
  const properties = asRecord(inputSchema.properties);
  const property = asRecord(properties?.[propertyName]);
  const values = Array.isArray(property?.enum)
    ? property.enum.map((item) => asString(item)).filter((item): item is string => item !== undefined)
    : undefined;
  return values !== undefined && values.length > 0 ? values : undefined;
}

function isCannotSatisfyReasonCode(value: string): value is KestrelAgentCannotSatisfyReasonCode {
  return value === "unsatisfied_by_available_tools" ||
    value === "insufficient_horizon" ||
    value === "missing_required_capability" ||
    value === "need_user_choice" ||
    value === "requested_tool_unavailable";
}

function invalidControlInput(
  input: { canonicalName: string; index: number },
  message: string,
  field: string,
): ModelToolCallActionError {
  return new ModelToolCallActionError(message, {
    reason: "invalid_control_tool_input",
    canonicalName: input.canonicalName,
    path: `toolCalls[${input.index}].input.${field}`,
  });
}
