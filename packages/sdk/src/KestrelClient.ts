import { randomUUID } from "node:crypto";

import type {
  KestrelClientOptions,
  KestrelRequestContext,
  JobRunCommandPayload,
  RunnerEventSubscriptionFilter,
  KestrelRunRequest,
  KestrelRunAttachment,
  McpRefreshCommandPayload,
  McpStatusCommandPayload,
  OperatorControlCommandPayload,
  OperatorInboxCommandPayload,
  OperatorRunCommandPayload,
  OperatorRunsCommandPayload,
  ProjectActionCommandPayload,
  ProjectReviewActionCommandPayload,
  ProjectReviewGetCommandPayload,
  ProjectSnapshotGetCommandPayload,
  RunnerCommandMetadata,
  RunnerCommandPayloadByType,
  RunnerCommandType,
  RunnerEvent,
  RunnerJobStreamEvent,
  RunnerJobTerminalEvent,
  RunnerOperatorInboxSnapshot,
  RunnerOperatorRunIndexView,
  RunnerOperatorRunView,
  RunnerOperatorThreadView,
  RunnerProfile,
  ExecutionProfileResolveCommandPayload,
  ExecutionProfileResolvedEventPayload,
  RunnerResponseByCommandType,
  RunnerRunTerminalEvent,
  RunnerRunStreamEvent,
  RunnerStreamingCommandType,
  RunnerSessionState,
  RunnerStream,
  RunnerTaskGraph,
  RunCancelCommandPayload,
  TaskGraphGetCommandPayload,
  TaskGraphUpdateCommandPayload,
  WorkspaceCheckpointCaptureCommandPayload,
  WorkspaceCheckpointCleanupCommandPayload,
  WorkspaceCheckpointDiffCommandPayload,
  WorkspaceCheckpointInspectCommandPayload,
  WorkspaceCheckpointListCommandPayload,
  WorkspaceCheckpointRestoreCommandPayload,
  WorkspacePromotionApplyCommandPayload,
  WorkspacePromotionListCommandPayload,
  WorkspacePromotionPreviewCommandPayload,
  WorkspacePromotionUndoLatestCommandPayload,
  RunnerSessionDescription,
  RunnerProjectReviewDetail,
  RunnerProjectSnapshot,
  RunnerMcpStatusSnapshot,
  RunnerWorkspaceCheckpointDetail,
  RunnerWorkspaceCheckpointRecord,
  RunnerWorkspaceCleanupRecord,
  RunnerWorkspaceDiffRecord,
  RunnerWorkspaceRestoreRecord,
  RunnerWorkspacePromotionPreview,
  RunnerWorkspacePromotionRecord,
} from "./contracts.js";
import { KestrelHttpError, KestrelProtocolError, toKestrelError } from "./errors.js";
import { BufferedRunnerStream } from "./RunnerStream.js";
import {
  resolveClientTarget,
  resolveRemoteAuthToken,
  type ResolvedClientTarget,
  type ResolvedRemoteTarget,
} from "./internal/clientTarget.js";
import { LocalRunnerTransport } from "./internal/LocalRunnerTransport.js";
import { ProtocolClient } from "./internal/ProtocolClient.js";
import { RemoteRunnerTransport } from "./internal/RemoteRunnerTransport.js";
import { consumeSseEventPayloads, parseRunnerEvent } from "./internal/runnerSse.js";
import {
  isRunnerRunStreamEvent,
  isRunnerRunTerminalEvent,
  parseRunnerHealthV1,
  RUNNER_JOB_STREAM_EVENT_TYPES,
  RUNNER_RUN_STREAM_EVENT_TYPES,
  type RunnerHealthV1,
} from "@kestrel-agents/protocol";

export class KestrelClient {
  private readonly client: ProtocolClient;
  private readonly target: ResolvedClientTarget;
  private readonly localTransport: LocalRunnerTransport | undefined;
  private readonly subscriptionControllers = new Set<AbortController>();

  constructor(options: KestrelClientOptions) {
    this.target = resolveClientTarget(options);
    if (this.target.kind === "local") {
      this.localTransport = new LocalRunnerTransport(this.target);
      this.client = new ProtocolClient(this.localTransport);
      return;
    }
    this.localTransport = undefined;
    this.client = new ProtocolClient(new RemoteRunnerTransport(this.target));
  }

  async getHealth(): Promise<RunnerHealthV1> {
    let body: string;
    let status: number;
    try {
      if (this.target.kind === "local") {
        const response = await this.localTransport!.getHealth();
        body = response.body;
        status = response.status;
      } else {
        const authToken = await resolveRemoteAuthToken(this.target);
        const response = await this.target.fetchImpl(
          new URL("/health", `${this.target.baseUrl}/`).toString(),
          {
            method: "GET",
            headers: {
              accept: "application/json",
              ...(authToken !== undefined
                ? { authorization: `Bearer ${authToken}` }
                : {}),
            },
          },
        );
        body = await response.text();
        status = response.status;
      }
    } catch (error) {
      throw new KestrelProtocolError("Runner health request failed.", {
        code: "RUNNER_TRANSPORT_ERROR",
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }

    if (status < 200 || status >= 300) {
      throw new KestrelHttpError(
        `${this.target.kind === "local" ? "Local Core" : "Remote runner"} returned HTTP ${status}.`,
        {
          status,
          body,
        },
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      throw new KestrelProtocolError(
        `${this.target.kind === "local" ? "Local Core" : "Remote runner"} returned unreadable health JSON.`,
        {
          code: "RUNNER_HEALTH_INVALID",
          details: { body },
        },
      );
    }

    try {
      return parseRunnerHealthV1(decoded);
    } catch (error) {
      throw new KestrelProtocolError(
        `${this.target.kind === "local" ? "Local Core" : "Remote runner"} returned an invalid health contract.`,
        {
          code: "RUNNER_HEALTH_INVALID",
          details: {
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
  }

  async ping(
    input: RunnerCommandPayloadByType["runner.ping"] = {},
    context: KestrelRequestContext,
  ): Promise<RunnerResponseByCommandType["runner.ping"]["payload"]> {
    const event = await this.sendCommand("runner.ping", input, context);
    return event.payload;
  }

  async listProfiles(context: KestrelRequestContext): Promise<RunnerProfile[]> {
    const event = await this.sendCommand("profile.list", {}, context);
    return event.payload.profiles;
  }

  async getProfile(profileId: string, context: KestrelRequestContext): Promise<RunnerProfile> {
    const event = await this.sendCommand("profile.get", { profileId }, context);
    return event.payload.profile;
  }

  async resolveExecutionProfile(
    input: ExecutionProfileResolveCommandPayload,
    context: KestrelRequestContext,
  ): Promise<ExecutionProfileResolvedEventPayload> {
    const event = await this.sendCommand(
      "execution-profile.resolve",
      input,
      context,
    );
    return event.payload;
  }

  async describeRuntime(
    input: RunnerCommandPayloadByType["runtime.describe"],
    context: KestrelRequestContext,
  ): Promise<RunnerResponseByCommandType["runtime.describe"]["payload"]> {
    const event = await this.sendCommand("runtime.describe", input, context);
    return event.payload;
  }

  async releaseRuntime(
    input: RunnerCommandPayloadByType["runtime.release"],
    context: KestrelRequestContext,
    options: { commandId?: string | undefined } = {},
  ): Promise<RunnerResponseByCommandType["runtime.release"]> {
    return options.commandId === undefined
      ? this.sendCommand("runtime.release", input, context)
      : this.sendCommandWithId(
          options.commandId,
          "runtime.release",
          input,
          context,
        );
  }

  async run(
    input: KestrelRunRequest,
    context: KestrelRequestContext,
  ): Promise<RunnerRunTerminalEvent> {
    return this.sendCommand("run.start", {
      profileId: input.profileId,
      turn: input.turn,
    }, context);
  }

  async runJob(
    input: JobRunCommandPayload,
    context: KestrelRequestContext,
  ): Promise<RunnerJobTerminalEvent> {
    return this.sendCommand("job.run", input, context);
  }

  streamJob(
    input: JobRunCommandPayload & {
      signal?: AbortSignal | undefined;
    },
    context: KestrelRequestContext,
  ): RunnerStream<RunnerJobStreamEvent, RunnerJobTerminalEvent> {
    const { signal, ...payload } = input;
    return this.createStream(
      "job.run",
      payload,
      context,
      {
        signal,
        isStreamEvent: isRunnerJobStreamEvent,
        isTerminalEvent: isTerminalJobEvent,
        onCancel: async (_runId, commandId) => {
          await this.cancelRun({
            sessionId: input.input.turn.sessionId,
            commandId,
          }, context);
        },
      },
    );
  }

  streamRun(
    input: KestrelRunRequest & {
      signal?: AbortSignal | undefined;
      abortBehavior?: "cancel" | "detach" | undefined;
    },
    context: KestrelRequestContext,
  ): RunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent> {
    return this.createStream(
      "run.start",
      {
        profileId: input.profileId,
        turn: input.turn,
      },
      context,
      {
        signal: input.signal,
        abortBehavior: input.abortBehavior,
        isStreamEvent: isRunnerRunStreamEvent,
        isTerminalEvent: isRunnerRunTerminalEvent,
        onCancel: async (runId, commandId) => {
          await this.cancelRun({
            sessionId: input.turn.sessionId,
            ...(runId !== undefined ? { runId } : {}),
            commandId,
          }, context);
        },
      },
    );
  }

  reattachRun(
    input: KestrelRunAttachment,
    context: KestrelRequestContext,
  ): RunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent> {
    if (input.signal?.aborted === true) {
      return createAbortedRunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent>();
    }
    const controller = new AbortController();
    const abortHandler = () => {
      if (input.abortBehavior === "detach") {
        controller.abort();
      } else {
        void stream.cancel().catch(() => {});
      }
    };
    input.signal?.addEventListener("abort", abortHandler, { once: true });
    let stream!: BufferedRunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent>;
    const result = this.consumeReattachedRun({
      sessionId: input.sessionId,
      runId: input.runId,
      sinceEventId: input.sinceEventId,
      context,
      signal: controller.signal,
      initialDelay: false,
      onEvent: (event) => stream.push(event),
    }).then((terminal) => {
      stream.finish();
      return terminal;
    }).finally(() => {
      input.signal?.removeEventListener("abort", abortHandler);
    });
    stream = new BufferedRunnerStream(
      result,
      async () => {
        controller.abort();
        await this.cancelRun(
          { sessionId: input.sessionId, runId: input.runId },
          context,
        );
      },
    );
    return stream;
  }

  subscribe(
    filter: RunnerEventSubscriptionFilter,
    context: KestrelRequestContext,
    options: {
      signal?: AbortSignal | undefined;
    } = {},
  ): RunnerStream<RunnerEvent, void> {
    validateSubscriptionFilter(filter);
    if (options.signal?.aborted === true) {
      return createAbortedRunnerStream<RunnerEvent, void>();
    }
    const controller = new AbortController();
    this.subscriptionControllers.add(controller);
    let settled = false;
    let stream!: BufferedRunnerStream<RunnerEvent, void>;
    const pendingEvents: RunnerEvent[] = [];
    let readySettled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => {});
    const markReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolveReady();
    };
    const markReadyFailed = (error: unknown) => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(error);
    };

    const abortHandler = () => {
      void stream.cancel();
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    const result = this.openSubscription(
      filter,
      context,
      controller,
      (event) => {
        if (stream === undefined) {
          pendingEvents.push(event);
          return;
        }
        stream.push(event);
      },
      markReady,
    )
      .then(() => {
        markReady();
        if (settled) {
          return;
        }
        settled = true;
        this.subscriptionControllers.delete(controller);
        options.signal?.removeEventListener("abort", abortHandler);
        stream.finish();
      })
      .catch((error) => {
        markReadyFailed(error);
        if (settled) {
          throw error;
        }
        settled = true;
        this.subscriptionControllers.delete(controller);
        options.signal?.removeEventListener("abort", abortHandler);
        stream.fail(error);
        throw error;
      });

    stream = new BufferedRunnerStream<RunnerEvent, void>(
      result,
      async () => {
        markReady();
        if (settled) {
          return;
        }
        settled = true;
        options.signal?.removeEventListener("abort", abortHandler);
        this.subscriptionControllers.delete(controller);
        controller.abort();
        stream.finish();
      },
      ready,
    );

    for (const event of pendingEvents) {
      stream.push(event);
    }
    return stream;
  }

  async cancelRun(
    input: RunCancelCommandPayload,
    context: KestrelRequestContext,
  ): Promise<RunnerResponseByCommandType["run.cancel"]["payload"]> {
    const event = await this.sendCommand("run.cancel", input, context);
    return event.payload;
  }

  async describeSession(
    sessionId: string,
    context: KestrelRequestContext,
  ): Promise<RunnerSessionDescription> {
    const event = await this.sendCommand("session.describe", { sessionId }, context);
    return event.payload;
  }

  async getSessionState(
    sessionId: string,
    context: KestrelRequestContext,
  ): Promise<RunnerSessionState> {
    const event = await this.sendCommand("session.state", { sessionId }, context);
    return event.payload;
  }

  async getOperatorInbox(
    input: OperatorInboxCommandPayload,
    context: KestrelRequestContext,
  ): Promise<RunnerOperatorInboxSnapshot> {
    const event = await this.sendCommand("operator.inbox", input, context);
    return event.payload.inbox;
  }

  async getOperatorThread(
    threadId: string,
    context: KestrelRequestContext,
  ): Promise<RunnerOperatorThreadView> {
    const event = await this.sendCommand("operator.thread", { threadId }, context);
    return event.payload.view;
  }

  async listOperatorRuns(
    input: OperatorRunsCommandPayload,
    context: KestrelRequestContext,
  ): Promise<RunnerOperatorRunIndexView> {
    const event = await this.sendCommand("operator.runs", input, context);
    return event.payload.view;
  }

  async getOperatorRun(
    input: OperatorRunCommandPayload,
    context: KestrelRequestContext,
  ): Promise<RunnerOperatorRunView> {
    const event = await this.sendCommand("operator.run", input, context);
    return event.payload.view;
  }

  async controlOperator(
    input: OperatorControlCommandPayload,
    context: KestrelRequestContext,
  ): Promise<RunnerResponseByCommandType["operator.control"]["payload"]> {
    const event = await this.sendCommand("operator.control", input, context);
    return event.payload;
  }

  async getTaskGraph(
    input: TaskGraphGetCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; version: number; graph: RunnerTaskGraph }> {
    const event = await this.sendCommand("task.graph.get", input, context);
    return event.payload;
  }

  async updateTaskGraph(
    input: TaskGraphUpdateCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; version: number; graph: RunnerTaskGraph }> {
    const event = await this.sendCommand("task.graph.update", input, context);
    return event.payload;
  }

  async captureWorkspaceCheckpoint(
    input: WorkspaceCheckpointCaptureCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; checkpoint?: RunnerWorkspaceCheckpointDetail | undefined }> {
    const event = await this.sendCommand("workspace.checkpoint.capture", input, context);
    return event.payload;
  }

  async listWorkspaceCheckpoints(
    input: WorkspaceCheckpointListCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; checkpoints?: RunnerWorkspaceCheckpointRecord[] | undefined }> {
    const event = await this.sendCommand("workspace.checkpoint.list", input, context);
    return event.payload;
  }

  async inspectWorkspaceCheckpoint(
    input: WorkspaceCheckpointInspectCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; checkpoint?: RunnerWorkspaceCheckpointDetail | undefined }> {
    const event = await this.sendCommand("workspace.checkpoint.inspect", input, context);
    return event.payload;
  }

  async diffWorkspaceCheckpoints(
    input: WorkspaceCheckpointDiffCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; diff?: RunnerWorkspaceDiffRecord | undefined }> {
    const event = await this.sendCommand("workspace.checkpoint.diff", input, context);
    return event.payload;
  }

  async restoreWorkspaceCheckpoint(
    input: WorkspaceCheckpointRestoreCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; restore?: RunnerWorkspaceRestoreRecord | undefined }> {
    const event = await this.sendCommand("workspace.checkpoint.restore", input, context);
    return event.payload;
  }

  async cleanupWorkspaceCheckpoints(
    input: WorkspaceCheckpointCleanupCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{
    sessionId: string;
    cleanup?: RunnerWorkspaceCleanupRecord | undefined;
    deletedCheckpoints?: RunnerWorkspaceCheckpointRecord[] | undefined;
    remainingCheckpointCount?: number | undefined;
    remainingBytes?: number | undefined;
  }> {
    const event = await this.sendCommand("workspace.checkpoint.cleanup", input, context);
    return event.payload;
  }

  async listWorkspacePromotions(
    input: WorkspacePromotionListCommandPayload,
    context: KestrelRequestContext
  ): Promise<{
    sessionId: string;
    promotions?: RunnerWorkspacePromotionRecord[] | undefined;
  }> {
    const event = await this.sendCommand(
      "workspace.promotion.list",
      input,
      context
    );
    return event.payload;
  }

  async previewWorkspacePromotion(
    input: WorkspacePromotionPreviewCommandPayload,
    context: KestrelRequestContext
  ): Promise<{
    sessionId: string;
    preview?: RunnerWorkspacePromotionPreview | undefined;
  }> {
    const event = await this.sendCommand(
      "workspace.promotion.preview",
      input,
      context
    );
    return event.payload;
  }

  async applyWorkspacePromotion(
    input: WorkspacePromotionApplyCommandPayload,
    context: KestrelRequestContext
  ): Promise<{
    sessionId: string;
    promotion?: RunnerWorkspacePromotionRecord | undefined;
  }> {
    const event = await this.sendCommand(
      "workspace.promotion.apply",
      input,
      context
    );
    return event.payload;
  }

  async undoLatestWorkspacePromotion(
    input: WorkspacePromotionUndoLatestCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{
    sessionId: string;
    restore?: RunnerWorkspaceRestoreRecord | undefined;
  }> {
    const event = await this.sendCommand(
      "workspace.promotion.undo_latest",
      input,
      context,
    );
    return event.payload;
  }

  async getProjectSnapshot(
    input: ProjectSnapshotGetCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; snapshot: RunnerProjectSnapshot }> {
    const event = await this.sendCommand("project.snapshot.get", input, context);
    return event.payload;
  }

  async runProjectAction(
    input: ProjectActionCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; snapshot: RunnerProjectSnapshot }> {
    const event = await this.sendCommand("project.action", input, context);
    return event.payload;
  }

  async getProjectReview(
    input: ProjectReviewGetCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; detail: RunnerProjectReviewDetail }> {
    const event = await this.sendCommand("project.review.get", input, context);
    return event.payload;
  }

  async applyProjectReviewAction(
    input: ProjectReviewActionCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; detail: RunnerProjectReviewDetail }> {
    const event = await this.sendCommand("project.review.action", input, context);
    return event.payload;
  }

  async getMcpStatus(
    input: { profileId: string },
    context: KestrelRequestContext,
  ): Promise<RunnerMcpStatusSnapshot> {
    const payload: McpStatusCommandPayload = { profileId: input.profileId };
    const event = await this.sendCommand("mcp.status", payload, context);
    return event.payload.status;
  }

  async refreshMcp(
    input: { profileId: string },
    context: KestrelRequestContext,
  ): Promise<RunnerMcpStatusSnapshot> {
    const payload: McpRefreshCommandPayload = { profileId: input.profileId };
    const event = await this.sendCommand("mcp.refresh", payload, context);
    return event.payload.status;
  }

  async sendCommand<TType extends RunnerCommandType>(
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    context: KestrelRequestContext,
  ): Promise<RunnerResponseByCommandType[TType]> {
    const event = await this.client.sendCommand(
      type,
      payload,
      toCommandMetadata(context),
    );
    return this.projectRunnerEvent(event) as RunnerResponseByCommandType[TType];
  }

  async sendCommandWithId<TType extends RunnerCommandType>(
    commandId: string,
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    context: KestrelRequestContext,
  ): Promise<RunnerResponseByCommandType[TType]> {
    const event = await this.client.sendCommandWithId(
      commandId,
      type,
      payload,
      toCommandMetadata(context),
    );
    return this.projectRunnerEvent(event) as RunnerResponseByCommandType[TType];
  }

  /**
   * Public SDK results omit Environment-private Runtime correlation. Trusted
   * server integrations may retain the raw event while persisting it into a
   * private product boundary.
   */
  protected projectRunnerEvent<TEvent extends RunnerEvent>(event: TEvent): TEvent {
    return stripPrivateRuntimeMetadata(event) as TEvent;
  }

  async close(): Promise<void> {
    for (const controller of this.subscriptionControllers) {
      controller.abort();
    }
    this.subscriptionControllers.clear();
    await this.client.close();
  }

  protected createStream<
    TType extends RunnerStreamingCommandType,
    TEvent extends RunnerEvent,
    TTerminal extends TEvent,
  >(
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    context: KestrelRequestContext,
    options: {
      signal?: AbortSignal | undefined;
      abortBehavior?: "cancel" | "detach" | undefined;
      isStreamEvent: (event: RunnerEvent) => event is TEvent;
      isTerminalEvent: (event: TEvent) => event is TTerminal;
      onCancel?: ((runId: string | undefined, commandId: string) => Promise<void>) | undefined;
    },
  ): RunnerStream<TEvent, TTerminal> {
    if (options.signal?.aborted === true) {
      return createAbortedRunnerStream<TEvent, TTerminal>();
    }
    const commandId = randomUUID();
    let settled = false;
    let cancelRequested = false;
    let cancellationPromise: Promise<void> | undefined;
    let latestRunId: string | undefined;
    let latestEventId: string | undefined;
    let recoveryController: AbortController | undefined;
    let stream!: BufferedRunnerStream<TEvent, TTerminal>;
    const unsubscribe = this.client.onEvent((event) => {
      if (event.commandId !== commandId) {
        return;
      }
      if (options.isStreamEvent(event) === false) {
        return;
      }
      const projectedEvent = this.projectRunnerEvent(event);
      if (projectedEvent.runId !== undefined) {
        latestRunId = projectedEvent.runId;
      }
      latestEventId = projectedEvent.id;
      stream.push(projectedEvent);
      if (options.isTerminalEvent(projectedEvent)) {
        settled = true;
        unsubscribe();
        stream.finish();
      }
    });

    const abortHandler = () => {
      if (options.abortBehavior === "detach") {
        recoveryController?.abort();
        this.client.detachCommand(commandId);
        return;
      }
      cancellationPromise ??= stream.cancel();
      void cancellationPromise.catch(() => {});
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    const result = this.client.sendCommandWithId(commandId, type, payload, toCommandMetadata(context))
      .then((event) => this.projectRunnerEvent(event))
      .catch(async (error: unknown) => {
        if (
          type !== "run.start" ||
          context.durability !== "continue_on_disconnect" ||
          isRecoverableConnectionError(error, this.target) === false
        ) {
          throw error;
        }
        if (latestRunId === undefined || latestEventId === undefined) {
          throw new KestrelProtocolError(
            "The connection to the running agent was interrupted before a durable event cursor was available.",
            {
              code: "AGENT_CONNECTION_INTERRUPTED",
              details: { causeCode: readErrorCode(error) },
            },
          );
        }
        recoveryController = new AbortController();
        return await this.consumeReattachedRun({
          sessionId: (payload as RunnerCommandPayloadByType["run.start"]).turn.sessionId,
          runId: latestRunId,
          sinceEventId: latestEventId,
          context,
          signal: recoveryController.signal,
          initialDelay: true,
          onEvent: (event) => stream.push(event as TEvent),
        }) as unknown as RunnerResponseByCommandType[TType];
      })
      .finally(async () => {
        try {
          if (cancellationPromise !== undefined) {
            await cancellationPromise;
          }
        } finally {
          settled = true;
          unsubscribe();
          stream.finish();
          options.signal?.removeEventListener("abort", abortHandler);
        }
      }) as unknown as Promise<TTerminal>;

    stream = new BufferedRunnerStream<TEvent, TTerminal>(
      result,
      async () => {
        if (settled || cancelRequested) {
          return;
        }
        cancelRequested = true;
        recoveryController?.abort();
        if (options.onCancel !== undefined) {
          await options.onCancel(latestRunId, commandId);
        }
      },
    );

    return stream;
  }

  private async openSubscription(
    filter: RunnerEventSubscriptionFilter,
    context: KestrelRequestContext,
    controller: AbortController,
    onEvent: (event: RunnerEvent) => void,
    onReady: () => void,
  ): Promise<void> {
    if (this.target.kind === "local") {
      try {
        await this.localTransport!.subscribe(
          filter,
          toCommandMetadata(context),
          controller,
          (event) => onEvent(this.projectRunnerEvent(event)),
          onReady,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        throw error;
      }
      return;
    }

    const authToken = await resolveRemoteAuthToken(this.target);
    const response = await this.target.fetchImpl(`${this.target.baseUrl}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
        ...(authToken !== undefined
          ? { authorization: `Bearer ${authToken}` }
          : {}),
      },
      body: JSON.stringify({
        filter,
        metadata: toCommandMetadata(context),
      }),
      signal: controller.signal,
    });
    this.notifyCursorStatus(response);

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") === false) {
      const body = await response.text();
      let event: RunnerEvent | undefined;
      try {
        event = parseRunnerEvent(body);
      } catch (error) {
        if (response.ok) throw error;
      }
      if (event?.type === "runner.error") {
        throw toKestrelError(event.payload);
      }
      if (response.ok === false) {
        throw new KestrelHttpError(`Remote runner returned HTTP ${response.status}.`, {
          status: response.status,
          body,
        });
      }
      throw new KestrelProtocolError("Remote runner returned an unreadable subscription response.", {
        details: {
          status: response.status,
          ...(body.length > 0 ? { body } : {}),
        },
      });
    }

    onReady();
    try {
      await consumeSseEventPayloads(response, (eventType, data) => {
        const event = parseRunnerEvent(data);
        if (event === undefined) {
          throw new KestrelProtocolError(
            `Remote runner emitted invalid SSE payload for '${eventType || "message"}'.`,
            {
              details: {
                status: response.status,
                body: data,
              },
            },
          );
        }
        if (event.type === "runner.error") {
          throw toKestrelError(event.payload);
        }
        onEvent(this.projectRunnerEvent(event));
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      throw error;
    }
  }

  private async consumeReattachedRun(input: {
    sessionId: string;
    runId: string;
    sinceEventId: string;
    context: KestrelRequestContext;
    signal: AbortSignal;
    initialDelay: boolean;
    onEvent: (event: RunnerRunStreamEvent) => void;
  }): Promise<RunnerRunTerminalEvent> {
    let cursor = input.sinceEventId;
    const acceptedEventIds = new Set<string>([cursor]);
    let attempt = 0;
    for (;;) {
      const delayMs = input.initialDelay || attempt > 0
        ? reconnectDelay(attempt)
        : 0;
      this.notifyTransportEvent({
        type: "reconnect.attempt",
        attempt: attempt + 1,
        delayMs,
      });
      if (input.initialDelay || attempt > 0) {
        await waitForReconnect(delayMs, input.signal);
      }
      const controller = new AbortController();
      const abortHandler = () => controller.abort();
      input.signal.addEventListener("abort", abortHandler, { once: true });
      let terminal: RunnerRunTerminalEvent | undefined;
      try {
        await this.openSubscription(
          {
            sessionId: input.sessionId,
            runId: input.runId,
            sinceEventId: cursor,
            eventTypes: [...RUNNER_RUN_STREAM_EVENT_TYPES],
          },
          input.context,
          controller,
          (event) => {
            if (
              event.runId !== input.runId ||
              (event.sessionId !== undefined && event.sessionId !== input.sessionId) ||
              acceptedEventIds.has(event.id)
            ) {
              return;
            }
            if (isRunnerRunStreamEvent(event) === false) return;
            acceptedEventIds.add(event.id);
            cursor = event.id;
            input.onEvent(event);
            if (isRunnerRunTerminalEvent(event)) {
              terminal = event;
              controller.abort();
            }
          },
          () => {},
        );
      } catch (error) {
        if (input.signal.aborted) throw abortError();
        const code = readErrorCode(error);
        if (isRecoverableConnectionError(error, this.target) === false) {
          if (code === "RUNNER_EVENT_CURSOR_EXPIRED") {
            this.notifyTransportEvent({ type: "cursor.expired", code });
          } else if (code === "RUNNER_EVENT_CURSOR_UNKNOWN") {
            this.notifyTransportEvent({ type: "cursor.unknown", code });
          }
          this.notifyTransportEvent({
            type: "reconnect.failed",
            attempt: attempt + 1,
            code,
          });
          throw error;
        }
        this.notifyTransportEvent({
          type: "reconnect.failed",
          attempt: attempt + 1,
          code,
        });
      } finally {
        input.signal.removeEventListener("abort", abortHandler);
      }
      if (terminal !== undefined) {
        this.notifyTransportEvent({
          type: "reconnect.succeeded",
          attempt: attempt + 1,
        });
        return terminal;
      }
      if (input.signal.aborted) throw abortError();
      attempt += 1;
    }
  }

  private notifyTransportEvent(
    event: Parameters<NonNullable<ResolvedRemoteTarget["onTransportEvent"]>>[0],
  ) {
    if (this.target.kind !== "remote") return;
    try {
      this.target.onTransportEvent?.(event);
    } catch {
      // Transport instrumentation must never affect execution.
    }
  }

  private notifyCursorStatus(response: Response) {
    const status = response.headers.get("x-kestrel-event-cursor-status");
    if (status === "expired") {
      this.notifyTransportEvent({
        type: "cursor.expired",
        code: "RUNNER_EVENT_CURSOR_EXPIRED",
      });
    } else if (status === "unknown") {
      this.notifyTransportEvent({
        type: "cursor.unknown",
        code: "RUNNER_EVENT_CURSOR_UNKNOWN",
      });
    }
  }
}

function toCommandMetadata(context: KestrelRequestContext): RunnerCommandMetadata {
  return {
    actor: context.actor,
    ...(context.tenantId !== undefined ? { tenantId: context.tenantId } : {}),
    ...(context.profile !== undefined ? { profile: context.profile } : {}),
    ...(context.durability !== undefined ? { durability: context.durability } : {}),
  };
}

function readErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : "RUNNER_TRANSPORT_ERROR";
}

function isTerminalJobEvent(event: RunnerJobStreamEvent): event is RunnerJobTerminalEvent {
  return event.type === "job.completed" || event.type === "job.failed";
}

function isRunnerJobStreamEvent(event: RunnerEvent): event is RunnerJobStreamEvent {
  return (RUNNER_JOB_STREAM_EVENT_TYPES as readonly string[]).includes(
    event.type,
  );
}

function validateSubscriptionFilter(filter: RunnerEventSubscriptionFilter): void {
  if (filter.sessionId !== undefined || filter.threadId !== undefined || filter.runId !== undefined) {
    return;
  }
  throw new KestrelProtocolError("subscribe requires sessionId, threadId, or runId.");
}

function stripPrivateRuntimeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripPrivateRuntimeMetadata(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "privateRuntimeMetadata")
      .map(([key, entry]) => [key, stripPrivateRuntimeMetadata(entry)]),
  );
}

function createAbortedRunnerStream<TEvent, TTerminal>(): RunnerStream<TEvent, TTerminal> {
  const error = abortError();
  return new BufferedRunnerStream<TEvent, TTerminal>(
    Promise.reject(error),
    async () => {},
  );
}

function reconnectDelay(attempt: number): number {
  return [250, 500, 1_000][attempt] ?? 2_000;
}

function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abortHandler);
      resolve();
    }, delayMs);
    const abortHandler = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isRecoverableConnectionError(
  error: unknown,
  target: ResolvedClientTarget,
): boolean {
  if (target.kind !== "remote" || !(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "RUNNER_TRANSPORT_ERROR" || code === "RUNNER_TRANSPORT_INTERRUPTED") {
    return true;
  }
  if (code !== "RUNNER_HTTP_ERROR") return false;
  const status = "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
  return status === 502 || status === 503 || status === 504 ||
    (status === 401 && target.authTokenProvider !== undefined);
}
