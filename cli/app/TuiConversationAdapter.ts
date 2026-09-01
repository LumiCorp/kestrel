import {
  createModeSwitchRetryGuard,
  projectConversationSnapshot,
  reduceConversationActivity,
  resolveConversationComposerPolicy,
  type ConversationActivityItem,
  type ConversationCommandAdapter,
  type ConversationInteraction,
  type ConversationMessageLike,
  type ConversationMode,
  type ConversationQueueState,
  type ConversationSnapshot,
  type ConversationTurn,
} from "@kestrel-agents/conversation";

import type { OperatorThreadView } from "../../src/orchestration/contracts.js";
import type { TranscriptLine } from "../contracts.js";
import type { ProtocolClient } from "../client/ProtocolClient.js";
import type {
  ConversationMessageSubmitCommandPayload,
  ConversationMessagesEventPayload,
  OperatorControlCommandPayload,
  RunnerCommandMetadata,
  RunnerEvent,
} from "../protocol/contracts.js";

export interface TuiConversationMessage extends ConversationMessageLike {
  line: TranscriptLine;
}

export interface TuiConversationAdapterIssue {
  code: "MISSING_EVENT_ID" | "MISSING_INTERACTION_TURN";
  detail: string;
}

export interface TuiConversationAdapterResult {
  snapshot: ConversationSnapshot<TuiConversationMessage>;
  projection: ReturnType<typeof projectConversationSnapshot<TuiConversationMessage>>;
  issues: TuiConversationAdapterIssue[];
}

/**
 * Keeps the TUI-owned standalone lane in its existing render slots while the
 * shared projector exclusively determines ordering inside the conversation
 * lane. Slot placement does not establish or infer conversation ownership.
 */
export function projectTuiTranscript(
  original: readonly TranscriptLine[],
  adapted: TuiConversationAdapterResult,
): TranscriptLine[] {
  const projectedConversationLines = adapted.projection.items.flatMap((item) =>
    item.kind === "durable_turn" ? item.messages.map((message) => message.line) : [],
  );
  const reorderableEventIds = new Set(
    projectedConversationLines.flatMap((line) => line.eventId === undefined ? [] : [line.eventId]),
  );
  let projectedIndex = 0;
  const result: TranscriptLine[] = [];
  for (const line of original) {
    if (line.eventId === undefined || reorderableEventIds.has(line.eventId) === false) {
      result.push(line);
      continue;
    }
    const projected = projectedConversationLines[projectedIndex];
    projectedIndex += 1;
    if (projected !== undefined) result.push(projected);
  }
  result.push(...projectedConversationLines.slice(projectedIndex));
  return result;
}

type TerminalOutcome = NonNullable<ConversationMessagesEventPayload["terminalOutcomes"]>[number];

/**
 * Converts TUI-owned text and Local Core lifecycle authority into the shared
 * identity model. Unowned legacy records remain standalone and are never
 * attached by text, timestamp, adjacency, or transcript position.
 */
export function adaptTuiConversation(input: {
  threadId: string;
  transcript: readonly TranscriptLine[];
  view?: OperatorThreadView | undefined;
  terminalOutcomes?: readonly TerminalOutcome[] | undefined;
}): TuiConversationAdapterResult {
  const issues: TuiConversationAdapterIssue[] = [];
  const cancelledRunIds = new Set([
    ...(input.terminalOutcomes ?? []).flatMap((outcome) =>
      outcome.outcomeStatus === "cancelled" ? [outcome.runId] : []),
    ...input.transcript.flatMap((line) =>
      line.data?.terminalStatus === "cancelled"
        ? [line.run?.runId ?? readString(line.data.runId)].filter((runId): runId is string => runId !== undefined)
        : []),
  ]);
  const turns = (input.view?.conversationTurns ?? []).map((turn) =>
    toConversationTurn(turn, [turn.rootRunId, turn.activeRunId, turn.terminalRunId]
      .some((runId) => runId !== undefined && cancelledRunIds.has(runId))),
  );
  const turnByRunId = new Map<string, ConversationTurn>();
  const turnByMessageId = new Map<string, ConversationTurn>();
  for (const turn of turns) {
    if (turn.inputMessageId !== null) turnByMessageId.set(turn.inputMessageId, turn);
    for (const runId of [turn.rootRunId, turn.activeRunId, turn.terminalRunId]) {
      if (runId) turnByRunId.set(runId, turn);
    }
  }
  const routeByMessageId = new Map(
    (input.view?.conversationMessageRoutes ?? []).map((route) => [route.messageId, route]),
  );
  const messages: TuiConversationMessage[] = input.transcript.map((line) => {
    const messageId = readLineMessageId(line);
    if (line.eventId === undefined) {
      issues.push({
        code: "MISSING_EVENT_ID",
        detail: `TUI history record '${messageId}' has no stable event identity.`,
      });
    }
    const route = routeByMessageId.get(messageId);
    const runId = line.run?.runId ?? readString(line.data?.runId) ?? route?.runId;
    const turnId = readString(line.data?.turnId)
      ?? route?.turnId
      ?? turnByMessageId.get(messageId)?.id
      ?? (runId === undefined ? undefined : turnByRunId.get(runId)?.id);
    const deliveryState = route?.disposition === "queued"
      ? "queued"
      : readDeliveryState(line);
    return {
      id: messageId,
      role: line.role,
      line,
      ...(
        turnId === undefined && runId === undefined && deliveryState === undefined
          ? {}
          : {
              metadata: {
                ...(turnId !== undefined ? { kestrelTurnId: turnId } : {}),
                ...(runId !== undefined ? { kestrelRunId: runId } : {}),
                ...(deliveryState !== undefined ? { deliveryState } : {}),
              },
            }
      ),
    };
  });
  const messageIds = new Set(messages.map((message) => message.id));
  for (const outcome of input.terminalOutcomes ?? []) {
    const terminalId = `terminal:${outcome.runId}`;
    if (messageIds.has(terminalId)) continue;
    const line = projectTuiTerminalOutcome(outcome);
    messages.push({
      id: terminalId,
      role: line.role,
      line,
      metadata: {
        kestrelTurnId: outcome.turnId,
        kestrelRunId: outcome.runId,
      },
    });
    messageIds.add(terminalId);
  }
  const interactions = (input.view?.inboxItems ?? []).flatMap((item) => {
    if (
      (item.kind !== "approval_request" && item.kind !== "user_input_request")
      || item.requestId === undefined
    ) return [];
    if (item.turnId === undefined) {
      issues.push({
        code: "MISSING_INTERACTION_TURN",
        detail: `Interaction '${item.requestId}' has no durable turn identity.`,
      });
    }
    return [{
      id: item.itemId,
      requestId: item.requestId,
      source: "runtime",
      kind: item.kind === "approval_request" ? "approval" : "user_input",
      eventType: item.interaction?.eventType ?? item.kind,
      prompt: item.interaction?.prompt ?? item.detail ?? item.title,
      status: "pending",
      turnId: item.turnId ?? null,
      assistantMessageId: null,
      responseMessageId: null,
      createdAt: item.createdAt,
      ...(item.metadata !== undefined ? { requestEnvelope: item.metadata } : {}),
    } satisfies ConversationInteraction];
  });
  const queue = toConversationQueue(input.view, turns, turnByRunId);
  const snapshot: ConversationSnapshot<TuiConversationMessage> = {
    threadId: input.threadId,
    messages,
    turns,
    interactions,
    queue,
  };
  return {
    snapshot,
    projection: projectConversationSnapshot(snapshot),
    issues,
  };
}

export function resolveTuiComposerPolicy(
  snapshot: ConversationSnapshot<TuiConversationMessage>,
  transportStatus: "submitted" | "streaming" | "ready" | "error",
) {
  return resolveConversationComposerPolicy({
    turns: snapshot.turns,
    interactions: snapshot.interactions,
    queue: snapshot.queue,
    transportStatus,
  });
}

export function reduceTuiConversationActivity(
  current: readonly ConversationActivityItem[],
  event: RunnerEvent,
): ConversationActivityItem[] {
  return reduceConversationActivity(current, {
    id: event.id,
    type: event.type,
    ts: event.ts,
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    payload: event.payload as unknown as Record<string, unknown>,
  });
}

export interface TuiTurnSubmission {
  payload: ConversationMessageSubmitCommandPayload;
  metadata?: RunnerCommandMetadata | undefined;
  install(event: RunnerEvent): void | Promise<void>;
}

export type TuiInteractionAnswer =
  | {
      requestId: string;
      payload: OperatorControlCommandPayload;
      metadata?: RunnerCommandMetadata | undefined;
      install(event: RunnerEvent): void | Promise<void>;
    }
  | {
      requestId: string;
      execute(): void | Promise<void>;
    };

export function createTuiConversationCommandAdapter(input: {
  client: ProtocolClient;
  resolveInterrupt(target: { threadId: string; turnId: string }): {
    sessionId: string;
    runId: string;
    metadata?: RunnerCommandMetadata | undefined;
  } | undefined;
  installInterrupt(event: RunnerEvent): void | Promise<void>;
  switchMode(mode: ConversationMode): void | Promise<void>;
  modeSwitchGuard?: ReturnType<typeof createModeSwitchRetryGuard> | undefined;
}): ConversationCommandAdapter<TuiTurnSubmission, TuiInteractionAnswer, void> {
  const modeSwitchGuard = input.modeSwitchGuard ?? createModeSwitchRetryGuard();
  const submit = async (submission: TuiTurnSubmission) => {
    const response = await input.client.sendCommand(
      "conversation.message.submit",
      submission.payload,
      submission.metadata,
    );
    await submission.install(response);
  };
  const answer = async (interaction: TuiInteractionAnswer) => {
    if ("execute" in interaction) {
      await interaction.execute();
      return;
    }
    if (interaction.payload.requestId !== interaction.requestId) {
      throw new Error("TUI interaction request identity does not match its command.");
    }
    const response = await input.client.sendCommand(
      "operator.control",
      interaction.payload,
      interaction.metadata,
    );
    await interaction.install(response);
  };
  return {
    startTurn: submit,
    queueTurn: submit,
    answerInteraction: answer,
    async interruptTurn(target) {
      const resolved = input.resolveInterrupt(target);
      if (resolved === undefined) {
        throw new Error(`TUI turn '${target.turnId}' has no authoritative active run.`);
      }
      await input.installInterrupt(await input.client.sendCommand(
        "run.cancel",
        { sessionId: resolved.sessionId, runId: resolved.runId },
        resolved.metadata,
      ));
    },
    async switchModeAndRetry(command) {
      await modeSwitchGuard.run({
        recommendationId: command.recommendationId,
        mode: command.mode,
        switchMode: input.switchMode,
        switchModeTiming: "after_retry",
        retry: () => answer(command.answer),
      });
    },
  };
}

function toConversationTurn(
  turn: NonNullable<OperatorThreadView["conversationTurns"]>[number],
  cancelled: boolean,
): ConversationTurn {
  return {
    id: turn.turnId,
    threadId: turn.threadId,
    sequence: turn.sequence,
    inputMessageId: turn.sourceMessageId ?? null,
    status: turn.status === "RUNNING"
      ? "running"
      : turn.status === "WAITING"
        ? "waiting_for_input"
        : turn.status === "FAILED"
          ? cancelled ? "cancelled" : "failed"
          : "completed",
    rootRunId: turn.rootRunId ?? null,
    activeRunId: turn.activeRunId ?? null,
    terminalRunId: turn.terminalRunId ?? null,
    startedAt: turn.startedAt,
    finishedAt: turn.completedAt ?? null,
    createdAt: turn.startedAt,
    updatedAt: turn.updatedAt,
  };
}

function toConversationQueue(
  view: OperatorThreadView | undefined,
  turns: readonly ConversationTurn[],
  turnByRunId: ReadonlyMap<string, ConversationTurn>,
): ConversationQueueState {
  const activeTurnId = view?.activeRun?.runId === undefined
    ? turns.find((turn) => turn.status === "running" || turn.status === "waiting_for_input")?.id ?? null
    : turnByRunId.get(view.activeRun.runId)?.id ?? null;
  const paused = view?.followUpQueue?.state === "paused";
  const reason = view?.followUpQueue?.pauseReason;
  return {
    state: paused ? "paused" : "running",
    pauseReason: !paused
      ? null
      : reason === "failed"
        ? "turn_failed"
        : reason === "cancelled"
          ? "turn_cancelled"
          : "interaction_required",
    activeTurnId,
    version: 0,
  };
}

function readLineMessageId(line: TranscriptLine): string {
  const explicit = readString(line.data?.messageId);
  if (explicit !== undefined) return explicit;
  if (line.eventId !== undefined) return line.eventId;
  if (
    line.run?.runId !== undefined
    && line.role !== "user"
    && line.data?.kind === "runtime.terminal.v1"
  ) return `terminal:${line.run.runId}`;
  return `legacy-unowned:${readString(line.data?.legacyId) ?? "record"}`;
}

function readDeliveryState(line: TranscriptLine): "submitting" | "queued" | undefined {
  const state = line.data?.deliveryState;
  return state === "submitting" || state === "queued" ? state : undefined;
}

export function projectTuiTerminalOutcome(outcome: TerminalOutcome): TranscriptLine {
  const timestamp = outcome.completedAt;
  const eventId = `terminal:${outcome.runId}`;
  if (outcome.handoffState === "failed") {
    return {
      eventId,
      role: "system",
      text: `Final response contract failure: ${outcome.finalizationError?.message ?? "The final response could not be delivered."}`,
      data: {
        kind: "runtime.terminal.v1",
        turnId: outcome.turnId,
        runId: outcome.runId,
        terminalStatus: "contract_failure",
        contractFailure: outcome.finalizationError,
      },
      timestamp,
    };
  }
  const output = outcome.result?.output;
  const cancelled = outcome.outcomeStatus === "cancelled";
  const failed = outcome.outcomeStatus === "failed";
  const assistantText = outcome.result?.assistantText?.trim();
  const role = !cancelled && !failed && assistantText ? "assistant" : "system";
  const text = assistantText
    || (cancelled
      ? "Run cancelled."
      : failed
        ? `Run failed: ${output?.errors[0]?.message ?? "Run failed."}`
        : "Run completed without an assistant response.");
  return {
    eventId,
    role,
    text,
    data: {
      kind: "runtime.terminal.v1",
      turnId: outcome.turnId,
      runId: outcome.runId,
      terminalStatus: cancelled ? "cancelled" : failed ? "failed" : "completed",
    },
    timestamp,
    ...(output === undefined
      ? {}
      : {
          run: {
            runId: output.runId,
            status: output.status,
            telemetry: output.telemetry,
            errors: output.errors,
          },
        }),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
