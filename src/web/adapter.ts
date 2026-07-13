import { randomUUID } from "node:crypto";

import { AGENT_STEP_IDS } from "../../agents/reference-react/src/constants.js";
import type { TuiProfile } from "../../cli/contracts.js";
import { createWebClientCapabilities } from "../clientCapabilities.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  normalizeInteractionMode,
} from "../mode/contracts.js";
import {
  type RunnerCommandMetadata,
  type RunnerCommandType,
  type RunnerCommandPayloadByType,
  type RunnerEvent,
} from "../../cli/protocol/contracts.js";
import {
  ProtocolClient,
  type ProtocolClientOptions,
  type ProtocolTransport,
} from "../../cli/client/ProtocolClient.js";
import { createConfiguredRunnerTransport } from "../../cli/client/configuredTransport.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { normalizeSubmittedHistory } from "../runtime/submittedHistory.js";
import type {
  WebControlCommand,
  WebHistoryLine,
  WebRunnerRequestContext,
  WebRunnerEvent,
  WebRunTurnRequest,
  WebRunTurnStreamOptions,
  ThreadRunCheckIn,
  ThreadRunStartAccepted,
} from "./contracts.js";
import { createWebDemoProfile } from "./profile.js";

type WebRunTerminalEvent = Extract<RunnerEvent, { type: "run.completed" | "run.failed" | "run.cancelled" }>;
type WebDurableTerminalEvent = WebRunTerminalEvent;
type WebControlTerminalEvent = Extract<
  RunnerEvent,
  {
    type:
      | "session.state"
      | "profile.listed"
      | "run.cancelled"
      | "runner.pong"
      | "mcp.status"
      | "mcp.refreshed"
      | "operator.inbox"
      | "operator.thread"
      | "operator.runs"
      | "operator.run"
      | "operator.controlled"
      | "task.graph"
      | "workspace.checkpoint"
      | "project.snapshot"
      | "project.review";
  }
>;

type DurableRunEntry = {
  threadId: string;
  sessionId: string;
  runId: string;
  commandId: string;
  status: ThreadRunCheckIn["status"];
  events: WebRunnerEvent[];
  acceptedAt: string;
  lastActivityAt: string;
  accepted?: Promise<ThreadRunStartAccepted> | undefined;
  terminal?: WebDurableTerminalEvent | undefined;
  unsubscribe?: (() => void) | undefined;
};

export interface WebRunnerAdapter {
  runTurnStream(
    request: WebRunTurnRequest,
    options: WebRunTurnStreamOptions,
    context?: WebRunnerRequestContext,
  ): Promise<WebRunTerminalEvent>;
  startRun(
    request: WebRunTurnRequest,
    context?: WebRunnerRequestContext,
  ): Promise<ThreadRunStartAccepted>;
  checkInRun(input: {
    threadId: string;
    sessionId: string;
    runId?: string | undefined;
  }): ThreadRunCheckIn;
  subscribeRunEvents(
    input: {
      threadId: string;
      sessionId: string;
      runId?: string | undefined;
      sinceEventId?: string | undefined;
    },
    options: { onEvent: (event: WebRunnerEvent) => void; signal?: AbortSignal | undefined },
  ): Promise<void>;
  sendControl(command: WebControlCommand, context?: WebRunnerRequestContext): Promise<WebControlTerminalEvent>;
  close(): Promise<void>;
}

interface WebRunnerAdapterBaseOptions {
  transportFactory?: (() => ProtocolTransport) | undefined;
}

interface WebRunnerInlineProfileOptions {
  profile?: TuiProfile | undefined;
  profileId?: never;
  protocolClientOptions?: ProtocolClientOptions | undefined;
  resolvedProfile?: never;
}

export type WebRunnerRegisteredProfileSnapshot = Pick<
  TuiProfile,
  | "id"
  | "agent"
  | "modeSystemV2Enabled"
  | "defaultInteractionMode"
  | "defaultActSubmode"
>;

interface WebRunnerRegisteredProfileOptions {
  profile?: never;
  profileId: string;
  protocolClientOptions?: RegisteredProfileProtocolClientOptions | undefined;
  resolvedProfile: WebRunnerRegisteredProfileSnapshot;
}

type RegisteredProfileProtocolClientOptions = Omit<ProtocolClientOptions, "defaultMetadata"> & {
  defaultMetadata?: Omit<RunnerCommandMetadata, "profile"> & { profile?: never } | undefined;
};

export type CreateWebRunnerAdapterOptions = WebRunnerAdapterBaseOptions &
  (WebRunnerInlineProfileOptions | WebRunnerRegisteredProfileOptions);

type WebRunnerProfileSelection =
  | {
      kind: "inline";
      resolvedProfile: TuiProfile;
    }
  | {
      kind: "registered";
      profileId: string;
      resolvedProfile: WebRunnerRegisteredProfileSnapshot;
    };

export function createWebRunnerAdapter(options: CreateWebRunnerAdapterOptions = {}): WebRunnerAdapter {
  const profileSelection = resolveWebRunnerProfileSelection(options);
  const protocolClientOptions = validateProtocolClientOptions(
    profileSelection,
    options.protocolClientOptions,
  );
  const profile = profileSelection.resolvedProfile;
  const transportFactory = options.transportFactory ?? createConfiguredRunnerTransport;

  let client: ProtocolClient | undefined;
  const durableRuns = new Map<string, DurableRunEntry>();

  function ensureClient(): ProtocolClient {
    if (client === undefined) {
      client = new ProtocolClient(
        transportFactory(),
        protocolClientOptions,
      );
    }
    return client;
  }

  return {
    async runTurnStream(request, runOptions, context) {
      const activeClient = ensureClient();
      const commandId = randomUUID();
      let aborted = false;

      const unsubscribe = activeClient.onEvent((event) => {
        if (event.commandId !== commandId) {
          return;
        }
        if (event.type.startsWith("run.") === false) {
          return;
        }
        if (aborted) {
          return;
        }
        runOptions.onEvent(event);
      });

      const onAbort = () => {
        aborted = true;
        void activeClient.sendCommand("run.cancel", {
          sessionId: request.sessionId,
          commandId,
        }).catch(() => {
          // Best-effort cancellation on stream abort.
        });
        unsubscribe();
      };

      runOptions.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const resolvedMode = normalizeInteractionMode({
          interactionMode: request.interactionMode,
          actSubmode: request.actSubmode,
          defaultInteractionMode: profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
          defaultActSubmode: profile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
        });
        const commandMetadata = toRunnerCommandMetadata(
          profileSelection,
          context,
          protocolClientOptions?.defaultMetadata,
        );
        const response = await activeClient.sendCommandWithId(
          commandId,
          "run.start",
          buildRunStartPayload(profileSelection, request, resolvedMode, commandMetadata),
          commandMetadata,
        );

        if (response.type !== "run.completed" && response.type !== "run.failed" && response.type !== "run.cancelled") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_RUN_RESPONSE",
            `Unexpected run terminal response '${response.type}'.`,
            {
              responseType: response.type,
            },
          );
        }

        return response;
      } finally {
        unsubscribe();
        runOptions.signal?.removeEventListener("abort", onAbort);
      }
    },

    async startRun(request, context) {
      const activeClient = ensureClient();
      const existingActiveRun = findDurableRun(durableRuns, {
        threadId: request.sessionId,
        sessionId: request.sessionId,
      });
      if (existingActiveRun !== undefined && isActiveDurableRun(existingActiveRun)) {
        if (existingActiveRun.accepted !== undefined) {
          return existingActiveRun.accepted;
        }
        return {
          threadId: existingActiveRun.threadId,
          sessionId: existingActiveRun.sessionId,
          runId: existingActiveRun.runId,
          commandId: existingActiveRun.commandId,
          acceptedAt: existingActiveRun.acceptedAt,
        };
      }
      const commandId = randomUUID();
      const runId = request.runId ?? randomUUID();
      const now = new Date().toISOString();
      const entry: DurableRunEntry = {
        threadId: request.sessionId,
        sessionId: request.sessionId,
        runId,
        commandId,
        status: "starting",
        events: [],
        acceptedAt: now,
        lastActivityAt: now,
      };
      durableRuns.set(runId, entry);

      let rejectAccepted: ((error: Error) => void) | undefined;
      const accepted = new Promise<ThreadRunStartAccepted>((resolve, reject) => {
        rejectAccepted = reject;
        const unsubscribe = activeClient.onEvent((event) => {
          if (event.commandId !== commandId) {
            return;
          }
          const normalizedEvent = withDurableRunIdentity(event, runId, request.sessionId);
          recordDurableEvent(entry, normalizedEvent);
          if (normalizedEvent.type === "run.started") {
            if (normalizedEvent.runId !== undefined && normalizedEvent.runId !== entry.runId) {
              durableRuns.delete(entry.runId);
              entry.runId = normalizedEvent.runId;
              durableRuns.set(entry.runId, entry);
            }
            entry.status = "running";
            resolve({
              threadId: entry.threadId,
              sessionId: entry.sessionId,
              runId: entry.runId,
              commandId: entry.commandId,
              acceptedAt: normalizedEvent.ts,
            });
            return;
          }
          if (isDurableTerminalEvent(normalizedEvent)) {
            entry.terminal = normalizedEvent;
            entry.status = statusFromTerminalEvent(normalizedEvent);
            entry.unsubscribe?.();
            entry.unsubscribe = undefined;
          }
          if (normalizedEvent.type === "runner.error") {
            reject(new Error(normalizedEvent.payload.message));
          }
        });
        entry.unsubscribe = unsubscribe;
      });
      entry.accepted = accepted;

      const resolvedMode = normalizeInteractionMode({
        interactionMode: request.interactionMode,
        actSubmode: request.actSubmode,
        defaultInteractionMode: profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
        defaultActSubmode: profile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
      });
      const commandMetadata = toRunnerCommandMetadata(
        profileSelection,
        context,
        protocolClientOptions?.defaultMetadata,
      );
      void activeClient.sendCommandWithId(
        commandId,
        "run.start",
        buildRunStartPayload(profileSelection, { ...request, runId }, resolvedMode, commandMetadata),
        {
          ...commandMetadata,
          durability: "continue_on_disconnect",
        },
      ).catch((error) => {
        entry.status = "failed";
        entry.lastActivityAt = new Date().toISOString();
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        const failure = createSyntheticRunnerError(commandId, error, request.sessionId, runId);
        recordDurableEvent(entry, failure);
        rejectAccepted?.(error instanceof Error ? error : new Error(String(error)));
      });

      return accepted;
    },

    checkInRun(input) {
      const entry = findDurableRun(durableRuns, input);
      if (entry === undefined) {
        return {
          threadId: input.threadId,
          runId: input.runId ?? null,
          status: "none",
          lastEventId: null,
          lastActivityAt: null,
          active: false,
          canSubscribe: false,
          canCancel: false,
          message: "No active durable run is known for this thread.",
        };
      }
      const lastEvent = entry.events.at(-1);
      const active = isActiveDurableRun(entry);
      return {
        threadId: entry.threadId,
        runId: entry.runId,
        status: entry.status,
        lastEventId: lastEvent?.id ?? null,
        lastActivityAt: entry.lastActivityAt,
        active,
        canSubscribe: active,
        canCancel: active,
      };
    },

    async subscribeRunEvents(input, subscribeOptions) {
      const entry = findDurableRun(durableRuns, input);
      if (entry === undefined) {
        return;
      }
      const replayStartIndex =
        input.sinceEventId === undefined
          ? 0
          : entry.events.findIndex((event) => event.id === input.sinceEventId) + 1;
      const boundedReplayStartIndex = replayStartIndex <= 0 ? 0 : replayStartIndex;
      for (const event of entry.events.slice(boundedReplayStartIndex)) {
        subscribeOptions.onEvent(event);
      }
      if (entry.terminal !== undefined || subscribeOptions.signal?.aborted === true) {
        return;
      }
      await new Promise<void>((resolve) => {
        let cursor = entry.events.length;
        let finished = false;
        let poll: ReturnType<typeof setInterval> | undefined;
        const emitMissed = () => {
          while (cursor < entry.events.length) {
            subscribeOptions.onEvent(entry.events[cursor]!);
            cursor += 1;
          }
        };
        const finish = () => {
          if (finished) {
            return;
          }
          finished = true;
          if (poll !== undefined) {
            clearInterval(poll);
          }
          subscribeOptions.signal?.removeEventListener("abort", finish);
          emitMissed();
          resolve();
        };
        subscribeOptions.signal?.addEventListener("abort", finish, { once: true });
        poll = setInterval(() => {
          emitMissed();
          if (entry.terminal !== undefined) {
            finish();
          }
        }, 100);
      });
    },

    async sendControl(command, context) {
      const activeClient = ensureClient();
      const metadata = toRunnerCommandMetadata(
        profileSelection,
        context,
        protocolClientOptions?.defaultMetadata,
      );

      if (command.type === "ping") {
        const response = await sendCommand(activeClient, "runner.ping", {
          ...(command.nonce !== undefined ? { nonce: command.nonce } : {}),
        }, metadata);
        if (response.type !== "runner.pong") {
          throw createRuntimeFailure("WEB_ADAPTER_UNEXPECTED_PING_RESPONSE", `Unexpected ping response '${response.type}'.`, {
            responseType: response.type,
          });
        }
        return response;
      }

      if (command.type === "profile.list") {
        const response = await sendCommand(activeClient, "profile.list", {}, metadata);
        if (response.type !== "profile.listed") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_PROFILE_LIST_RESPONSE",
            `Unexpected profile list response '${response.type}'.`,
            {
              responseType: response.type,
            },
          );
        }
        return response;
      }

      if (command.type === "session.state") {
        const response = await sendCommand(activeClient, "session.state", {
          sessionId: command.sessionId,
        }, metadata);
        if (response.type !== "session.state") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_SESSION_STATE_RESPONSE",
            `Unexpected session state response '${response.type}'.`,
            {
              responseType: response.type,
            },
          );
        }
        return response;
      }

      if (command.type === "mcp.status") {
        const response = await sendCommand(
          activeClient,
          "mcp.status",
          toRunnerProfileReference(profileSelection),
          metadata,
        );
        if (response.type !== "mcp.status") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_MCP_STATUS_RESPONSE",
            `Unexpected MCP status response '${response.type}'.`,
            {
              responseType: response.type,
            },
          );
        }
        return response;
      }

      if (command.type === "operator.inbox") {
        const response = await sendCommand(activeClient, "operator.inbox", {
          ...(command.sessionId !== undefined ? { sessionId: command.sessionId } : {}),
          ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
        }, metadata);
        if (response.type !== "operator.inbox") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_OPERATOR_INBOX_RESPONSE",
            `Unexpected operator inbox response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "run.cancel") {
        const response = await sendCommand(activeClient, "run.cancel", {
          sessionId: command.sessionId,
          ...(command.runId !== undefined ? { runId: command.runId } : {}),
          ...(command.commandId !== undefined ? { commandId: command.commandId } : {}),
        }, metadata);
        if (response.type !== "run.cancelled") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_RUN_CANCEL_RESPONSE",
            `Unexpected run cancel response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "operator.thread") {
        const response = await sendCommand(activeClient, "operator.thread", {
          threadId: command.threadId,
        }, metadata);
        if (response.type !== "operator.thread") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_OPERATOR_THREAD_RESPONSE",
            `Unexpected operator thread response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "operator.runs") {
        const response = await sendCommand(activeClient, "operator.runs", {
          ...(command.sessionId !== undefined ? { sessionId: command.sessionId } : {}),
          ...(command.status !== undefined ? { status: command.status } : {}),
          ...(command.limit !== undefined ? { limit: command.limit } : {}),
        }, metadata);
        if (response.type !== "operator.runs") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_OPERATOR_RUNS_RESPONSE",
            `Unexpected operator runs response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "operator.run") {
        const response = await sendCommand(activeClient, "operator.run", {
          runId: command.runId,
        }, metadata);
        if (response.type !== "operator.run") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_OPERATOR_RUN_RESPONSE",
            `Unexpected operator run response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "operator.control") {
        const response = await sendCommand(activeClient, "operator.control", {
          action: command.action,
          threadId: command.threadId,
          ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
          ...(command.proposalId !== undefined ? { proposalId: command.proposalId } : {}),
          ...(command.checkpointId !== undefined ? { checkpointId: command.checkpointId } : {}),
          ...(command.delegationId !== undefined ? { delegationId: command.delegationId } : {}),
          ...(command.actionValue !== undefined ? { actionValue: command.actionValue } : {}),
          ...(command.message !== undefined ? { message: command.message } : {}),
          ...(command.attachments !== undefined ? { attachments: command.attachments } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.rolePrompt !== undefined ? { rolePrompt: command.rolePrompt } : {}),
          ...(command.goal !== undefined ? { goal: command.goal } : {}),
          ...(command.profileId !== undefined ? { profileId: command.profileId } : {}),
          ...(command.provider !== undefined ? { provider: command.provider } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.skillPackId !== undefined ? { skillPackId: command.skillPackId } : {}),
          ...(command.maxTurns !== undefined ? { maxTurns: command.maxTurns } : {}),
          ...(command.maxRuntimeMs !== undefined ? { maxRuntimeMs: command.maxRuntimeMs } : {}),
          ...(command.allowApprovalInheritance !== undefined
            ? { allowApprovalInheritance: command.allowApprovalInheritance }
            : {}),
          ...(command.allowToolClasses !== undefined ? { allowToolClasses: command.allowToolClasses } : {}),
          ...(command.allowCapabilities !== undefined ? { allowCapabilities: command.allowCapabilities } : {}),
        }, metadata);
        if (response.type !== "operator.controlled") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_OPERATOR_CONTROL_RESPONSE",
            `Unexpected operator control response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "task.graph.get") {
        const response = await sendCommand(activeClient, "task.graph.get", {
          sessionId: command.sessionId,
          ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
        }, metadata);
        if (response.type !== "task.graph") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_TASK_GRAPH_RESPONSE",
            `Unexpected task graph response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "task.graph.update") {
        const response = await sendCommand(activeClient, "task.graph.update", {
          sessionId: command.sessionId,
          graph: command.graph,
          ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
          ...(command.expectedVersion !== undefined ? { expectedVersion: command.expectedVersion } : {}),
        }, metadata);
        if (response.type !== "task.graph") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_TASK_GRAPH_RESPONSE",
            `Unexpected task graph response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "workspace.checkpoint.capture") {
        const response = await sendCommand(activeClient, "workspace.checkpoint.capture", {
          sessionId: command.sessionId,
          ...(command.label !== undefined ? { label: command.label } : {}),
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
          ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
          ...(command.runId !== undefined ? { runId: command.runId } : {}),
          ...(command.taskId !== undefined ? { taskId: command.taskId } : {}),
        }, metadata);
        if (response.type !== "workspace.checkpoint") {
          throw createRuntimeFailure("WEB_ADAPTER_UNEXPECTED_WORKSPACE_CHECKPOINT_RESPONSE", `Unexpected workspace checkpoint response '${response.type}'.`, {
            responseType: response.type,
          });
        }
        return response;
      }

      if (command.type === "workspace.checkpoint.list") {
        const response = await sendCommand(activeClient, "workspace.checkpoint.list", {
          sessionId: command.sessionId,
        }, metadata);
        if (response.type !== "workspace.checkpoint") {
          throw createRuntimeFailure("WEB_ADAPTER_UNEXPECTED_WORKSPACE_CHECKPOINT_RESPONSE", `Unexpected workspace checkpoint response '${response.type}'.`, {
            responseType: response.type,
          });
        }
        return response;
      }

      if (command.type === "workspace.checkpoint.inspect") {
        const response = await sendCommand(activeClient, "workspace.checkpoint.inspect", {
          sessionId: command.sessionId,
          checkpointId: command.checkpointId,
        }, metadata);
        if (response.type !== "workspace.checkpoint") {
          throw createRuntimeFailure("WEB_ADAPTER_UNEXPECTED_WORKSPACE_CHECKPOINT_RESPONSE", `Unexpected workspace checkpoint response '${response.type}'.`, {
            responseType: response.type,
          });
        }
        return response;
      }

      if (command.type === "workspace.checkpoint.diff") {
        const response = await sendCommand(activeClient, "workspace.checkpoint.diff", {
          sessionId: command.sessionId,
          source: command.source,
          target: command.target,
          ...(command.includeHunks !== undefined ? { includeHunks: command.includeHunks } : {}),
        }, metadata);
        if (response.type !== "workspace.checkpoint") {
          throw createRuntimeFailure("WEB_ADAPTER_UNEXPECTED_WORKSPACE_CHECKPOINT_RESPONSE", `Unexpected workspace checkpoint response '${response.type}'.`, {
            responseType: response.type,
          });
        }
        return response;
      }

      if (command.type === "workspace.checkpoint.restore") {
        const response = await sendCommand(activeClient, "workspace.checkpoint.restore", {
          sessionId: command.sessionId,
          checkpointId: command.checkpointId,
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
          ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
          ...(command.runId !== undefined ? { runId: command.runId } : {}),
          ...(command.taskId !== undefined ? { taskId: command.taskId } : {}),
        }, metadata);
        if (response.type !== "workspace.checkpoint") {
          throw createRuntimeFailure("WEB_ADAPTER_UNEXPECTED_WORKSPACE_CHECKPOINT_RESPONSE", `Unexpected workspace checkpoint response '${response.type}'.`, {
            responseType: response.type,
          });
        }
        return response;
      }

      if (command.type === "workspace.checkpoint.cleanup") {
        const response = await sendCommand(activeClient, "workspace.checkpoint.cleanup", {
          sessionId: command.sessionId,
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
          ...(command.policyOverride !== undefined ? { policyOverride: command.policyOverride } : {}),
        }, metadata);
        if (response.type !== "workspace.checkpoint") {
          throw createRuntimeFailure("WEB_ADAPTER_UNEXPECTED_WORKSPACE_CHECKPOINT_RESPONSE", `Unexpected workspace checkpoint response '${response.type}'.`, {
            responseType: response.type,
          });
        }
        return response;
      }

      if (command.type === "workspace.promotion.undo_latest") {
        const response = await sendCommand(activeClient, "workspace.promotion.undo_latest", {
          sessionId: command.sessionId,
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
        }, metadata);
        if (response.type !== "workspace.checkpoint") {
          throw createRuntimeFailure("WEB_ADAPTER_UNEXPECTED_WORKSPACE_CHECKPOINT_RESPONSE", `Unexpected workspace checkpoint response '${response.type}'.`, {
            responseType: response.type,
          });
        }
        return response;
      }

      if (command.type === "project.snapshot.get") {
        const response = await sendCommand(activeClient, "project.snapshot.get", {
          sessionId: command.sessionId,
        }, metadata);
        if (response.type !== "project.snapshot") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_PROJECT_SNAPSHOT_RESPONSE",
            `Unexpected project snapshot response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "project.snapshot.update") {
        const response = await sendCommand(activeClient, "project.snapshot.update", {
          sessionId: command.sessionId,
          snapshot: command.snapshot,
        }, metadata);
        if (response.type !== "project.snapshot") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_PROJECT_SNAPSHOT_RESPONSE",
            `Unexpected project snapshot response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "project.action") {
        const response = await sendCommand(activeClient, "project.action", command.action, metadata);
        if (response.type !== "project.snapshot") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_PROJECT_SNAPSHOT_RESPONSE",
            `Unexpected project snapshot response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "project.review.get") {
        const response = await sendCommand(activeClient, "project.review.get", {
          sessionId: command.sessionId,
          target: command.target,
        }, metadata);
        if (response.type !== "project.review") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_PROJECT_REVIEW_RESPONSE",
            `Unexpected project review response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      if (command.type === "project.review.action") {
        const response = await sendCommand(activeClient, "project.review.action", {
          sessionId: command.sessionId,
          action: command.action,
        }, metadata);
        if (response.type !== "project.review") {
          throw createRuntimeFailure(
            "WEB_ADAPTER_UNEXPECTED_PROJECT_REVIEW_RESPONSE",
            `Unexpected project review response '${response.type}'.`,
            { responseType: response.type },
          );
        }
        return response;
      }

      const response = await sendCommand(
        activeClient,
        "mcp.refresh",
        toRunnerProfileReference(profileSelection),
        metadata,
      );
      if (response.type !== "mcp.refreshed") {
        throw createRuntimeFailure(
          "WEB_ADAPTER_UNEXPECTED_MCP_REFRESH_RESPONSE",
          `Unexpected MCP refresh response '${response.type}'.`,
          {
            responseType: response.type,
          },
        );
      }
      return response;
    },

    async close() {
      for (const entry of durableRuns.values()) {
        entry.unsubscribe?.();
      }
      durableRuns.clear();
      if (client === undefined) {
        return;
      }
      const closing = client;
      client = undefined;
      await closing.close();
    },
  };
}

function buildRunStartPayload(
  profileSelection: WebRunnerProfileSelection,
  request: WebRunTurnRequest,
  resolvedMode: ReturnType<typeof normalizeInteractionMode>,
  metadata?: RunnerCommandMetadata | undefined,
): RunnerCommandPayloadByType["run.start"] {
  const profile = profileSelection.resolvedProfile;
  const actor = metadata?.actor === undefined
    ? undefined
    : {
        ...metadata.actor,
        ...(metadata.actor.tenantId === undefined && metadata.tenantId !== undefined
          ? { tenantId: metadata.tenantId }
          : {}),
      };
  return {
    ...toRunnerProfileReference(profileSelection),
    turn: {
      sessionId: request.sessionId,
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      message: request.message,
      eventType: request.eventType,
      modeSystemV2Enabled: profile.modeSystemV2Enabled === true,
      interactionMode: resolvedMode.interactionMode,
      ...(resolvedMode.actSubmode !== undefined ? { actSubmode: resolvedMode.actSubmode } : {}),
      clientCapabilities: request.clientCapabilities ?? createWebClientCapabilities(),
      ...(request.executionPolicy !== undefined ? { executionPolicy: request.executionPolicy } : {}),
      ...(request.workspace !== undefined ? { workspace: request.workspace } : {}),
      ...(request.attachments !== undefined ? { attachments: request.attachments } : {}),
      ...(request.resumeBlockedRun === true ? { resumeBlockedRun: true } : {}),
      ...(actor !== undefined ? { actor } : {}),
      history: normalizeSubmittedHistory(request.history),
      ...(request.resumeFromWait === true ? {} : { stepAgent: getEntryStepAgent(profile) }),
    },
  };
}

function recordDurableEvent(entry: DurableRunEntry, event: WebRunnerEvent): void {
  if (typeof event.threadId === "string" && event.threadId.trim().length > 0) {
    entry.threadId = event.threadId.trim();
  }
  if (typeof event.sessionId === "string" && event.sessionId.trim().length > 0) {
    entry.sessionId = event.sessionId.trim();
  }
  entry.events.push(event);
  if (entry.events.length > 500) {
    entry.events.splice(0, entry.events.length - 500);
  }
  entry.lastActivityAt = event.ts;
  if (event.type === "run.started") {
    entry.status = "running";
  } else if (event.type === "run.completed") {
    entry.status = event.payload.result.output.status === "WAITING" ? "waiting" : "completed";
    entry.terminal = event;
  } else if (event.type === "run.failed" || event.type === "runner.error") {
    entry.status = "failed";
    if (event.type === "run.failed") {
      entry.terminal = event;
    }
  } else if (event.type === "run.cancelled") {
    entry.status = "canceled";
    entry.terminal = event;
  }
}

function findDurableRun(
  durableRuns: Map<string, DurableRunEntry>,
  input: { threadId: string; sessionId: string; runId?: string | undefined },
): DurableRunEntry | undefined {
  if (input.runId !== undefined) {
    return durableRuns.get(input.runId);
  }
  return [...durableRuns.values()].reverse().find((entry) =>
    entry.threadId === input.threadId || entry.sessionId === input.sessionId,
  );
}

function isActiveDurableRun(entry: DurableRunEntry): boolean {
  return entry.status === "starting" || entry.status === "running" || entry.status === "canceling";
}

function isDurableTerminalEvent(event: WebRunnerEvent): event is WebDurableTerminalEvent {
  return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";
}

function statusFromTerminalEvent(event: WebDurableTerminalEvent): ThreadRunCheckIn["status"] {
  if (event.type === "run.cancelled") {
    return "canceled";
  }
  if (event.type === "run.failed") {
    return "failed";
  }
  return event.payload.result.output.status === "WAITING" ? "waiting" : "completed";
}

function withDurableRunIdentity(
  event: WebRunnerEvent,
  runId: string,
  sessionId: string,
): WebRunnerEvent {
  return {
    ...event,
    runId: event.runId ?? runId,
    sessionId: event.sessionId ?? sessionId,
  } as WebRunnerEvent;
}

function createSyntheticRunnerError(
  commandId: string,
  error: unknown,
  sessionId: string,
  runId: string,
): WebRunnerEvent {
  return {
    id: randomUUID(),
    type: "runner.error",
    ts: new Date().toISOString(),
    commandId,
    sessionId,
    runId,
    payload: {
      code: "RUNNER_RUNTIME_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function clampHistoryWindow(history: WebHistoryLine[] | undefined): WebHistoryLine[] | undefined {
  return normalizeSubmittedHistory(history);
}

function getEntryStepAgent(profile: Pick<TuiProfile, "id" | "agent">): string {
  if (profile.agent === "reference-react") {
    return AGENT_STEP_IDS.loop;
  }

  throw createRuntimeFailure("WEB_ADAPTER_UNSUPPORTED_PROFILE_AGENT", `Unsupported profile agent '${profile.agent}'.`, {
    profileId: profile.id,
    agent: profile.agent,
  });
}

function sendCommand<TType extends RunnerCommandType>(
  client: ProtocolClient,
  type: TType,
  payload: RunnerCommandPayloadByType[TType],
  metadata?: RunnerCommandMetadata,
): Promise<RunnerEvent> {
  return client.sendCommand(type, payload, metadata);
}

function toRunnerCommandMetadata(
  profileSelection: WebRunnerProfileSelection,
  context: WebRunnerRequestContext | undefined,
  defaults: RunnerCommandMetadata | undefined,
): RunnerCommandMetadata | undefined {
  const actor = context?.actor ?? defaults?.actor;
  const tenantId = context?.tenantId ?? defaults?.tenantId;
  if (actor === undefined && tenantId === undefined) {
    return profileSelection.kind === "inline"
      ? { profile: profileSelection.resolvedProfile }
      : undefined;
  }
  return {
    ...(profileSelection.kind === "inline"
      ? { profile: profileSelection.resolvedProfile }
      : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
  };
}

function resolveWebRunnerProfileSelection(
  options: CreateWebRunnerAdapterOptions,
): WebRunnerProfileSelection {
  const inlineProfile = options.profile;
  const profileId = options.profileId;
  const resolvedProfile = options.resolvedProfile;
  if (inlineProfile !== undefined && (profileId !== undefined || resolvedProfile !== undefined)) {
    throw createRuntimeFailure(
      "WEB_ADAPTER_PROFILE_REFERENCE_CONFLICT",
      "Web runner adapter options must select either an inline profile or a registered profile, not both.",
    );
  }
  if (profileId !== undefined) {
    const normalizedProfileId = profileId.trim();
    if (normalizedProfileId.length === 0) {
      throw createRuntimeFailure(
        "WEB_ADAPTER_REGISTERED_PROFILE_ID_INVALID",
        "Web runner adapter registered profileId must be a non-empty string.",
      );
    }
    if (resolvedProfile === undefined) {
      throw createRuntimeFailure(
        "WEB_ADAPTER_REGISTERED_PROFILE_REQUIRED",
        "Web runner adapter registered profileId requires a resolvedProfile for client-side shaping.",
        { profileId: normalizedProfileId },
      );
    }
    if (resolvedProfile.id !== normalizedProfileId) {
      throw createRuntimeFailure(
        "WEB_ADAPTER_REGISTERED_PROFILE_MISMATCH",
        `Web runner adapter resolvedProfile.id '${resolvedProfile.id}' must match profileId '${normalizedProfileId}'.`,
        {
          profileId: normalizedProfileId,
          resolvedProfileId: resolvedProfile.id,
        },
      );
    }
    return {
      kind: "registered",
      profileId: normalizedProfileId,
      resolvedProfile,
    };
  }
  if (resolvedProfile !== undefined) {
    throw createRuntimeFailure(
      "WEB_ADAPTER_REGISTERED_PROFILE_ID_REQUIRED",
      "Web runner adapter resolvedProfile requires a registered profileId.",
      { resolvedProfileId: resolvedProfile.id },
    );
  }
  return {
    kind: "inline",
    resolvedProfile: inlineProfile ?? createWebDemoProfile(),
  };
}

function toRunnerProfileReference(
  profileSelection: WebRunnerProfileSelection,
): RunnerCommandPayloadByType["mcp.status"] {
  return profileSelection.kind === "registered"
    ? { profileId: profileSelection.profileId }
    : { profile: profileSelection.resolvedProfile };
}

function validateProtocolClientOptions(
  profileSelection: WebRunnerProfileSelection,
  options: ProtocolClientOptions | undefined,
): ProtocolClientOptions | undefined {
  if (profileSelection.kind === "registered" && options?.defaultMetadata?.profile !== undefined) {
    throw createRuntimeFailure(
      "WEB_ADAPTER_REGISTERED_METADATA_PROFILE_FORBIDDEN",
      "Web runner adapter registered profile mode cannot include an inline profile in protocol client metadata.",
      { profileId: profileSelection.profileId },
    );
  }
  if (options === undefined) {
    return undefined;
  }
  const metadata = options.defaultMetadata;
  return {
    ...(options.defaultExecutionDurability !== undefined
      ? { defaultExecutionDurability: options.defaultExecutionDurability }
      : {}),
    ...(metadata !== undefined
      ? {
          defaultMetadata: {
            ...(metadata.actor !== undefined ? { actor: { ...metadata.actor } } : {}),
            ...(metadata.tenantId !== undefined ? { tenantId: metadata.tenantId } : {}),
            ...(profileSelection.kind === "inline" && metadata.profile !== undefined
              ? { profile: metadata.profile }
              : {}),
            ...(metadata.durability !== undefined ? { durability: metadata.durability } : {}),
          },
        }
      : {}),
  };
}
