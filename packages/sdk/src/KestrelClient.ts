import { randomUUID } from "node:crypto";

import type {
  KestrelClientOptions,
  KestrelRequestContext,
  JobRunCommandPayload,
  RunnerEventSubscriptionFilter,
  KestrelRunRequest,
  McpRefreshCommandPayload,
  McpStatusCommandPayload,
  OperatorControlCommandPayload,
  OperatorInboxCommandPayload,
  OperatorRunCommandPayload,
  OperatorRunsCommandPayload,
  OperatorThreadCommandPayload,
  ProfileGetCommandPayload,
  ProjectActionCommandPayload,
  ProjectReviewActionCommandPayload,
  ProjectReviewGetCommandPayload,
  ProjectSnapshotGetCommandPayload,
  ProjectSnapshotUpdateCommandPayload,
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
  RunnerResponseByCommandType,
  RunnerRunTerminalEvent,
  RunnerRunStreamEvent,
  RunnerStreamingCommandType,
  RunnerSessionState,
  RunnerStream,
  RunnerTaskGraph,
  RunCancelCommandPayload,
  SessionDescribeCommandPayload,
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
import { resolveClientTarget, type ResolvedClientTarget } from "./internal/clientTarget.js";
import { LocalRunnerTransport } from "./internal/LocalRunnerTransport.js";
import { ProtocolClient } from "./internal/ProtocolClient.js";
import { RemoteRunnerTransport } from "./internal/RemoteRunnerTransport.js";
import { consumeSseEventPayloads, parseRunnerEvent } from "./internal/runnerSse.js";
import {
  isRunnerRunStreamEvent,
  isRunnerRunTerminalEvent,
  parseRunnerHealthV1,
  RUNNER_JOB_STREAM_EVENT_TYPES,
  type RunnerHealthV1,
} from "@kestrel-agents/protocol";

export class KestrelClient {
  private readonly client: ProtocolClient;
  private readonly target: ResolvedClientTarget;
  private readonly localTransport: LocalRunnerTransport | undefined;
  private readonly subscriptionControllers = new Set<AbortController>();

  constructor(options: KestrelClientOptions = {}) {
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
        const response = await this.target.fetchImpl(
          new URL("/health", `${this.target.baseUrl}/`).toString(),
          {
            method: "GET",
            headers: {
              accept: "application/json",
              ...(this.target.authToken !== undefined
                ? { authorization: `Bearer ${this.target.authToken}` }
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

    const abortHandler = () => {
      void stream.cancel();
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    const result = this.openSubscription(filter, context, controller, (event) => {
      if (stream === undefined) {
        pendingEvents.push(event);
        return;
      }
      stream.push(event);
    })
      .then(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.subscriptionControllers.delete(controller);
        options.signal?.removeEventListener("abort", abortHandler);
        stream.finish();
      })
      .catch((error) => {
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
        if (settled) {
          return;
        }
        settled = true;
        options.signal?.removeEventListener("abort", abortHandler);
        this.subscriptionControllers.delete(controller);
        controller.abort();
        stream.finish();
      },
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

  async updateProjectSnapshot(
    input: ProjectSnapshotUpdateCommandPayload,
    context: KestrelRequestContext,
  ): Promise<{ sessionId: string; snapshot: RunnerProjectSnapshot }> {
    const event = await this.sendCommand("project.snapshot.update", input, context);
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
    return this.client.sendCommand(type, payload, toCommandMetadata(context));
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
    let latestRunId: string | undefined;
    let stream!: BufferedRunnerStream<TEvent, TTerminal>;
    const unsubscribe = this.client.onEvent((event) => {
      if (event.commandId !== commandId) {
        return;
      }
      if (options.isStreamEvent(event) === false) {
        return;
      }
      if (event.runId !== undefined) {
        latestRunId = event.runId;
      }
      stream.push(event);
      if (options.isTerminalEvent(event)) {
        settled = true;
        unsubscribe();
        stream.finish();
      }
    });

    const abortHandler = () => {
      void stream.cancel();
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    const result = this.client.sendCommandWithId(commandId, type, payload, toCommandMetadata(context))
      .finally(() => {
        settled = true;
        unsubscribe();
        options.signal?.removeEventListener("abort", abortHandler);
      }) as unknown as Promise<TTerminal>;

    stream = new BufferedRunnerStream<TEvent, TTerminal>(
      result,
      async () => {
        if (settled || cancelRequested) {
          return;
        }
        cancelRequested = true;
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
  ): Promise<void> {
    if (this.target.kind === "local") {
      try {
        await this.localTransport!.subscribe(
          filter,
          toCommandMetadata(context),
          controller,
          onEvent,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        throw error;
      }
      return;
    }

    const response = await this.target.fetchImpl(`${this.target.baseUrl}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
        ...(this.target.authToken !== undefined
          ? { authorization: `Bearer ${this.target.authToken}` }
          : {}),
      },
      body: JSON.stringify({
        filter,
        metadata: toCommandMetadata(context),
      }),
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") === false) {
      const body = await response.text();
      const event = parseRunnerEvent(body);
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
        onEvent(event);
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      throw error;
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

function createAbortedRunnerStream<TEvent, TTerminal>(): RunnerStream<TEvent, TTerminal> {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return new BufferedRunnerStream<TEvent, TTerminal>(
    Promise.reject(error),
    async () => {},
  );
}
