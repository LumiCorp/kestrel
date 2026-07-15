import { randomUUID } from "node:crypto";

import type {
  NormalizedOutput,
} from "../kestrel/contracts/execution.js";
import type {
  RuntimeEvent,
} from "../kestrel/contracts/events.js";
import type { ThreadRecord } from "../kestrel/contracts/orchestration.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";
import type {
  ResumeBlockedTurnInput,
  SubmitTurnInput,
  SubmitTurnResult,
  ThreadRuntimePort,
  ThreadStatusSnapshot,
} from "../orchestration/contracts.js";
import {
  buildRuntimeOperatorAffordance,
} from "../orchestration/OperatorAffordanceProjection.js";
import {
  toOperatorAssemblySummary,
} from "../orchestration/OperatorSessionProjection.js";
import { createRuntimeFailure } from "./RuntimeFailure.js";
import { finalizeRuntimeAssistantResponse } from "./assistantResponseContract.js";
import {
  materializeCompiledRuntimeTurn,
  prepareRuntimeTurn,
  type CompileRuntimeTurnDefaults,
  type PreparedRuntimeTurn,
  resolveRuntimeRecoveryContinuation,
  type RuntimeTurnCoordinator,
  type RuntimeTurnInput,
  type RuntimeTurnResult,
} from "./RuntimeTurn.js";
import { syncRuntimeWorkspaceScratchpad } from "./RuntimeWorkspaceScratchpad.js";

export type RuntimeTurnThreadRuntime = Pick<
  ThreadRuntimePort,
  "ensureMainThreadForSession" | "submitTurn" | "resumeBlockedTurn" | "getThreadStatus"
>;

export interface RuntimeTurnCoordinatorServiceOptions {
  defaults: CompileRuntimeTurnDefaults;
  threadRuntime?: RuntimeTurnThreadRuntime | undefined;
  directRun: (
    event: RuntimeEvent,
    options?: { signal?: AbortSignal | undefined },
  ) => Promise<NormalizedOutput>;
  getSession?: ((sessionId: string) => Promise<SessionRecord | undefined>) | undefined;
  readFinalizedPayload?: ((sessionId: string) => Promise<unknown>) | undefined;
  readPersistedResumeStepAgent?: ((sessionId: string) => Promise<string | undefined>) | undefined;
  buildOperatorAffordance?: ((input: {
    session: SessionRecord | undefined;
    turn: RuntimeTurnInput;
    output: NormalizedOutput;
    threadStatus?: ThreadStatusSnapshot | null | undefined;
  }) => unknown) | undefined;
}

export class RuntimeTurnCoordinatorService implements RuntimeTurnCoordinator {
  private readonly defaults: CompileRuntimeTurnDefaults;
  private readonly threadRuntime: RuntimeTurnThreadRuntime | undefined;
  private readonly directRun: RuntimeTurnCoordinatorServiceOptions["directRun"];
  private readonly getSession: RuntimeTurnCoordinatorServiceOptions["getSession"];
  private readonly readFinalizedPayload: RuntimeTurnCoordinatorServiceOptions["readFinalizedPayload"];
  private readonly readPersistedResumeStepAgent: RuntimeTurnCoordinatorServiceOptions["readPersistedResumeStepAgent"];
  private readonly buildOperatorAffordance: RuntimeTurnCoordinatorServiceOptions["buildOperatorAffordance"];

  constructor(options: RuntimeTurnCoordinatorServiceOptions) {
    this.defaults = options.defaults;
    this.threadRuntime = options.threadRuntime;
    this.directRun = options.directRun;
    this.getSession = options.getSession;
    this.readFinalizedPayload = options.readFinalizedPayload;
    this.readPersistedResumeStepAgent = options.readPersistedResumeStepAgent;
    this.buildOperatorAffordance = options.buildOperatorAffordance;
  }

  async runTurn(
    input: RuntimeTurnInput,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<RuntimeTurnResult> {
    const prepared = prepareRuntimeTurn(input, this.defaults);
    const firstResult = await this.executePreparedTurn(prepared, options);
    const recoveryContinuation = await resolveRuntimeRecoveryContinuation({
      output: firstResult.output,
      readPersistedResumeStepAgent: async () => this.readPersistedResumeStepAgent?.(input.sessionId),
    });
    const result = recoveryContinuation === undefined
      ? firstResult
      : await this.executePreparedTurn(
          prepareRuntimeTurn(
            {
              ...prepared.input,
              eventType: recoveryContinuation.eventType,
              stepAgent: recoveryContinuation.stepAgent,
              manualCompaction: recoveryContinuation.manualCompaction,
              resumeBlockedRun: recoveryContinuation.resumeBlockedRun,
            },
            this.defaults,
          ),
          options,
        );

    const finalizedPayload = result.finalizedPayload !== undefined
      ? result.finalizedPayload
      : result.output.status === "COMPLETED"
        ? await this.readFinalizedPayload?.(input.sessionId)
        : undefined;
    const session = result.session ?? await this.getSession?.(input.sessionId);
    const canonicalResponse = finalizeRuntimeAssistantResponse({
      output: result.output,
      assistantText:
        result.assistantText !== undefined
          ? result.assistantText
          : readAssistantText(asRecord(session?.state.agent)?.assistantText),
      request: selectCurrentInteractionRequest(result.threadStatus),
    });
    const output = canonicalResponse.output;
    const assistantText = canonicalResponse.assistantText;
    const affordanceInput = {
      session,
      turn: {
        ...result.prepared.input,
        manualCompaction: result.prepared.compaction.apply,
      },
      output,
      threadStatus: result.threadStatus,
    };
    const operatorAffordance =
      this.buildOperatorAffordance !== undefined
        ? this.buildOperatorAffordance(affordanceInput)
        : buildDefaultOperatorAffordance(affordanceInput);
    if (result.prepared.input.workspace !== undefined) {
      try {
        await syncRuntimeWorkspaceScratchpad({
          workspace: result.prepared.input.workspace,
          session,
          output,
          operatorAffordance,
        });
      } catch {
        // Scratchpad persistence is advisory and must never fail a turn.
      }
    }

    return {
      output,
      assistantText,
      ...(finalizedPayload !== undefined ? { finalizedPayload } : {}),
      ...(operatorAffordance !== undefined ? { operatorAffordance } : {}),
    };
  }

  private async executePreparedTurn(
    prepared: PreparedRuntimeTurn,
    options: { signal?: AbortSignal | undefined },
  ): Promise<RuntimeTurnExecutionResult> {
    if (this.threadRuntime === undefined) {
      const compiled = materializeCompiledRuntimeTurn(prepared);
      const output = await this.directRun({
        id: compiled.input.runId ?? randomUUID(),
        type: compiled.input.eventType,
        sessionId: compiled.input.sessionId,
        payload: compiled.payload,
        ...(compiled.input.stepAgent !== undefined ? { stepAgent: compiled.input.stepAgent } : {}),
      }, options);
      return { prepared, output };
    }

    const mainThread = await this.threadRuntime.ensureMainThreadForSession({
      sessionId: prepared.input.sessionId,
      title: prepared.input.sessionId,
    });
    if (mainThread === undefined) {
      throw createRuntimeFailure(
        "THREAD_MAIN_RESOLUTION_FAILED",
        `Session '${prepared.input.sessionId}' does not have a canonical main thread.`,
        {
          sessionId: prepared.input.sessionId,
        },
      );
    }

    const result = prepared.input.resumeBlockedRun === true
      ? await this.threadRuntime.resumeBlockedTurn(this.buildResumeBlockedTurnInput(prepared, mainThread, options))
      : await this.threadRuntime.submitTurn(this.buildSubmitTurnInput(prepared, mainThread, options));
    const threadStatus = await this.threadRuntime.getThreadStatus(mainThread.threadId);
    return {
      prepared,
      output: result.output,
      assistantText: result.assistantText,
      session: result.session,
      finalizedPayload: result.finalizedPayload,
      threadStatus,
    };
  }

  private buildResumeBlockedTurnInput(
    prepared: PreparedRuntimeTurn,
    mainThread: ThreadRecord,
    options: { signal?: AbortSignal | undefined },
  ): ResumeBlockedTurnInput {
    return {
      threadId: mainThread.threadId,
      requestId: requireResumeRequestId(prepared.input),
      message: prepared.input.message,
      interactionMode: prepared.resolvedMode.interactionMode,
      actSubmode: prepared.resolvedMode.actSubmode,
      executionPolicy: prepared.input.executionPolicy,
      signal: options.signal,
      actor: prepared.input.actor,
      ...(prepared.input.attachments !== undefined ? { attachments: prepared.input.attachments } : {}),
      runtimeTurn: {
        ...prepared.input,
        manualCompaction: prepared.compaction.apply,
      },
    };
  }

  private buildSubmitTurnInput(
    prepared: PreparedRuntimeTurn,
    mainThread: ThreadRecord,
    options: { signal?: AbortSignal | undefined },
  ): SubmitTurnInput {
    return {
      threadId: mainThread.threadId,
      message: prepared.input.message,
      eventType: prepared.input.eventType,
      ...(prepared.input.attachments !== undefined ? { attachments: prepared.input.attachments } : {}),
      interactionMode: prepared.resolvedMode.interactionMode,
      actSubmode: prepared.resolvedMode.actSubmode,
      ...(prepared.input.stepAgent !== undefined ? { stepAgent: prepared.input.stepAgent } : {}),
      ...(prepared.input.executionPolicy !== undefined ? { executionPolicy: prepared.input.executionPolicy } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(prepared.compaction.apply === true ? { manualCompaction: true } : {}),
      ...(prepared.input.autoCompaction !== undefined ? { autoCompaction: prepared.input.autoCompaction } : {}),
      metadata: prepared.metadata,
      runtimeTurn: {
        ...prepared.input,
        manualCompaction: prepared.compaction.apply,
      },
    };
  }
}

function requireResumeRequestId(input: RuntimeTurnInput): string {
  const requestId = input.resumeRequestId?.trim();
  if (requestId === undefined || requestId.length === 0) {
    throw createRuntimeFailure(
      "THREAD_RESUME_REQUEST_NOT_FOUND",
      "A blocked runtime resume requires the exact pending request ID.",
      { sessionId: input.sessionId },
    );
  }
  return requestId;
}

interface RuntimeTurnExecutionResult {
  prepared: PreparedRuntimeTurn;
  output: NormalizedOutput;
  assistantText?: string | null | undefined;
  session?: SessionRecord | undefined;
  finalizedPayload?: unknown | undefined;
  threadStatus?: ThreadStatusSnapshot | null | undefined;
}

function buildDefaultOperatorAffordance(input: {
  session: SessionRecord | undefined;
  turn: RuntimeTurnInput;
  output: NormalizedOutput;
  threadStatus?: ThreadStatusSnapshot | null | undefined;
}): unknown {
  return buildRuntimeOperatorAffordance({
    reactState: asRecord(input.session?.state.agent),
    turn: input.turn,
    output: input.output,
    ...(input.threadStatus !== null && input.threadStatus !== undefined
      ? { activeAssembly: toOperatorAssemblySummary(input.threadStatus) }
      : {}),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readAssistantText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function selectCurrentInteractionRequest(
  status: ThreadStatusSnapshot | null | undefined,
): ThreadStatusSnapshot["openRequests"][number] | undefined {
  if (status === null || status === undefined) {
    return undefined;
  }
  const currentRequestId = status.thread.currentRequestId;
  if (typeof currentRequestId === "string") {
    const current = status.openRequests.find(
      (request) => request.requestId === currentRequestId,
    );
    if (current !== undefined) {
      return current;
    }
  }
  return status.openRequests[0];
}
