import { createHash } from "node:crypto";

import type {
  RunnerCommandMetadata,
  RunnerCommandPayloadByType,
  RunnerCommandType,
  RunnerEvent,
} from "@kestrel-agents/protocol";

import type { MissionControlProjectRepository } from "../kestrel/contracts/store.js";
import {
  MissionControlRevisionConflictError,
  type MissionControlExecutionAttempt,
  type MissionControlOutboxRecord,
  type MissionControlProjectMutationResult,
  type MissionControlProjectStateRecord,
  type MissionControlWorkItem,
  requireMissionControlProjectId,
} from "./projectAuthority.js";
import {
  MissionControlExecutionService,
  parseMissionControlExecutionAction,
  type MissionControlExecutionAction,
} from "./executionAuthority.js";

export interface MissionControlRunnerCommandClient {
  onEvent(listener: (event: RunnerEvent) => void): () => void;
  sendCommandWithId<TType extends RunnerCommandType>(
    commandId: string,
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    metadata?: RunnerCommandMetadata | undefined,
  ): Promise<RunnerEvent>;
}

export interface MissionControlExecutionRuntimeOptions {
  commandMetadata?: RunnerCommandMetadata | undefined;
  now?: (() => string) | undefined;
}

type ExecutionRepository = Pick<
  MissionControlProjectRepository,
  | "getMissionControlProjectState"
  | "updateMissionControlProjectState"
  | "listMissionControlOutbox"
> & {
  markMissionControlOutboxDelivered(
    projectId: string,
    effectId: string,
  ): Promise<void>;
  recordMissionControlOutboxFailure(
    projectId: string,
    effectId: string,
    error: string,
  ): Promise<void>;
};

type EffectKind = "start" | "retry" | "reply" | "cancel";

interface DispatchContext {
  projectId: string;
  itemId: string;
  attemptId: string;
  effectId: string;
  kind: EffectKind;
}

interface RunnerProjection {
  projectId: string;
  itemId: string;
  attemptId: string;
  runId: string;
  sessionId: string;
  threadId: string;
  status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  commandId: string;
  observedAt: string;
  terminalReasonCode?: string | undefined;
  errorMessage?: string | undefined;
  wait?: {
    kind:
      | "approval"
      | "user_input"
      | "delegation"
      | "scheduler_wait"
      | "compaction_checkpoint"
      | "unknown";
    requestId: string;
    eventType?: string | undefined;
    enteredAt?: string | undefined;
  } | undefined;
}

export class MissionControlExecutionRuntime {
  private readonly store: ExecutionRepository;
  private readonly runner: MissionControlRunnerCommandClient;
  private readonly options: MissionControlExecutionRuntimeOptions;
  private readonly execution: MissionControlExecutionService;
  private readonly dispatching = new Set<string>();
  private readonly contexts = new Map<string, DispatchContext>();
  private readonly projectQueues = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(
    store: ExecutionRepository,
    runner: MissionControlRunnerCommandClient,
    options: MissionControlExecutionRuntimeOptions = {},
  ) {
    this.store = store;
    this.runner = runner;
    this.options = options;
    this.execution = new MissionControlExecutionService(store);
    this.unsubscribe = runner.onEvent((event) => {
      const context =
        event.commandId === undefined
          ? undefined
          : this.contexts.get(event.commandId);
      if (
        context === undefined ||
        this.dispatching.has(context.effectId)
      ) {
        return;
      }
      void this.enqueue(context.projectId, async () => {
        await this.consumeContextEvent(context, event);
      });
    });
  }

  close(): void {
    this.unsubscribe();
    this.contexts.clear();
  }

  async execute(
    actionValue: unknown,
  ): Promise<MissionControlProjectMutationResult> {
    const action = parseMissionControlExecutionAction(actionValue);
    const result = await this.execution.execute(action);
    void this.dispatchPending(action.projectId);
    return result;
  }

  async dispatchPending(projectIdValue: unknown): Promise<void> {
    const projectId = requireMissionControlProjectId(projectIdValue);
    await this.enqueue(projectId, async () => {
      const effects = await this.store.listMissionControlOutbox(projectId);
      for (const effect of effects) {
        if (effect.status !== "PENDING" || this.dispatching.has(effect.effectId)) {
          continue;
        }
        this.dispatching.add(effect.effectId);
        try {
          await this.dispatchEffect(effect);
        } finally {
          this.dispatching.delete(effect.effectId);
        }
      }
    });
  }

  async reconcile(projectIdValue: unknown): Promise<void> {
    const projectId = requireMissionControlProjectId(projectIdValue);
    await this.enqueue(projectId, async () => {
      await this.reconcileProject(projectId);
    });
    await this.dispatchPending(projectId);
  }

  private async dispatchEffect(effect: MissionControlOutboxRecord): Promise<void> {
    const context = parseDispatchContext(effect);
    this.contexts.set(effect.effectId, context);
    try {
      switch (context.kind) {
        case "start":
          await this.dispatchStart(effect, context);
          return;
        case "retry":
          await this.dispatchOperatorContinuation(effect, context, "retry");
          return;
        case "reply":
          await this.dispatchOperatorContinuation(effect, context, "reply");
          return;
        case "cancel":
          await this.dispatchCancel(effect, context);
          return;
      }
    } catch (error) {
      await this.handleDispatchError(effect, context, error);
    }
  }

  private async dispatchStart(
    effect: MissionControlOutboxRecord,
    context: DispatchContext,
  ): Promise<void> {
    const payload = effect.payload;
    const profileId = text(payload.profileId, "profileId");
    const sessionId = text(payload.sessionId, "sessionId");
    const threadId = text(payload.threadId, "threadId");
    const runId = text(payload.runId, "runId");
    const message = text(payload.message, "message");
    const workspaceRoot = optionalText(payload.workspaceRoot);
    const projectRevision = positiveInteger(
      payload.projectRevision,
      "projectRevision",
    );
    if (sessionId !== threadId) {
      throw new Error("Mission Control start session and thread must match.");
    }

    const { terminal, acceptance } = beginContextAcceptance(
      this.runner,
      effect.effectId,
      () =>
        this.runner.sendCommandWithId(
          effect.effectId,
          "run.start",
          {
            profileId,
            turn: {
              sessionId,
              runId,
              message,
              eventType: "mission_control.work_item",
              projectContext: {
                projectId: effect.projectId,
                contextRevisionId: `mission-control:${projectRevision}`,
                contextRevision: projectRevision,
                content: message,
              },
              missionControl: {
                projectId: effect.projectId,
                itemId: context.itemId,
                attemptId: context.attemptId,
                commandId: effect.effectId,
                runId,
              },
              ...(workspaceRoot === undefined
                ? {}
                : {
                    workspace: {
                      workspaceId: `mission-control:${effect.projectId}`,
                      workspaceRoot,
                      appRoot: ".",
                      commands: {},
                    },
                  }),
            },
          },
          this.options.commandMetadata,
        ),
    );
    const accepted = await acceptance;
    await this.consumeContextEvent(context, accepted);
    void terminal.catch(async (error) => {
      await this.enqueue(effect.projectId, async () => {
        await this.handleDispatchError(effect, context, error);
      });
    });
  }

  private async dispatchOperatorContinuation(
    effect: MissionControlOutboxRecord,
    context: DispatchContext,
    action: "retry" | "reply",
  ): Promise<void> {
    const threadId = text(effect.payload.threadId, "threadId");
    const runId = text(effect.payload.runId, "runId");
    const message = text(effect.payload.message, "message");
    const requestId =
      action === "reply"
        ? text(effect.payload.requestId, "requestId")
        : undefined;
    const response = await this.runner.sendCommandWithId(
      effect.effectId,
      "operator.control",
      {
        action,
        threadId,
        completionMode: "accepted",
        message,
        ...(requestId === undefined ? {} : { requestId }),
        missionControl: {
          projectId: effect.projectId,
          itemId: context.itemId,
          attemptId: context.attemptId,
          commandId: effect.effectId,
          runId,
        },
      },
      this.options.commandMetadata,
    );
    if (response.type !== "operator.controlled") {
      throw new Error(
        `Mission Control ${action} received ${response.type} instead of operator.controlled.`,
      );
    }
    const acceptedSessionId =
      response.sessionId ?? response.payload.sessionId;
    const acceptedThreadId =
      response.threadId ?? response.payload.threadId;
    const acceptedRunId =
      response.runId ?? response.payload.runId;
    if (
      acceptedSessionId === undefined ||
      acceptedThreadId === undefined ||
      acceptedRunId === undefined ||
      response.commandId !== effect.effectId ||
      acceptedThreadId !== threadId ||
      acceptedRunId !== runId
    ) {
      throw new Error(
        `Mission Control ${action} acceptance identity did not match its outbox effect.`,
      );
    }

    if (action === "retry") {
      await this.applyAttemptAction(context, (state) => {
        if (state.attempt.status !== "starting") {
          return;
        }
        return {
          type: "execution.accepted",
          sessionId: acceptedSessionId,
          threadId: acceptedThreadId,
          runId: acceptedRunId,
          commandId: effect.effectId,
        };
      }, response.ts, `runner:${response.id}`);
    } else {
      await this.applyAttemptAction(context, (state) => {
        if (
          state.attempt.status !== "waiting" ||
          state.attempt.pendingRequest?.requestId !== requestId
        ) {
          return;
        }
        return {
          type: "execution.resumed",
          requestId: requestId!,
          sessionId: acceptedSessionId,
          threadId: acceptedThreadId,
          runId: acceptedRunId,
          commandId: effect.effectId,
        };
      }, response.ts, `runner:${response.id}`);
    }
    await this.store.markMissionControlOutboxDelivered(
      effect.projectId,
      effect.effectId,
    );
  }

  private async dispatchCancel(
    effect: MissionControlOutboxRecord,
    context: DispatchContext,
  ): Promise<void> {
    const sessionId = text(effect.payload.sessionId, "sessionId");
    const runId = text(effect.payload.runId, "runId");
    const commandId = text(effect.payload.commandId, "commandId");
    const response = await this.runner.sendCommandWithId(
      effect.effectId,
      "run.cancel",
      { sessionId, runId, commandId },
      this.options.commandMetadata,
    );
    if (response.type !== "run.cancelled") {
      throw new Error(
        `Mission Control cancel received ${response.type} instead of run.cancelled.`,
      );
    }
    const cancelledRunId = response.runId ?? response.payload.runId;
    if (cancelledRunId !== runId) {
      throw new Error(
        "Mission Control cancellation response did not match the targeted run.",
      );
    }
    await this.applyAttemptAction(context, (state) => {
      if (state.attempt.status !== "cancelling") {
        return;
      }
      return {
        type: "execution.cancel_confirmed",
        runId,
        outcome: "cancelled",
      };
    }, response.ts, `runner:${response.id}`);
    await this.store.markMissionControlOutboxDelivered(
      effect.projectId,
      effect.effectId,
    );
    this.contexts.delete(effect.effectId);
  }

  private async consumeContextEvent(
    context: DispatchContext,
    event: RunnerEvent,
  ): Promise<void> {
    if (context.kind === "cancel") {
      return;
    }
    if (context.kind === "start" && event.type === "run.started") {
      const sessionId = event.sessionId ?? event.payload.sessionId;
      const threadId = event.threadId;
      const runId = event.runId ?? event.payload.runId;
      if (
        sessionId === undefined ||
        threadId === undefined ||
        runId === undefined ||
        event.commandId === undefined
      ) {
        throw new Error(
          "Mission Control runner acceptance omitted an execution identity.",
        );
      }
      await this.applyAttemptAction(context, (state) => {
        if (state.attempt.status !== "starting") {
          return;
        }
        return {
          type: "execution.accepted",
          sessionId,
          threadId,
          runId,
          commandId: event.commandId!,
        };
      }, event.ts, `runner:${event.id}`);
      await this.store.markMissionControlOutboxDelivered(
        context.projectId,
        context.effectId,
      );
      return;
    }
    if (event.type === "run.progress" &&
        event.payload.update.code === "WAITING_FOR_EVENT") {
      await this.reconcileProject(context.projectId);
      return;
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      await this.applyTerminalEvent(context, event);
      this.contexts.delete(context.effectId);
    }
  }

  private async applyTerminalEvent(
    context: DispatchContext,
    event: Extract<
      RunnerEvent,
      { type: "run.completed" | "run.failed" | "run.cancelled" }
    >,
  ): Promise<void> {
    const runId =
      event.runId ??
      (event.type === "run.cancelled"
        ? event.payload.runId
        : event.payload.result?.output.runId);
    if (runId === undefined) {
      throw new Error("Mission Control terminal event omitted runId.");
    }
    await this.applyAttemptAction(context, (state) => {
      if (state.attempt.status === "starting") {
        if (event.type === "run.failed") {
          return {
            type: "execution.start_rejected",
            reason: event.payload.error.message,
            reasonCode: event.payload.error.code,
          };
        }
        return;
      }
      const currentRun = resolveCurrentRun(state.attempt);
      if (currentRun?.runId !== runId) {
        return terminalHistoryAction(event, runId);
      }
      if (event.type === "run.completed") {
        return { type: "execution.completed", runId };
      }
      if (event.type === "run.cancelled") {
        return {
          type: "execution.cancel_confirmed",
          runId,
          outcome: "cancelled",
        };
      }
      if (event.payload.error.code === "RUN_CANCELLED") {
        return {
          type: "execution.cancel_confirmed",
          runId,
          outcome: "cancelled",
        };
      }
      if (event.payload.error.code === "RUNNER_ORPHANED_ACTIVE_RUN") {
        return {
          type: "execution.orphaned",
          runId,
          reason: event.payload.error.message,
          reasonCode: event.payload.error.code,
        };
      }
      return {
        type: "execution.failed",
        runId,
        reason: event.payload.error.message,
        reasonCode: event.payload.error.code,
      };
    }, event.ts, `runner:${event.id}`);
  }

  private async handleDispatchError(
    effect: MissionControlOutboxRecord,
    context: DispatchContext,
    error: unknown,
  ): Promise<void> {
    const failure = runnerFailure(error);
    if (failure.code === undefined) {
      await this.store.recordMissionControlOutboxFailure(
        effect.projectId,
        effect.effectId,
        failure.message,
      );
      return;
    }

    if (context.kind === "cancel" && failure.code === "RUN_CANCEL_NOT_FOUND") {
      const activeRunId = optionalText(failure.details?.activeRunId);
      const activeCommandId = optionalText(failure.details?.activeCommandId);
      const outcome =
        activeRunId === undefined && activeCommandId === undefined
          ? "already_stopped"
          : "run_changed";
      await this.applyAttemptAction(context, (state) => {
        if (state.attempt.status !== "cancelling") {
          return;
        }
        return {
          type: "execution.stop_rejected",
          outcome,
          ...(activeRunId === undefined ? {} : { activeRunId }),
          ...(activeCommandId === undefined ? {} : { activeCommandId }),
        };
      }, this.now(), `runner-rejection:${effect.effectId}`);
      await this.store.markMissionControlOutboxDelivered(
        effect.projectId,
        effect.effectId,
      );
      this.contexts.delete(effect.effectId);
      await this.reconcileProject(effect.projectId);
      return;
    }

    if (context.kind === "start" || context.kind === "retry") {
      await this.applyAttemptAction(context, (state) => {
        if (state.attempt.status !== "starting") {
          return;
        }
        return {
          type: "execution.start_rejected",
          reason: failure.message,
          reasonCode: failure.code,
        };
      }, this.now(), `runner-rejection:${effect.effectId}`);
    } else {
      await this.reconcileProject(effect.projectId);
    }
    await this.store.markMissionControlOutboxDelivered(
      effect.projectId,
      effect.effectId,
    );
    this.contexts.delete(effect.effectId);
  }

  private async reconcileProject(projectId: string): Promise<void> {
    const project = await this.execution.projects.getProject(projectId);
    const outbox = await this.store.listMissionControlOutbox(projectId);
    for (const item of Object.values(project.document.items)) {
      const attempt = resolveCurrentAttempt(item);
      if (attempt === undefined || isTerminal(attempt.status)) {
        continue;
      }
      const candidateRunIds = exactCandidateRunIds(attempt, outbox);
      let projection: RunnerProjection | undefined;
      for (const runId of candidateRunIds) {
        const inspected = await this.inspectRun(runId);
        if (inspected === undefined) {
          continue;
        }
        if (
          inspected.projectId !== projectId ||
          inspected.itemId !== item.id ||
          inspected.attemptId !== attempt.id ||
          inspected.commandId !==
            correlationCommandIdForRun(attempt, outbox, runId) ||
          inspected.runId !== runId
        ) {
          await this.applyReconciliationOrphan(
            projectId,
            item.id,
            attempt.id,
            "Runner correlation does not match the canonical attempt.",
            "MISSION_CONTROL_RUN_CORRELATION_MISMATCH",
          );
          projection = undefined;
          break;
        }
        projection = inspected;
        break;
      }

      if (projection === undefined) {
        const hasPendingDispatch = outbox.some(
          (effect) =>
            effect.status === "PENDING" &&
            effect.payload.itemId === item.id &&
            effect.payload.attemptId === attempt.id,
        );
        if (attempt.status === "starting" && hasPendingDispatch) {
          continue;
        }
        if (attempt.status !== "starting" || hasPendingDispatch === false) {
          await this.applyReconciliationOrphan(
            projectId,
            item.id,
            attempt.id,
            "No authoritative runner state exists for the nonterminal attempt.",
            "MISSION_CONTROL_RUN_AUTHORITY_MISSING",
          );
        }
        continue;
      }
      await this.applyProjection(projectId, item.id, attempt.id, projection);
      const acceptedEffect = outbox.find(
        (effect) =>
          effect.effectId === projection.commandId &&
          effect.status !== "DELIVERED",
      );
      if (acceptedEffect !== undefined) {
        await this.store.markMissionControlOutboxDelivered(
          projectId,
          acceptedEffect.effectId,
        );
      }
      if (
        projection.status === "COMPLETED" ||
        projection.status === "FAILED"
      ) {
        const settledCancel = outbox.find(
          (effect) =>
            effect.status === "PENDING" &&
            effect.effectType === "mission-control.execution.cancel" &&
            effect.payload.itemId === item.id &&
            effect.payload.attemptId === attempt.id &&
            effect.payload.runId === projection.runId,
        );
        if (settledCancel !== undefined) {
          await this.store.markMissionControlOutboxDelivered(
            projectId,
            settledCancel.effectId,
          );
        }
      }
    }
  }

  private async inspectRun(runId: string): Promise<RunnerProjection | undefined> {
    try {
      const response = await this.runner.sendCommandWithId(
        readCommandId("inspect", runId),
        "operator.run",
        { runId },
        this.options.commandMetadata,
      );
      if (response.type !== "operator.run") {
        throw new Error(
          `Mission Control inspection received ${response.type} instead of operator.run.`,
        );
      }
      return parseRunnerProjection(response.payload.view);
    } catch (error) {
      const failure = runnerFailure(error);
      if (failure.code === "OPERATOR_RUN_NOT_FOUND") {
        return;
      }
      throw error;
    }
  }

  private async applyProjection(
    projectId: string,
    itemId: string,
    attemptId: string,
    projection: RunnerProjection,
  ): Promise<void> {
    const initial = await this.execution.projects.getProject(projectId);
    const initialItem = initial.document.items[itemId];
    const initialAttempt = initialItem?.attempts.find(
      (entry) => entry.id === attemptId,
    );
    if (
      initialAttempt === undefined ||
      projectionMatchesAttempt(initialAttempt, projection)
    ) {
      return;
    }
    const context: DispatchContext = {
      projectId,
      itemId,
      attemptId,
      effectId: projection.commandId,
      kind: "start",
    };
    const timestamp = projection.observedAt;
    await this.applyAttemptAction(context, (state) => {
      const current = resolveCurrentRun(state.attempt);
      if (state.attempt.status === "starting") {
        return {
          type: "execution.accepted",
          sessionId: projection.sessionId,
          threadId: projection.threadId,
          runId: projection.runId,
          commandId: projection.commandId,
        };
      }
      if (
        state.attempt.status === "waiting" &&
        current?.runId !== projection.runId &&
        state.attempt.pendingRequest !== undefined
      ) {
        return {
          type: "execution.resumed",
          requestId: state.attempt.pendingRequest.requestId,
          sessionId: projection.sessionId,
          threadId: projection.threadId,
          runId: projection.runId,
          commandId: projection.commandId,
        };
      }
      if (
        projection.status === "RUNNING" &&
        state.attempt.status === "waiting"
      ) {
        return {
          type: "execution.orphaned",
          ...(current?.runId === undefined ? {} : { runId: current.runId }),
          reason:
            "Runner resumed without the exact pending Mission Control response identity.",
          reasonCode: "MISSION_CONTROL_RESUME_IDENTITY_MISSING",
        };
      }
      if (projection.status === "WAITING") {
        if (projection.wait === undefined) {
          return {
            type: "execution.orphaned",
            runId: projection.runId,
            reason: "Runner reported Waiting without an exact pending request.",
            reasonCode: "MISSION_CONTROL_WAIT_IDENTITY_MISSING",
          };
        }
        return {
          type: "execution.waiting",
          runId: projection.runId,
          request: {
            requestId: projection.wait.requestId,
            threadId: projection.threadId,
            kind: projection.wait.kind,
            ...(projection.wait.eventType === undefined
              ? {}
              : { eventType: projection.wait.eventType }),
            ...(projection.wait.enteredAt === undefined
              ? {}
              : { enteredAt: projection.wait.enteredAt }),
          },
        };
      }
      if (projection.status === "COMPLETED") {
        return { type: "execution.completed", runId: projection.runId };
      }
      if (projection.status === "FAILED") {
        if (projection.terminalReasonCode === "RUN_CANCELLED") {
          return {
            type: "execution.cancel_confirmed",
            runId: projection.runId,
            outcome: "already_stopped",
          };
        }
        if (projection.terminalReasonCode === "RUNNER_ORPHANED_ACTIVE_RUN") {
          return {
            type: "execution.orphaned",
            runId: projection.runId,
            reason:
              projection.errorMessage ??
              "Runner recovered an orphaned active run.",
            reasonCode: projection.terminalReasonCode,
          };
        }
        return {
          type: "execution.failed",
          runId: projection.runId,
          reason: projection.errorMessage ?? "Runner reported execution failure.",
          ...(projection.terminalReasonCode === undefined
            ? {}
            : { reasonCode: projection.terminalReasonCode }),
        };
      }
      return;
    }, timestamp, reconcileActionId(projectId, attemptId, projection));

    const refreshed = await this.execution.projects.getProject(projectId);
    const refreshedItem = refreshed.document.items[itemId];
    const refreshedAttempt =
      refreshedItem?.attempts.find((entry) => entry.id === attemptId);
    if (
      refreshedAttempt === undefined ||
      (
        isTerminal(refreshedAttempt.status) &&
        projection.status !== "COMPLETED" &&
        projection.status !== "FAILED"
      ) ||
      projectionMatchesAttempt(refreshedAttempt, projection)
    ) {
      return;
    }
    await this.applyProjection(projectId, itemId, attemptId, projection);
  }

  private async applyReconciliationOrphan(
    projectId: string,
    itemId: string,
    attemptId: string,
    reason: string,
    reasonCode: string,
  ): Promise<void> {
    const context: DispatchContext = {
      projectId,
      itemId,
      attemptId,
      effectId: reasonCode,
      kind: "start",
    };
    const timestamp = this.now();
    await this.applyAttemptAction(context, (state) => {
      if (isTerminal(state.attempt.status)) {
        return;
      }
      return {
        type: "execution.orphaned",
        ...(resolveCurrentRun(state.attempt)?.runId === undefined
          ? {}
          : { runId: resolveCurrentRun(state.attempt)!.runId }),
        reason,
        reasonCode,
      };
    }, timestamp, reconcileActionId(
      projectId,
      attemptId,
      {
        runId: resolveHash(reason),
        status: "FAILED",
        commandId: reasonCode,
        observedAt: timestamp,
      },
    ));
  }

  private async applyAttemptAction(
    context: Pick<DispatchContext, "projectId" | "itemId" | "attemptId">,
    build: (state: {
      project: MissionControlProjectStateRecord;
      item: MissionControlWorkItem;
      attempt: MissionControlExecutionAttempt;
    }) => Omit<
      Extract<MissionControlExecutionAction, { attemptId: string }>,
      | "projectId"
      | "actionId"
      | "actionTs"
      | "expectedRevision"
      | "itemId"
      | "expectedItemVersion"
      | "attemptId"
      | "expectedAttemptVersion"
    > | undefined,
    actionTs: string,
    actionId: string,
  ): Promise<void> {
    for (;;) {
      const project = await this.execution.projects.getProject(context.projectId);
      const item = project.document.items[context.itemId];
      const attempt = item?.attempts.find(
        (entry) => entry.id === context.attemptId,
      );
      if (item === undefined || attempt === undefined) {
        return;
      }
      const action = build({ project, item, attempt });
      if (action === undefined) {
        return;
      }
      try {
        await this.execution.execute({
          ...action,
          projectId: context.projectId,
          actionId,
          actionTs,
          expectedRevision: project.revision,
          itemId: item.id,
          expectedItemVersion: item.version,
          attemptId: attempt.id,
          expectedAttemptVersion: attempt.version,
        });
        return;
      } catch (error) {
        if (error instanceof MissionControlRevisionConflictError) {
          continue;
        }
        throw error;
      }
    }
  }

  private enqueue(projectId: string, operation: () => Promise<void>): Promise<void> {
    const prior = this.projectQueues.get(projectId) ?? Promise.resolve();
    const next = prior.then(operation, operation);
    const queued = next.finally(() => {
      if (this.projectQueues.get(projectId) === queued) {
        this.projectQueues.delete(projectId);
      }
    });
    this.projectQueues.set(projectId, queued);
    return next;
  }

  private now(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }
}

function parseDispatchContext(effect: MissionControlOutboxRecord): DispatchContext {
  const kind = effectKind(effect.effectType);
  return {
    projectId: effect.projectId,
    itemId: text(effect.payload.itemId, "itemId"),
    attemptId: text(effect.payload.attemptId, "attemptId"),
    effectId: effect.effectId,
    kind,
  };
}

function effectKind(effectType: string): EffectKind {
  switch (effectType) {
    case "mission-control.execution.start":
      return "start";
    case "mission-control.execution.retry":
      return "retry";
    case "mission-control.execution.reply":
      return "reply";
    case "mission-control.execution.cancel":
      return "cancel";
    default:
      throw new Error(`Unsupported Mission Control outbox effect: ${effectType}.`);
  }
}

function exactCandidateRunIds(
  attempt: MissionControlExecutionAttempt,
  outbox: MissionControlOutboxRecord[],
): string[] {
  const ids: string[] = [];
  if (attempt.pendingResponse !== undefined) {
    ids.push(attempt.pendingResponse.runId);
  }
  if (attempt.currentRunId !== undefined && ids.includes(attempt.currentRunId) === false) {
    ids.push(attempt.currentRunId);
  }
  if (ids.includes(attempt.dispatchRunId) === false) {
    ids.push(attempt.dispatchRunId);
  }
  for (const effect of outbox) {
    if (
      effect.payload.attemptId !== attempt.id ||
      (effect.effectType !== "mission-control.execution.start" &&
        effect.effectType !== "mission-control.execution.retry" &&
        effect.effectType !== "mission-control.execution.reply")
    ) {
      continue;
    }
    const runId = optionalText(effect.payload.runId);
    if (runId !== undefined && ids.includes(runId) === false) {
      ids.push(runId);
    }
  }
  return ids;
}

function correlationCommandIdForRun(
  attempt: MissionControlExecutionAttempt,
  outbox: MissionControlOutboxRecord[],
  runId: string,
): string {
  if (
    attempt.pendingResponse?.runId === runId
  ) {
    return attempt.pendingResponse.commandId;
  }
  const effect = outbox.find(
    (entry) =>
      entry.payload.attemptId === attempt.id &&
      entry.payload.runId === runId &&
      (entry.effectType === "mission-control.execution.start" ||
        entry.effectType === "mission-control.execution.retry" ||
        entry.effectType === "mission-control.execution.reply"),
  );
  return effect?.effectId ?? attempt.dispatchCommandId;
}

function resolveCurrentAttempt(
  item: MissionControlWorkItem,
): MissionControlExecutionAttempt | undefined {
  return item.currentAttemptId === undefined
    ? undefined
    : item.attempts.find((attempt) => attempt.id === item.currentAttemptId);
}

function resolveCurrentRun(attempt: MissionControlExecutionAttempt) {
  return attempt.currentRunId === undefined
    ? undefined
    : attempt.runs.find((run) => run.runId === attempt.currentRunId);
}

function isTerminal(status: MissionControlExecutionAttempt["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "orphaned"
  );
}

function projectionMatchesAttempt(
  attempt: MissionControlExecutionAttempt,
  projection: RunnerProjection,
): boolean {
  if (attempt.currentRunId !== projection.runId) {
    return false;
  }
  switch (projection.status) {
    case "RUNNING":
      return attempt.status === "running" || attempt.status === "cancelling";
    case "WAITING":
      return (
        (attempt.status === "waiting" &&
          attempt.pendingRequest !== undefined &&
          projection.wait !== undefined &&
          attempt.pendingRequest.requestId === projection.wait.requestId &&
          attempt.pendingRequest.threadId === projection.threadId &&
          attempt.pendingRequest.kind === projection.wait.kind &&
          attempt.pendingRequest.eventType === projection.wait.eventType &&
          attempt.pendingRequest.enteredAt === projection.wait.enteredAt) ||
        attempt.status === "cancelling"
      );
    case "COMPLETED":
      return attempt.status === "completed";
    case "FAILED":
      if (projection.terminalReasonCode === "RUN_CANCELLED") {
        return attempt.status === "cancelled";
      }
      if (projection.terminalReasonCode === "RUNNER_ORPHANED_ACTIVE_RUN") {
        return attempt.status === "orphaned";
      }
      return attempt.status === "failed";
  }
}

function terminalHistoryAction(
  event: Extract<
    RunnerEvent,
    { type: "run.completed" | "run.failed" | "run.cancelled" }
  >,
  runId: string,
) {
  if (event.type === "run.completed") {
    return { type: "execution.completed" as const, runId };
  }
  if (event.type === "run.cancelled") {
    return {
      type: "execution.cancel_confirmed" as const,
      runId,
      outcome: "cancelled" as const,
    };
  }
  return {
    type: "execution.failed" as const,
    runId,
    reason: event.payload.error.message,
    reasonCode: event.payload.error.code,
  };
}

function parseRunnerProjection(value: unknown): RunnerProjection {
  const view = record(value, "operator run view");
  const run = record(view.run, "operator run view.run");
  const diagnosis = record(view.diagnosis, "operator run view.diagnosis");
  const missionControl = record(
    view.missionControl,
    "operator run view.missionControl",
  );
  const runId = text(run.runId, "operator run runId");
  const correlatedRunId = text(
    missionControl.runId,
    "operator run missionControl.runId",
  );
  if (runId !== correlatedRunId) {
    throw new Error("Operator run Mission Control correlation has a different runId.");
  }
  const status = run.status;
  if (
    status !== "RUNNING" &&
    status !== "WAITING" &&
    status !== "COMPLETED" &&
    status !== "FAILED"
  ) {
    throw new Error("Operator run status is invalid.");
  }
  const wait =
    diagnosis.wait === undefined
      ? undefined
      : parseRunnerWait(diagnosis.wait);
  const observedAt = text(
    (status === "COMPLETED" || status === "FAILED"
      ? run.completedAt
      : status === "WAITING"
        ? wait?.enteredAt
        : undefined) ?? run.startedAt,
    "operator run observedAt",
  );
  return {
    projectId: text(
      missionControl.projectId,
      "operator run missionControl.projectId",
    ),
    itemId: text(
      missionControl.itemId,
      "operator run missionControl.itemId",
    ),
    attemptId: text(
      missionControl.attemptId,
      "operator run missionControl.attemptId",
    ),
    runId,
    sessionId: text(run.sessionId, "operator run sessionId"),
    threadId: text(view.threadId, "operator run threadId"),
    status,
    observedAt,
    commandId: text(
      missionControl.commandId,
      "operator run missionControl.commandId",
    ),
    ...(optionalText(diagnosis.terminalReasonCode) === undefined
      ? {}
      : {
          terminalReasonCode: optionalText(
            diagnosis.terminalReasonCode,
          )!,
        }),
    ...(recordOrUndefined(run.error)?.message === undefined
      ? {}
      : {
          errorMessage: text(
            recordOrUndefined(run.error)!.message,
            "operator run error.message",
          ),
        }),
    ...(wait === undefined ? {} : { wait }),
  };
}

function parseRunnerWait(value: unknown): NonNullable<RunnerProjection["wait"]> {
  const wait = record(value, "operator run wait");
  const kind = wait.kind;
  if (
    kind !== "approval" &&
    kind !== "user_input" &&
    kind !== "delegation" &&
    kind !== "scheduler_wait" &&
    kind !== "compaction_checkpoint" &&
    kind !== "unknown"
  ) {
    throw new Error("Operator run wait kind is invalid.");
  }
  return {
    kind,
    requestId: text(wait.requestId, "operator run wait.requestId"),
    ...(optionalText(wait.eventType) === undefined
      ? {}
      : { eventType: optionalText(wait.eventType)! }),
    ...(optionalText(wait.enteredAt) === undefined
      ? {}
      : { enteredAt: optionalText(wait.enteredAt)! }),
  };
}

function runnerFailure(error: unknown): {
  code?: string | undefined;
  message: string;
  details?: Record<string, unknown> | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return { message: String(error) };
  }
  const value = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    message:
      typeof value.message === "string" ? value.message : String(error),
    ...(recordOrUndefined(value.details) === undefined
      ? {}
      : { details: recordOrUndefined(value.details)! }),
  };
}

function beginContextAcceptance(
  runner: MissionControlRunnerCommandClient,
  commandId: string,
  send: () => Promise<RunnerEvent>,
): {
  terminal: Promise<RunnerEvent>;
  acceptance: Promise<RunnerEvent>;
} {
  let unsubscribe = () => {};
  const started = new Promise<RunnerEvent>((resolve) => {
    unsubscribe = runner.onEvent((event) => {
      if (event.commandId !== commandId) {
        return;
      }
      if (event.type === "run.started") {
        resolve(event);
      }
    });
  });
  const terminal = send();
  return {
    terminal,
    acceptance: Promise.race([started, terminal]).finally(unsubscribe),
  };
}

function reconcileActionId(
  projectId: string,
  attemptId: string,
  projection: Pick<
    RunnerProjection,
    "runId" | "status" | "commandId" | "observedAt"
  > & {
    wait?: Pick<
      NonNullable<RunnerProjection["wait"]>,
      "requestId" | "kind" | "eventType" | "enteredAt"
    > | undefined;
    terminalReasonCode?: string | undefined;
  },
): string {
  return `mc-reconcile-${resolveHash(
    JSON.stringify({
      projectId,
      attemptId,
      runId: projection.runId,
      commandId: projection.commandId,
      status: projection.status,
      observedAt: projection.observedAt,
      wait: projection.wait === undefined
        ? null
        : {
            requestId: projection.wait.requestId,
            kind: projection.wait.kind,
            eventType: projection.wait.eventType ?? null,
            enteredAt: projection.wait.enteredAt ?? null,
          },
      terminalReasonCode: projection.terminalReasonCode ?? null,
    }),
  )}`;
}

function readCommandId(kind: string, value: string): string {
  return `mc-${kind}-${resolveHash(`${kind}:${value}:${Date.now()}`)}`;
}

function resolveHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function positiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    Number.isSafeInteger(value) === false ||
    value <= 0
  ) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  const parsed = recordOrUndefined(value);
  if (parsed === undefined) {
    throw new Error(`${field} must be an object.`);
  }
  return parsed;
}

function recordOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}
