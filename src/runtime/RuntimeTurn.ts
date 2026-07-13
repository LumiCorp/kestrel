import type { ClientCapabilities } from "../clientCapabilities.js";
import type { NormalizedOutput } from "../kestrel/contracts/execution.js";
import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";
import type {
  HostedMcpAuthorization,
  HostedMcpContext,
} from "../mcp/hosted-contracts.js";
import type {
  ActSubmode,
  ExecutionPolicyOverride,
  InteractionMode,
} from "../mode/contracts.js";
import {
  alignExecutionPolicyWithMode,
  normalizeInteractionMode,
} from "../mode/contracts.js";

export type RuntimeTurnActorType = "end_user" | "operator" | "service";

export interface RuntimeTurnActor {
  actorType: RuntimeTurnActorType;
  actorId: string;
  displayName?: string | undefined;
  tenantId?: string | undefined;
}

export interface RuntimeTurnSkillPack {
  id: string;
  label: string;
  instructions: string | string[];
  allowedTools?: string[] | undefined;
}

export interface RuntimeTurnInput {
  sessionId: string;
  runId?: string | undefined;
  message: string;
  eventType: string;
  attachments?: RunTurnAttachment[] | undefined;
  resumeBlockedRun?: boolean | undefined;
  stepAgent?: string | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  mcpContext?: HostedMcpContext | undefined;
  /** Ephemeral authorization consumed before the turn is compiled or persisted. */
  mcpAuthorization?: HostedMcpAuthorization | undefined;
  metadata?: Record<string, unknown> | undefined;
  actor?: RuntimeTurnActor | undefined;
  clientCapabilities?: ClientCapabilities | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  history?:
    | Array<{
        role: "user" | "assistant" | "system";
        text: string;
        timestamp: string;
        attachments?: RunTurnAttachment[] | undefined;
      }>
    | undefined;
  manualCompaction?: boolean | undefined;
  autoCompaction?:
    | {
        enabled?: boolean | undefined;
        state?: string | undefined;
        suppressOnce?: boolean | undefined;
      }
    | undefined;
  workspace?: unknown | undefined;
  skillPack?: RuntimeTurnSkillPack | undefined;
}

export interface RuntimeTurnResult {
  output: NormalizedOutput;
  finalizedPayload?: unknown | undefined;
  operatorAffordance?: unknown | undefined;
}

export interface RuntimeTurnCoordinator {
  runTurn(
    input: RuntimeTurnInput,
    options?: { signal?: AbortSignal | undefined }
  ): Promise<RuntimeTurnResult>;
}

export interface CompileRuntimeTurnDefaults {
  defaultInteractionMode?: InteractionMode | undefined;
  defaultActSubmode?: ActSubmode | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  forceModeSystemV2?: boolean | undefined;
  defaultExecutionPolicy?: ExecutionPolicyOverride | undefined;
  toolBatchCheckpointSize: number;
  activeTaskId?: string | undefined;
}

export interface CompiledRuntimeTurn {
  input: RuntimeTurnInput;
  resolvedMode: ReturnType<typeof normalizeInteractionMode>;
  payloadMode: {
    interactionMode: RuntimeTurnInput["interactionMode"];
    actSubmode?: RuntimeTurnInput["actSubmode"] | undefined;
  };
  modeSystemV2Enabled: boolean;
  requestedModeSystemV2Enabled: boolean;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
  compaction: { apply: boolean };
}

export interface PreparedRuntimeTurn {
  input: RuntimeTurnInput;
  resolvedMode: ReturnType<typeof normalizeInteractionMode>;
  payloadMode: CompiledRuntimeTurn["payloadMode"];
  modeSystemV2Enabled: boolean;
  requestedModeSystemV2Enabled: boolean;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  metadata: Record<string, unknown>;
  compaction: { apply: boolean };
  toolBatchCheckpointSize: number;
}

export interface RuntimeRecoveryContinuation {
  eventType: "system.meta_reasoning";
  stepAgent: string;
  manualCompaction: true;
  resumeBlockedRun: false;
  reason: "agent_timeout_resume" | "observer_timeout_resume";
}

export function compileRuntimeTurn(
  input: RuntimeTurnInput,
  defaults: CompileRuntimeTurnDefaults
): CompiledRuntimeTurn {
  return materializeCompiledRuntimeTurn(prepareRuntimeTurn(input, defaults));
}

export function prepareRuntimeTurn(
  input: RuntimeTurnInput,
  defaults: CompileRuntimeTurnDefaults
): PreparedRuntimeTurn {
  const requestedModeSystemV2Enabled =
    input.modeSystemV2Enabled ?? defaults.modeSystemV2Enabled === true;
  const modeSystemV2Enabled =
    defaults.forceModeSystemV2 === true ? true : requestedModeSystemV2Enabled;
  const resolvedMode = normalizeInteractionMode({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    defaultInteractionMode: defaults.defaultInteractionMode,
    defaultActSubmode: defaults.defaultActSubmode,
  });
  const payloadMode = buildRuntimeModePayload(
    modeSystemV2Enabled,
    resolvedMode
  );
  const executionPolicy = alignExecutionPolicyWithMode({
    executionPolicy: mergeExecutionPolicies(
      defaults.defaultExecutionPolicy,
      input.executionPolicy
    ),
    interactionMode: resolvedMode.interactionMode,
    actSubmode: resolvedMode.actSubmode,
  });
  const metadata = buildRuntimeTurnMetadata({
    input,
    modeSystemV2Enabled,
    requestedModeSystemV2Enabled,
    payloadMode,
    resolvedMode,
    toolBatchCheckpointSize: defaults.toolBatchCheckpointSize,
    activeTaskId: defaults.activeTaskId,
    executionPolicy,
  });
  const compaction = resolveCompactionRequest(input);

  return {
    input: {
      ...input,
      ...(executionPolicy !== undefined ? { executionPolicy } : {}),
      metadata,
    },
    resolvedMode,
    payloadMode,
    modeSystemV2Enabled,
    requestedModeSystemV2Enabled,
    ...(executionPolicy !== undefined ? { executionPolicy } : {}),
    metadata,
    compaction,
    toolBatchCheckpointSize: defaults.toolBatchCheckpointSize,
  };
}

export function materializeCompiledRuntimeTurn(
  prepared: PreparedRuntimeTurn
): CompiledRuntimeTurn {
  const externalDeadlineMs = readExternalDeadlineMs(prepared.metadata);
  const payload: Record<string, unknown> = {
    message: prepared.input.message,
    ...(prepared.input.attachments !== undefined
      ? { attachments: prepared.input.attachments }
      : {}),
    enableRouteClassifier: true,
    modeSystemV2Enabled: prepared.modeSystemV2Enabled,
    interactionMode: prepared.payloadMode.interactionMode,
    ...(prepared.payloadMode.actSubmode !== undefined
      ? { actSubmode: prepared.payloadMode.actSubmode }
      : {}),
    ...(prepared.input.clientCapabilities !== undefined
      ? { clientCapabilities: prepared.input.clientCapabilities }
      : {}),
    ...(prepared.input.mcpContext !== undefined
      ? { mcpContext: prepared.input.mcpContext }
      : {}),
    ...(prepared.metadata.legacyModeMigration !== undefined
      ? { legacyModeMigration: prepared.metadata.legacyModeMigration }
      : {}),
    ...(prepared.executionPolicy !== undefined
      ? { executionPolicy: prepared.executionPolicy }
      : {}),
    ...(prepared.input.resumeBlockedRun === true
      ? { resumeBlockedRun: true }
      : {}),
    metadata: prepared.metadata,
    orchestration: {
      ...prepared.metadata,
      ...(externalDeadlineMs !== undefined ? { externalDeadlineMs } : {}),
    },
    toolBatchCheckpointSize: prepared.toolBatchCheckpointSize,
    ...(prepared.input.history !== undefined
      ? { history: prepared.input.history }
      : {}),
    ...(prepared.compaction.apply ? { manualCompaction: true } : {}),
    ...(prepared.input.autoCompaction !== undefined
      ? {
          autoCompaction: {
            enabled: prepared.input.autoCompaction.enabled === true,
            ...(prepared.input.autoCompaction.state !== undefined
              ? { state: prepared.input.autoCompaction.state }
              : {}),
            ...(prepared.input.autoCompaction.suppressOnce === true
              ? { suppressOnce: true }
              : {}),
            ...(prepared.compaction.apply &&
            prepared.input.manualCompaction !== true &&
            prepared.input.autoCompaction.enabled === true
              ? { appliedByRuntime: true }
              : {}),
          },
        }
      : {}),
    ...(prepared.input.workspace !== undefined
      ? { workspace: prepared.input.workspace }
      : {}),
    ...(prepared.input.skillPack !== undefined
      ? {
          skillPack: {
            id: prepared.input.skillPack.id,
            label: prepared.input.skillPack.label,
            instructions: prepared.input.skillPack.instructions,
            allowedTools: prepared.input.skillPack.allowedTools,
          },
        }
      : {}),
  };

  return {
    ...prepared,
    payload,
  };
}

export async function resolveRuntimeRecoveryContinuation(input: {
  output: NormalizedOutput;
  readPersistedResumeStepAgent?:
    | (() => Promise<string | undefined>)
    | undefined;
  defaultStepAgent?: string | undefined;
}): Promise<RuntimeRecoveryContinuation | undefined> {
  if (
    input.output.status !== "WAITING" ||
    input.output.waitFor?.eventType !== "system.meta_reasoning"
  ) {
    return;
  }
  const metadata = asRecord(input.output.waitFor.metadata);
  const reason = asString(metadata?.reason);
  if (
    reason !== "agent_timeout_resume" &&
    reason !== "observer_timeout_resume"
  ) {
    return;
  }
  const fromMetadata = asString(metadata?.resumeStepAgent);
  const stepAgent =
    fromMetadata ??
    (await input.readPersistedResumeStepAgent?.()) ??
    input.defaultStepAgent ??
    "agent.loop";
  return {
    eventType: "system.meta_reasoning",
    stepAgent,
    manualCompaction: true,
    resumeBlockedRun: false,
    reason,
  };
}

function buildRuntimeModePayload(
  modeSystemV2Enabled: boolean,
  resolvedMode: ReturnType<typeof normalizeInteractionMode>
): CompiledRuntimeTurn["payloadMode"] {
  const actSubmode =
    resolvedMode.interactionMode === "build" &&
    resolvedMode.actSubmode !== undefined
      ? { actSubmode: resolvedMode.actSubmode }
      : {};

  if (modeSystemV2Enabled) {
    return {
      interactionMode: resolvedMode.interactionMode,
      ...actSubmode,
    };
  }

  return {
    interactionMode: resolvedMode.interactionMode,
    ...actSubmode,
  };
}

function buildRuntimeTurnMetadata(input: {
  input: RuntimeTurnInput;
  modeSystemV2Enabled: boolean;
  requestedModeSystemV2Enabled: boolean;
  payloadMode: CompiledRuntimeTurn["payloadMode"];
  resolvedMode: ReturnType<typeof normalizeInteractionMode>;
  toolBatchCheckpointSize: number;
  activeTaskId?: string | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
}): Record<string, unknown> {
  return {
    ...(input.input.metadata ?? {}),
    ...(input.input.metadata?.activeTaskId === undefined &&
    input.activeTaskId !== undefined
      ? { activeTaskId: input.activeTaskId }
      : {}),
    ...(input.input.runId !== undefined ? { runId: input.input.runId } : {}),
    enableRouteClassifier: true,
    modeSystemV2Enabled: input.modeSystemV2Enabled,
    interactionMode: input.payloadMode.interactionMode,
    ...(input.resolvedMode.actSubmode !== undefined
      ? { actSubmode: input.resolvedMode.actSubmode }
      : {}),
    ...(input.input.clientCapabilities !== undefined
      ? { clientCapabilities: input.input.clientCapabilities }
      : {}),
    ...(input.modeSystemV2Enabled && input.requestedModeSystemV2Enabled !== true
      ? {
          legacyModeMigration: {
            migrated: true,
            interactionMode: input.payloadMode.interactionMode,
            reason: "reference harness forced mode-system v2",
          },
        }
      : {}),
    ...(input.executionPolicy !== undefined
      ? { executionPolicy: input.executionPolicy }
      : {}),
    toolBatchCheckpointSize: input.toolBatchCheckpointSize,
    ...(input.input.history !== undefined
      ? { history: input.input.history }
      : {}),
    ...(input.input.workspace !== undefined
      ? { workspace: input.input.workspace }
      : {}),
    ...(input.input.skillPack !== undefined
      ? { skillPackId: input.input.skillPack.id }
      : {}),
    ...(input.input.actor !== undefined ? { actor: input.input.actor } : {}),
  };
}

function mergeExecutionPolicies(
  base: ExecutionPolicyOverride | undefined,
  override: ExecutionPolicyOverride | undefined
): ExecutionPolicyOverride | undefined {
  if (base === undefined) {
    return override;
  }
  if (override === undefined) {
    return base;
  }
  return {
    ...base,
    ...(override.toolClassPolicy !== undefined
      ? {
          toolClassPolicy: {
            ...(base.toolClassPolicy ?? {}),
            ...override.toolClassPolicy,
          },
        }
      : {}),
    ...(override.capabilityPolicy !== undefined
      ? {
          capabilityPolicy: {
            ...(base.capabilityPolicy ?? {}),
            ...override.capabilityPolicy,
          },
        }
      : {}),
    ...(override.approvalPolicy !== undefined
      ? {
          approvalPolicy: {
            ...(base.approvalPolicy ?? {}),
            ...override.approvalPolicy,
          },
        }
      : {}),
  };
}

function resolveCompactionRequest(input: RuntimeTurnInput): { apply: boolean } {
  if (input.manualCompaction === true) {
    return { apply: true };
  }
  if (
    input.autoCompaction?.enabled === true &&
    input.autoCompaction.state === "armed" &&
    input.autoCompaction.suppressOnce !== true
  ) {
    return { apply: true };
  }
  return { apply: false };
}

function readExternalDeadlineMs(
  metadata: Record<string, unknown>
): number | undefined {
  const value = metadata.externalDeadlineMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
