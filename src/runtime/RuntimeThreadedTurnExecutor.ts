import { randomUUID } from "node:crypto";
import { DEFAULT_BALANCED_TOOL_ALLOWLIST } from "../../tools/createDefaultToolGateway.js";
import type { RuntimeEvent } from "../kestrel/contracts/events.js";
import type { NormalizedOutput } from "../kestrel/contracts/execution.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";
import type {
  ActSubmode,
  ExecutionPolicyOverride,
  InteractionMode,
} from "../mode/contracts.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
} from "../mode/contracts.js";
import type {
  AssemblyBundleRecord,
  SubmitTurnInput,
  ThreadAssemblyRecord,
  TurnExecutionInput,
  TurnExecutionResult,
} from "../orchestration/contracts.js";
import {
  compileRuntimeTurn,
  type RuntimeTurnInput,
  type RuntimeTurnSkillPack,
} from "./RuntimeTurn.js";
import { readWaitResumeStepAgent } from "./waitState.js";

export interface RuntimeThreadedTurnExecutorOptions {
  entryStepAgent: string;
  defaults?:
    | {
        defaultInteractionMode?: InteractionMode | undefined;
        defaultActSubmode?: ActSubmode | undefined;
        defaultToolAllowlist?: string[] | undefined;
        toolBatchCheckpointSize?: number | undefined;
      }
    | undefined;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  runKernel(
    event: RuntimeEvent,
    options?: { signal?: AbortSignal | undefined }
  ): Promise<NormalizedOutput>;
  refreshToolRuntime(input?: RuntimeTurnInput | undefined): Promise<unknown>;
  resolveAvailableToolAllowlist(
    names: string[],
    input?: RuntimeTurnInput | undefined,
    options?: { includeGrantedMcpTools?: boolean | undefined } | undefined
  ): string[];
  resolveSkillPackById?:
    | ((skillPackId: string) => RuntimeTurnSkillPack | undefined)
    | undefined;
  handleCapabilityLoss?:
    | ((input: { threadId: string; availableToolNames: string[] }) => Promise<{
        record: ThreadAssemblyRecord;
        bundle?: AssemblyBundleRecord | undefined;
      } | null>)
    | undefined;
}

export class RuntimeThreadedTurnExecutor {
  private readonly entryStepAgent: string;
  private readonly defaults: NonNullable<
    RuntimeThreadedTurnExecutorOptions["defaults"]
  >;
  private readonly getSession: RuntimeThreadedTurnExecutorOptions["getSession"];
  private readonly runKernel: RuntimeThreadedTurnExecutorOptions["runKernel"];
  private readonly refreshToolRuntime: RuntimeThreadedTurnExecutorOptions["refreshToolRuntime"];
  private readonly resolveAvailableToolAllowlist: RuntimeThreadedTurnExecutorOptions["resolveAvailableToolAllowlist"];
  private readonly resolveSkillPackById: RuntimeThreadedTurnExecutorOptions["resolveSkillPackById"];
  private readonly handleCapabilityLoss: RuntimeThreadedTurnExecutorOptions["handleCapabilityLoss"];

  constructor(options: RuntimeThreadedTurnExecutorOptions) {
    this.entryStepAgent = options.entryStepAgent;
    this.defaults = options.defaults ?? {};
    this.getSession = options.getSession;
    this.runKernel = options.runKernel;
    this.refreshToolRuntime = options.refreshToolRuntime;
    this.resolveAvailableToolAllowlist = options.resolveAvailableToolAllowlist;
    this.resolveSkillPackById = options.resolveSkillPackById;
    this.handleCapabilityLoss = options.handleCapabilityLoss;
  }

  async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    const orchestrationMetadata = asRecord(input.metadata);
    const runtimeAssembly = asRecord(input.metadata?.runtimeAssembly);
    const baseRuntimeTurn = input.runtimeTurn;
    const persistedSession = await this.getSession(input.sessionId);
    const threadedStepAgent = resolveRuntimeThreadedStepAgent({
      inputStepAgent: input.stepAgent,
      eventType: input.eventType,
      entryStepAgent: this.entryStepAgent,
      session: persistedSession,
    });
    const interactionMode =
      baseRuntimeTurn?.interactionMode ??
      asInteractionMode(orchestrationMetadata?.interactionMode) ??
      this.defaults.defaultInteractionMode ??
      DEFAULT_INTERACTION_MODE;
    const actSubmode =
      baseRuntimeTurn?.actSubmode ??
      asActSubmode(orchestrationMetadata?.actSubmode) ??
      this.defaults.defaultActSubmode ??
      DEFAULT_ACT_SUBMODE;
    const requestedToolAllowlist = Array.isArray(runtimeAssembly?.toolAllowlist)
      ? runtimeAssembly.toolAllowlist.filter(
          (value): value is string => typeof value === "string"
        )
      : (this.defaults.defaultToolAllowlist ?? [
          ...DEFAULT_BALANCED_TOOL_ALLOWLIST,
        ]);

    await this.refreshToolRuntime(baseRuntimeTurn);
    const effectiveToolAllowlist = this.resolveAvailableToolAllowlist(
      requestedToolAllowlist,
      baseRuntimeTurn,
      {
        includeGrantedMcpTools: !Array.isArray(runtimeAssembly?.toolAllowlist),
      }
    );
    const effectiveAssembly = await this.resolveEffectiveAssembly({
      input,
      runtimeAssembly,
      effectiveToolAllowlist,
    });
    const runtimeTurn = compileRuntimeTurn(
      this.buildRuntimeTurnInput({
        input,
        baseRuntimeTurn,
        orchestrationMetadata,
        interactionMode,
        actSubmode,
        effectiveToolAllowlist,
        effectiveAssembly,
      }),
      {
        defaultInteractionMode:
          this.defaults.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
        defaultActSubmode:
          this.defaults.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
        modeSystemV2Enabled:
          baseRuntimeTurn?.modeSystemV2Enabled ??
          orchestrationMetadata?.modeSystemV2Enabled === true,
        toolBatchCheckpointSize:
          asFiniteNumber(baseRuntimeTurn?.metadata?.toolBatchCheckpointSize) ??
          asFiniteNumber(orchestrationMetadata?.toolBatchCheckpointSize) ??
          this.defaults.toolBatchCheckpointSize ??
          5,
      }
    );
    const output = await this.runKernel(
      {
        id: runtimeTurn.input.runId ?? randomUUID(),
        type: input.eventType,
        sessionId: input.sessionId,
        ...(threadedStepAgent !== undefined
          ? { stepAgent: threadedStepAgent }
          : {}),
        payload: runtimeTurn.payload,
      },
      {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }
    );
    const session = await this.getSession(input.sessionId);
    const finalOutput = asRecord(session?.state.agent)?.finalOutput;
    return {
      output,
      ...(session !== null ? { session } : {}),
      ...(output.status === "COMPLETED" && finalOutput !== undefined
        ? { finalizedPayload: finalOutput }
        : {}),
    };
  }

  private async resolveEffectiveAssembly(input: {
    input: SubmitTurnInput;
    runtimeAssembly?: Record<string, unknown> | undefined;
    effectiveToolAllowlist: string[];
  }): Promise<{
    bundleId?: unknown | undefined;
    specialistIds: string[];
    contextPolicyId?: string | undefined;
    approvalPolicyId?: string | undefined;
  }> {
    let bundleId = input.runtimeAssembly?.bundleId;
    let specialistIds = Array.isArray(input.runtimeAssembly?.specialistIds)
      ? input.runtimeAssembly.specialistIds.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    let contextPolicyId = asString(input.runtimeAssembly?.contextPolicyId);
    let approvalPolicyId = asString(input.runtimeAssembly?.approvalPolicyId);

    const recomposed = await this.handleCapabilityLoss?.({
      threadId: input.input.threadId,
      availableToolNames: input.effectiveToolAllowlist,
    });
    if (recomposed?.record !== undefined) {
      bundleId = recomposed.record.bundleId;
    }
    if (recomposed?.bundle !== undefined) {
      specialistIds = [...recomposed.bundle.specialistIds];
      contextPolicyId = recomposed.bundle.contextPolicyId;
      approvalPolicyId = recomposed.bundle.approvalPolicyId;
    }
    return {
      bundleId,
      specialistIds,
      ...(contextPolicyId !== undefined ? { contextPolicyId } : {}),
      ...(approvalPolicyId !== undefined ? { approvalPolicyId } : {}),
    };
  }

  private buildRuntimeTurnInput(input: {
    input: TurnExecutionInput;
    baseRuntimeTurn?: RuntimeTurnInput | undefined;
    orchestrationMetadata?: Record<string, unknown> | undefined;
    interactionMode: InteractionMode;
    actSubmode: ActSubmode;
    effectiveToolAllowlist: string[];
    effectiveAssembly: {
      bundleId?: unknown | undefined;
      specialistIds: string[];
      contextPolicyId?: string | undefined;
      approvalPolicyId?: string | undefined;
    };
  }): RuntimeTurnInput {
    const skillPackId =
      asString(input.baseRuntimeTurn?.metadata?.skillPackId) ??
      asString(input.input.metadata?.skillPackId);
    const skillPack =
      skillPackId !== undefined
        ? (input.baseRuntimeTurn?.skillPack ??
          this.resolveSkillPackById?.(skillPackId))
        : undefined;
    const executionPolicy =
      input.baseRuntimeTurn?.executionPolicy ??
      (asRecord(input.orchestrationMetadata?.executionPolicy) !== undefined
        ? (asRecord(
            input.orchestrationMetadata?.executionPolicy
          ) as ExecutionPolicyOverride)
        : undefined);
    return {
      ...(input.baseRuntimeTurn ?? {}),
      sessionId: input.input.sessionId,
      message: input.input.message,
      eventType: input.input.eventType,
      ...(input.input.attachments !== undefined
        ? { attachments: input.input.attachments }
        : {}),
      ...(input.input.stepAgent !== undefined
        ? { stepAgent: input.input.stepAgent }
        : input.baseRuntimeTurn?.stepAgent !== undefined
          ? { stepAgent: input.baseRuntimeTurn.stepAgent }
          : {}),
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      ...(executionPolicy !== undefined ? { executionPolicy } : {}),
      ...(input.input.resumeBlockedRun === true
        ? { resumeBlockedRun: true }
        : {}),
      ...(input.input.manualCompaction === true
        ? { manualCompaction: true }
        : {}),
      ...(input.input.autoCompaction !== undefined
        ? { autoCompaction: input.input.autoCompaction }
        : input.baseRuntimeTurn?.autoCompaction !== undefined
          ? { autoCompaction: input.baseRuntimeTurn.autoCompaction }
          : {}),
      ...(input.baseRuntimeTurn?.workspace !== undefined
        ? { workspace: input.baseRuntimeTurn.workspace }
        : isRecord(input.input.metadata?.workspace)
          ? { workspace: input.input.metadata.workspace }
          : {}),
      ...(input.baseRuntimeTurn?.history !== undefined
        ? { history: input.baseRuntimeTurn.history }
        : Array.isArray(input.orchestrationMetadata?.history)
          ? {
              history: input.orchestrationMetadata
                .history as RuntimeTurnInput["history"],
            }
          : {}),
      ...(skillPack !== undefined ? { skillPack } : {}),
      metadata: {
        ...(input.baseRuntimeTurn?.metadata ?? {}),
        ...(input.input.metadata ?? {}),
        runtimeAssembly: {
          bundleId: input.effectiveAssembly.bundleId ?? "implicit/legacy",
          toolAllowlist: input.effectiveToolAllowlist,
          specialistIds: input.effectiveAssembly.specialistIds,
          ...(input.effectiveAssembly.contextPolicyId !== undefined
            ? { contextPolicyId: input.effectiveAssembly.contextPolicyId }
            : {}),
          ...(input.effectiveAssembly.approvalPolicyId !== undefined
            ? { approvalPolicyId: input.effectiveAssembly.approvalPolicyId }
            : {}),
        },
      },
    };
  }
}

export function resolveRuntimeThreadedStepAgent(input: {
  inputStepAgent?: string | undefined;
  eventType: string;
  entryStepAgent: string;
  session?: SessionRecord | null | undefined;
}): string | undefined {
  if (input.eventType === "operator.steer") {
    return input.inputStepAgent ?? input.entryStepAgent;
  }
  const persistedResumeStepAgent = readResumeStepAgentFromSession(
    input.session?.state
  );
  if (input.inputStepAgent !== undefined) {
    if (
      input.eventType !== "user.message" &&
      input.inputStepAgent === input.entryStepAgent &&
      persistedResumeStepAgent !== undefined
    ) {
      return persistedResumeStepAgent;
    }
    return input.inputStepAgent;
  }
  if (input.eventType === "user.message") {
    return input.entryStepAgent;
  }
  return persistedResumeStepAgent;
}

function readResumeStepAgentFromSession(state: unknown): string | undefined {
  return readWaitResumeStepAgent(asRecord(asRecord(state)?.agent));
}

function asInteractionMode(value: unknown): InteractionMode | undefined {
  if (value === "chat" || value === "plan" || value === "build") {
    return value;
  }
  // Legacy input normalization only; runtime payloads must emit "build".
  return value === "act" ? "build" : undefined;
}

function asActSubmode(value: unknown): ActSubmode | undefined {
  return value === "strict" || value === "safe" || value === "full_auto"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
