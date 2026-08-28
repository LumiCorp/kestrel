import type {
  RuntimeError,
  StateNodeRef,
} from "../kestrel/contracts/base.js";
import {
  parseRunnerInteractionRequest,
  parseRunnerHostedToolApprovalInteractionV4,
  parseRunnerLocalToolApprovalInteractionV1,
} from "@kestrel-agents/protocol";
import { canonicalJson } from "../kestrel/contracts/tool-contract.js";
import { parseDurablePreparedToolCallV1 } from "../kestrel/contracts/tool-invocation.js";
import {
  projectHostedToolApprovalInteractionV4,
  projectLocalToolApprovalInteractionV1,
} from "./assistantResponseContract.js";
import {
  normalizeVisibleTodoState,
  validateVisibleTodoState,
  type VisibleTodoState,
} from "./visibleTodos.js";
import {
  normalizeModelTranscript,
  validateModelTranscript,
  type ModelTranscript,
} from "./modelTranscript.js";
import {
  normalizeRuntimePlanDocumentSnapshot,
  normalizeRuntimePlanState,
  validateRuntimePlanState,
  type RuntimePlanDocumentSnapshot,
  type RuntimePlanState,
} from "./planDocument.js";
import {
  readActiveTurnIntent,
  type ActiveTurnIntentV1,
} from "./turnObjective.js";

export const CURRENT_RUNTIME_STATE_SCHEMA_VERSION = 2;

export interface RuntimeMetadataState {
  schemaVersion: number;
  migratedAt?: string | undefined;
}

export interface RuntimeExecState {
  substate?: string | undefined;
  pendingToolCall?: Record<string, unknown> | undefined;
  pendingBatch?: Record<string, unknown> | undefined;
  pendingApproval?: Record<string, unknown> | undefined;
  pendingAction?: Record<string, unknown> | undefined;
  pendingEffectKey?: string | undefined;
  pendingEffectType?: string | undefined;
}

export interface RuntimeWaitState {
  kind?: string | undefined;
  eventType?: string | undefined;
  timeoutMs?: number | undefined;
  resumeStepAgent?: string | undefined;
  resumeToken?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  interaction?: import("../kestrel/contracts/execution.js").RuntimeInteractionRequest | undefined;
}

export interface RuntimeCanonicalWaitingForState {
  kind?: string | undefined;
  eventType?: string | undefined;
  timeoutMs?: number | undefined;
  reason?: string | undefined;
  resumeInstruction?: string | undefined;
  resumeStepAgent?: string | undefined;
  resumeToken?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  interaction?: import("../kestrel/contracts/execution.js").RuntimeInteractionRequest | undefined;
  blockedAction?: unknown | undefined;
}

export interface RuntimeTerminalState {
  status?: string | undefined;
  reasonCode?: string | undefined;
  finalStepAgent?: string | undefined;
  finalizedAt?: string | undefined;
  outputRef?: string | undefined;
}

export interface RuntimeAgentState extends Record<string, unknown> {
  observations: unknown[];
  exec: RuntimeExecState;
  assistantText: string | null;
  waitingFor?: RuntimeCanonicalWaitingForState | undefined;
  terminal?: RuntimeTerminalState | undefined;
  lastAction?: Record<string, unknown> | undefined;
  lastActionResult?: unknown;
  retryContext?: Record<string, unknown> | undefined;
  plan?: RuntimePlanState | undefined;
  planDocument?: RuntimePlanDocumentSnapshot | undefined;
  visibleTodos?: VisibleTodoState | undefined;
  modelTranscript?: ModelTranscript | undefined;
  activeTurnIntent?: ActiveTurnIntentV1 | undefined;
}

export interface DecodedRuntimeSessionState extends Record<string, unknown> {
  runtime: RuntimeMetadataState;
  agent: RuntimeAgentState;
  evidenceLedger?: unknown[] | undefined;
  region?: Record<string, unknown> | undefined;
  memory?: Record<string, unknown> | undefined;
  stateNode?: StateNodeRef | undefined;
}

const EXEC_SUBSTATES = new Set([
  "dispatch",
  "wait_effect",
  "wait_approval",
  "wait_user",
  "collect",
  "finalize",
]);

const TERMINAL_STATUSES = new Set(["WAITING", "COMPLETED", "FAILED"]);

export function decodeRuntimeSessionState(
  state: Record<string, unknown>,
): DecodedRuntimeSessionState {
  return serializeRuntimeSessionState(state);
}

export function migrateLegacyRuntimeState(
  state: DecodedRuntimeSessionState,
): DecodedRuntimeSessionState {
  if (hasLegacyRuntimeState(state) === false) {
    return {
      ...state,
      runtime: {
        schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
        ...(typeof state.runtime.migratedAt === "string"
          ? { migratedAt: state.runtime.migratedAt }
          : {}),
      },
    };
  }

  const agent = state.agent;
  const exec = {
    ...agent.exec,
    ...(typeof agent.pendingEffectKey === "string"
      ? { pendingEffectKey: agent.pendingEffectKey }
      : {}),
    ...(typeof agent.pendingEffectType === "string"
      ? { pendingEffectType: agent.pendingEffectType }
      : {}),
    ...(asRecord(agent.pendingApproval) !== undefined
      ? { pendingApproval: asRecord(agent.pendingApproval) }
      : {}),
    ...(asRecord(agent.pendingToolBatch) !== undefined
      ? { pendingBatch: asRecord(agent.pendingToolBatch) }
      : {}),
    ...(asRecord(agent.pendingToolCall) !== undefined
      ? { pendingToolCall: asRecord(agent.pendingToolCall) }
      : {}),
  };

  return {
    ...state,
    runtime: {
      schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
      ...(typeof state.runtime.migratedAt === "string"
        ? { migratedAt: state.runtime.migratedAt }
        : { migratedAt: new Date().toISOString() }),
    },
    agent: {
      ...agent,
      assistantText: null,
      exec,
      pendingEffectKey: undefined,
      pendingEffectType: undefined,
      pendingApproval: undefined,
      pendingToolBatch: undefined,
      pendingToolCall: undefined,
    },
  };
}

export function serializeRuntimeSessionState(
  state: Record<string, unknown>,
): DecodedRuntimeSessionState {
  const parsed = parseRuntimeSessionState(state);
  const migrated = migrateLegacyRuntimeState(parsed);
  return {
    ...migrated,
    runtime: {
      schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
      ...(typeof migrated.runtime.migratedAt === "string"
        ? { migratedAt: migrated.runtime.migratedAt }
        : {}),
    },
  };
}

export function validateRuntimeSessionState(state: Record<string, unknown>): RuntimeError | undefined {
  const runtime = asRecord(state.runtime);
  if (runtime === undefined) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.runtime is required",
    };
  }
  if (typeof runtime.schemaVersion !== "number" || Number.isFinite(runtime.schemaVersion) === false) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.runtime.schemaVersion must be a finite number",
    };
  }
  if (Math.trunc(runtime.schemaVersion) !== CURRENT_RUNTIME_STATE_SCHEMA_VERSION) {
    return {
      code: "RUNTIME_STATE_VERSION_UNSUPPORTED",
      message: `Unsupported runtime state schema version '${String(runtime.schemaVersion)}'`,
      details: {
        expectedVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
        actualVersion: runtime.schemaVersion,
      },
    };
  }

  const agent = asRecord(state.agent);
  if (agent === undefined) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent is required",
    };
  }

  if (Array.isArray(agent.observations) === false) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.observations must be an array",
    };
  }
  if (asRecord(agent.exec) === undefined) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.exec must be an object",
      details: {
        path: "state.agent.exec",
      },
    };
  }
  if (
    agent.assistantText !== null &&
    (typeof agent.assistantText !== "string" || agent.assistantText.trim().length === 0)
  ) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.assistantText must be null or a non-empty string",
      details: {
        path: "state.agent.assistantText",
      },
    };
  }
  if (agent.nextAction !== undefined && asRecord(agent.nextAction) === undefined) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.nextAction must be an object",
      details: {
        path: "state.agent.nextAction",
      },
    };
  }
  const exec = asRecord(agent.exec) ?? {};
  if (
    exec.substate !== undefined &&
    (typeof exec.substate !== "string" || EXEC_SUBSTATES.has(exec.substate) === false)
  ) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.exec.substate is invalid",
    };
  }
  if (
    exec.pendingEffectKey !== undefined &&
    typeof exec.pendingEffectKey !== "string"
  ) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.exec.pendingEffectKey must be a string",
    };
  }
  if (
    exec.pendingAction !== undefined &&
    asRecord(exec.pendingAction) === undefined
  ) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.exec.pendingAction must be an object",
    };
  }
  if (
    exec.pendingEffectType !== undefined &&
    typeof exec.pendingEffectType !== "string"
  ) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.exec.pendingEffectType must be a string",
    };
  }
  if (
    exec.pendingToolCall !== undefined &&
    asRecord(exec.pendingToolCall) === undefined
  ) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.exec.pendingToolCall must be an object",
    };
  }
  if (
    exec.pendingBatch !== undefined &&
    asRecord(exec.pendingBatch) === undefined
  ) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.exec.pendingBatch must be an object",
    };
  }
  if (
    exec.pendingApproval !== undefined &&
    asRecord(exec.pendingApproval) === undefined
  ) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.exec.pendingApproval must be an object",
      details: {
        path: "state.agent.exec.pendingApproval",
      },
    };
  }
  const waitingFor = asRecord(agent.waitingFor);
  if (waitingFor !== undefined) {
    if (
      waitingFor.kind !== "user" &&
      waitingFor.kind !== "approval" &&
      waitingFor.kind !== "effect" &&
      waitingFor.kind !== "region_merge" &&
      waitingFor.kind !== "tool"
    ) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.waitingFor.kind is invalid",
        details: {
          path: "state.agent.waitingFor.kind",
        },
      };
    }
    if (typeof waitingFor.eventType !== "string" || waitingFor.eventType.trim().length === 0) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.waitingFor.eventType is required",
        details: {
          path: "state.agent.waitingFor.eventType",
        },
      };
    }
    if (
      waitingFor.timeoutMs !== undefined &&
      (
        typeof waitingFor.timeoutMs !== "number" ||
        Number.isFinite(waitingFor.timeoutMs) === false ||
        waitingFor.timeoutMs < 0
      )
    ) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.waitingFor.timeoutMs must be a non-negative finite number",
        details: {
          path: "state.agent.waitingFor.timeoutMs",
        },
      };
    }
    if (typeof waitingFor.reason !== "string" || waitingFor.reason.trim().length === 0) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.waitingFor.reason is required",
        details: {
          path: "state.agent.waitingFor.reason",
        },
      };
    }
    if (typeof waitingFor.resumeInstruction !== "string" || waitingFor.resumeInstruction.trim().length === 0) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.waitingFor.resumeInstruction is required",
        details: {
          path: "state.agent.waitingFor.resumeInstruction",
        },
      };
    }
    const interaction = asRecord(waitingFor.interaction);
    const waitMetadata = asRecord(waitingFor.metadata);
    const pendingApproval = asRecord(exec.pendingApproval);
    if (interaction !== undefined) {
      try {
        parseRunnerInteractionRequest(interaction, waitingFor.eventType);
      } catch (error) {
        return {
          code: "RUNTIME_STATE_INVALID",
          message: "state.agent.waitingFor.interaction is invalid",
          details: {
            path: "state.agent.waitingFor.interaction",
            cause: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    const hasHostedApprovalV2Evidence =
      pendingApproval?.version === "hosted_tool_approval_v2" ||
      pendingApproval?.preparedInvocationId !== undefined ||
      pendingApproval?.preparedToolCall !== undefined ||
      waitMetadata?.preparedToolCall !== undefined ||
      asRecord(pendingApproval?.externalApprovalBinding)?.version ===
        "runner_external_approval_binding_v2" ||
      asRecord(waitMetadata?.externalApprovalBinding)?.version ===
        "runner_external_approval_binding_v2";
    const hasLocalApprovalV1Evidence =
      pendingApproval?.version === "local_tool_approval_v1" ||
      asRecord(pendingApproval?.externalApprovalBinding)?.version ===
        "runner_external_approval_binding_v1" ||
      asRecord(waitMetadata?.externalApprovalBinding)?.version ===
        "runner_external_approval_binding_v1";
    if (
      hasHostedApprovalV2Evidence &&
      interaction?.version !== "runner_hosted_tool_approval_interaction_v4"
    ) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.waitingFor hosted approval state is incomplete",
        details: {
          path: "state.agent.waitingFor.interaction",
        },
      };
    }
    if (
      hasLocalApprovalV1Evidence &&
      interaction?.version !== "runner_local_tool_approval_interaction_v1"
    ) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.waitingFor local approval state is incomplete",
        details: {
          path: "state.agent.waitingFor.interaction",
        },
      };
    }
    if (
      interaction?.version === "runner_local_tool_approval_interaction_v1"
    ) {
      try {
        if (waitingFor.kind !== "approval") {
          throw new Error(
            "local tool approval interaction requires an approval wait",
          );
        }
        const parsedInteraction = parseRunnerLocalToolApprovalInteractionV1(
          interaction,
          waitingFor.eventType,
        );
        const pendingExternalApprovalBinding =
          pendingApproval?.externalApprovalBinding;
        const waitExternalApprovalBinding =
          waitMetadata?.externalApprovalBinding;
        if (
          pendingApproval?.version !== "local_tool_approval_v1" ||
          pendingApproval.approvalId !== parsedInteraction.approval.approvalId ||
          pendingApproval.toolName !== parsedInteraction.approval.toolName ||
          canonicalJsonValuesEqual(
            pendingExternalApprovalBinding,
            waitExternalApprovalBinding,
          ) === false
        ) {
          throw new Error(
            "local tool approval must preserve one exact pending action",
          );
        }
        const projectedInteraction = projectLocalToolApprovalInteractionV1({
          metadata: waitMetadata,
          requestId: parsedInteraction.requestId,
        });
        const {
          metadata: _parsedInteractionMetadata,
          ...parsedInteractionContract
        } = parsedInteraction;
        const {
          metadata: _projectedInteractionMetadata,
          ...projectedInteractionContract
        } = projectedInteraction;
        if (
          canonicalJson(parsedInteractionContract) !==
            canonicalJson(projectedInteractionContract)
        ) {
          throw new Error(
            "local tool approval card must match its canonical action binding",
          );
        }
      } catch (error) {
        return {
          code: "RUNTIME_STATE_INVALID",
          message: "state.agent.waitingFor.interaction is invalid",
          details: {
            path: "state.agent.waitingFor.interaction",
            cause: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    if (
      interaction?.version === "runner_hosted_tool_approval_interaction_v4"
    ) {
      try {
        if (waitingFor.kind !== "approval") {
          throw new Error(
            "hosted tool approval interaction requires an approval wait",
          );
        }
        const parsedInteraction = parseRunnerHostedToolApprovalInteractionV4(
          interaction,
          waitingFor.eventType,
        );
        const prepared = parseDurablePreparedToolCallV1(
          waitMetadata?.preparedToolCall,
        );
        if (
          pendingApproval?.version !== "hosted_tool_approval_v2" ||
          pendingApproval.preparedToolCall !== undefined ||
          pendingApproval.preparedInvocationId !== prepared.callId ||
          parsedInteraction.approval.preparedInvocationId !== prepared.callId
        ) {
          throw new Error(
            "hosted tool approval must use one canonical prepared invocation",
          );
        }
        const projectedInteraction = projectHostedToolApprovalInteractionV4({
          preparedToolCall: prepared,
          requestId: parsedInteraction.requestId,
          reasonCode: waitMetadata?.reasonCode,
        });
        if (
          canonicalJson(parsedInteraction) !== canonicalJson(projectedInteraction)
        ) {
          throw new Error(
            "hosted tool approval card must match its canonical prepared invocation",
          );
        }
      } catch (error) {
        return {
          code: "RUNTIME_STATE_INVALID",
          message: "state.agent.waitingFor.interaction is invalid",
          details: {
            path: "state.agent.waitingFor.interaction",
            cause: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
  }

  const terminal = asRecord(agent.terminal);
  if (terminal !== undefined) {
    if (
      typeof terminal.status !== "string" ||
      TERMINAL_STATUSES.has(terminal.status) === false
    ) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.terminal.status is invalid",
      };
    }
    if (typeof terminal.reasonCode !== "string" || terminal.reasonCode.trim().length === 0) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.terminal.reasonCode must be a non-empty string",
      };
    }
    if (
      typeof terminal.finalStepAgent !== "string" ||
      terminal.finalStepAgent.trim().length === 0
    ) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.terminal.finalStepAgent must be a non-empty string",
      };
    }
    if (
      typeof terminal.finalizedAt !== "string" ||
      terminal.finalizedAt.trim().length === 0
    ) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: "state.agent.terminal.finalizedAt must be a non-empty string",
      };
    }
  }

  if (agent.retryContext !== undefined && asRecord(agent.retryContext) === undefined) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.retryContext must be an object",
    };
  }
  if (agent.plan !== undefined) {
    const plan = validateRuntimePlanState(agent.plan);
    if (plan.ok === false && looksLikeLegacyPlanState(agent.plan) === false) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: plan.error.message,
        details: {
          path: `state.agent.${plan.error.path}`,
        },
      };
    }
  }
  const legacyProgressField = ["workPlan", "executionLedger", "evidenceLedger", "progress"].find((field) =>
    Object.hasOwn(agent, field)
  );
  if (legacyProgressField !== undefined) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: `state.agent.${legacyProgressField} is a legacy progress surface; use state.agent.visibleTodos`,
      details: {
        path: `state.agent.${legacyProgressField}`,
      },
    };
  }
  if (agent.visibleTodos !== undefined) {
    const visibleTodos = validateVisibleTodoState(agent.visibleTodos);
    if (visibleTodos.ok === false) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: visibleTodos.error.message,
        details: {
          path: visibleTodos.error.path,
        },
      };
    }
  }
  if (agent.modelTranscript !== undefined) {
    const modelTranscript = validateModelTranscript(agent.modelTranscript);
    if (modelTranscript.ok === false) {
      return {
        code: "RUNTIME_STATE_INVALID",
        message: modelTranscript.error?.message ?? "state.agent.modelTranscript is invalid",
        details: {
          path: modelTranscript.error?.path ?? "state.agent.modelTranscript",
        },
      };
    }
  }
  if (agent.activeTurnIntent !== undefined && readActiveTurnIntent(agent) === undefined) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.agent.activeTurnIntent must be a valid v1 active turn intent",
      details: {
        path: "state.agent.activeTurnIntent",
      },
    };
  }
  if (state.evidenceLedger !== undefined && Array.isArray(state.evidenceLedger) === false) {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.evidenceLedger must be an array of raw evidence records",
      details: {
        path: "state.evidenceLedger",
      },
    };
  }

  const region = asRecord(state.region);
  if (region !== undefined && region.laneCursor !== undefined && typeof region.laneCursor !== "string") {
    return {
      code: "RUNTIME_STATE_INVALID",
      message: "state.region.laneCursor must be a string",
    };
  }
  return ;
}

export function readAgentState(state: Record<string, unknown>): RuntimeAgentState {
  return decodeRuntimeSessionState(state).agent;
}

export function readExecState(state: Record<string, unknown>): RuntimeExecState {
  return readAgentState(state).exec;
}

export function readWaitState(state: Record<string, unknown>): RuntimeWaitState | undefined {
  const waitingFor = readAgentState(state).waitingFor;
  if (waitingFor === undefined) {
    return ;
  }
  return {
    ...(waitingFor.kind !== undefined ? { kind: waitingFor.kind } : {}),
    ...(waitingFor.eventType !== undefined ? { eventType: waitingFor.eventType } : {}),
    ...(waitingFor.resumeStepAgent !== undefined
      ? { resumeStepAgent: waitingFor.resumeStepAgent }
      : {}),
    ...(waitingFor.resumeToken !== undefined ? { resumeToken: waitingFor.resumeToken } : {}),
    ...(waitingFor.metadata !== undefined ? { metadata: waitingFor.metadata } : {}),
    ...(waitingFor.interaction !== undefined
      ? {
          interaction: parseRunnerInteractionRequest(
            waitingFor.interaction,
            waitingFor.eventType,
          ),
        }
      : {}),
  };
}

export function readTerminalState(state: Record<string, unknown>): RuntimeTerminalState | undefined {
  return readAgentState(state).terminal;
}

export function readRegionLaneCursor(state: Record<string, unknown>): string | undefined {
  const region = asRecord(state.region);
  return typeof region?.laneCursor === "string" && region.laneCursor.trim().length > 0
    ? region.laneCursor
    : undefined;
}

export function normalizeRuntimeStateForPersist(
  state: Record<string, unknown>,
): Record<string, unknown> {
  return serializeRuntimeSessionState(state);
}

function decodeAgentState(value: Record<string, unknown> | undefined): RuntimeAgentState {
  const state = value ?? {};
  const plan = normalizeRuntimePlanState(state.plan);
  const planDocument = normalizeRuntimePlanDocumentSnapshot(state.planDocument);
  const visibleTodos = normalizeVisibleTodoState(state.visibleTodos);
  const modelTranscript = normalizeModelTranscript(state.modelTranscript);
  const {
    progress: _legacyProgress,
    workPlan: _legacyWorkPlan,
    evidenceLedger: _legacyEvidenceLedger,
    plan: _legacyPlan,
    planDocument: _legacyPlanDocument,
    executionLedger: _legacyExecutionLedger,
    ...stateWithoutLegacyAuthority
  } = state;
  const upgradedLocalApproval = upgradeLegacyLocalApprovalState(state);
  return {
    ...stateWithoutLegacyAuthority,
    observations: Array.isArray(state.observations) ? state.observations : [],
    exec: upgradedLocalApproval.exec,
    assistantText: normalizeAssistantText(state.assistantText),
    ...(upgradedLocalApproval.waitingFor !== undefined
      ? { waitingFor: upgradedLocalApproval.waitingFor }
      : {}),
    ...(asRecord(state.terminal) !== undefined ? { terminal: asRecord(state.terminal) } : {}),
    ...(asRecord(state.lastAction) !== undefined ? { lastAction: asRecord(state.lastAction) } : {}),
    ...(state.lastActionResult !== undefined ? { lastActionResult: state.lastActionResult } : {}),
    ...(asRecord(state.retryContext) !== undefined ? { retryContext: asRecord(state.retryContext) } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(planDocument !== undefined ? { planDocument } : {}),
    ...(visibleTodos !== undefined ? { visibleTodos } : {}),
    ...(modelTranscript !== undefined ? { modelTranscript } : {}),
  };
}

function upgradeLegacyLocalApprovalState(state: Record<string, unknown>): {
  exec: Record<string, unknown>;
  waitingFor?: Record<string, unknown> | undefined;
} {
  const exec = { ...(asRecord(state.exec) ?? {}) };
  const waitingForRecord = asRecord(state.waitingFor);
  const waitingFor = waitingForRecord === undefined
    ? undefined
    : { ...waitingForRecord };
  const pendingApproval = asRecord(exec.pendingApproval);
  const binding = asRecord(pendingApproval?.externalApprovalBinding);
  const interaction = asRecord(waitingFor?.interaction);
  if (
    pendingApproval === undefined ||
    pendingApproval.version !== undefined ||
    binding?.version !== "runner_external_approval_binding_v1" ||
    waitingFor?.kind !== "approval" ||
    waitingFor.eventType !== "user.approval" ||
    (interaction !== undefined &&
      (interaction.version !== "v1" || interaction.kind !== "approval"))
  ) {
    return { exec, ...(waitingFor === undefined ? {} : { waitingFor }) };
  }
  const metadata = {
    ...(asRecord(waitingFor.metadata) ?? {}),
    requestedAt: binding.requestedAt,
  };
  try {
    const projected = projectLocalToolApprovalInteractionV1({
      metadata,
      requestId:
        typeof interaction?.requestId === "string"
          ? interaction.requestId
          : undefined,
    });
    exec.pendingApproval = {
      ...pendingApproval,
      version: "local_tool_approval_v1",
    };
    return {
      exec,
      waitingFor: {
        ...waitingFor,
        metadata,
        interaction: projected,
      },
    };
  } catch {
    return { exec, ...(waitingFor === undefined ? {} : { waitingFor }) };
  }
}

function canonicalJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return canonicalJson(left) === canonicalJson(right);
}

function parseRuntimeSessionState(
  state: Record<string, unknown>,
): DecodedRuntimeSessionState {
  const runtime = asRecord(state.runtime);
  const agentRecord = asRecord(state.agent);
  const agent = decodeAgentState(agentRecord);
  const evidenceLedger = Array.isArray(state.evidenceLedger)
    ? state.evidenceLedger
    : Array.isArray(agentRecord?.evidenceLedger)
      ? agentRecord.evidenceLedger
      : undefined;
  return {
    ...state,
    runtime: {
      schemaVersion:
        typeof runtime?.schemaVersion === "number" && Number.isFinite(runtime.schemaVersion)
          ? Math.trunc(runtime.schemaVersion)
          : CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
      ...(typeof runtime?.migratedAt === "string" ? { migratedAt: runtime.migratedAt } : {}),
    },
    agent,
    ...(evidenceLedger !== undefined ? { evidenceLedger } : {}),
  };
}

function hasLegacyRuntimeState(state: DecodedRuntimeSessionState): boolean {
  const agent = state.agent;
  if (state.runtime.schemaVersion !== CURRENT_RUNTIME_STATE_SCHEMA_VERSION) {
    return true;
  }
  return (
    typeof agent.pendingEffectKey === "string" ||
    typeof agent.pendingEffectType === "string" ||
    asRecord(agent.pendingApproval) !== undefined ||
    asRecord(agent.pendingToolBatch) !== undefined ||
    asRecord(agent.pendingToolCall) !== undefined ||
    agent.assistantText === undefined
  );
}

function normalizeAssistantText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function looksLikeLegacyPlanState(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== undefined &&
    Object.hasOwn(record, "path") === false &&
    Object.hasOwn(record, "status") === false
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}
