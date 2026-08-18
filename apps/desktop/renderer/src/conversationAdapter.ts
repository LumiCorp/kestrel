import {
  projectConversationSnapshot,
  type ConversationInteraction,
  type ConversationMessageLike,
  type ConversationQueueState,
  type ConversationSnapshot,
  type ConversationTurn,
} from "@kestrel-agents/conversation";

import type {
  DesktopConversationMessageRoute,
  DesktopConversationTurn,
  DesktopFollowUpQueueEntry,
  DesktopOperatorInboxItem,
} from "../../src/contracts";
import type { RendererTranscriptLine } from "./state";

export interface DesktopConversationMessage extends ConversationMessageLike {
  line: RendererTranscriptLine;
  createdAt: string;
}

export interface DesktopConversationAdapterIssue {
  code: "MISSING_MESSAGE_ID" | "MISSING_INTERACTION_TURN";
  detail: string;
}

export interface DesktopConversationAdapterResult {
  snapshot: ConversationSnapshot<DesktopConversationMessage>;
  projection: ReturnType<typeof projectConversationSnapshot<DesktopConversationMessage>>;
  issues: DesktopConversationAdapterIssue[];
}

/**
 * Converts Desktop host state into the shared identity model. The adapter may
 * preserve an unowned legacy line for display, but it never assigns that line
 * to a durable turn without a source message, turn, request, or run identity.
 */
export function adaptDesktopConversation(input: {
  threadId: string;
  transcript: readonly RendererTranscriptLine[];
  turns: readonly DesktopConversationTurn[];
  messageRoutes?: readonly DesktopConversationMessageRoute[] | undefined;
  inboxItems?: readonly DesktopOperatorInboxItem[] | undefined;
  followUpQueue?: {
    state: "ready" | "paused";
    pauseReason?: "waiting" | "failed" | "cancelled" | "operator" | undefined;
    items: readonly DesktopFollowUpQueueEntry[];
  } | undefined;
  activeRunId?: string | undefined;
}): DesktopConversationAdapterResult {
  const issues: DesktopConversationAdapterIssue[] = [];
  const turns = input.turns.map(toConversationTurn);
  const turnByRunId = new Map<string, ConversationTurn>();
  const turnByInputMessageId = new Map<string, ConversationTurn>();
  for (const turn of turns) {
    if (turn.inputMessageId) turnByInputMessageId.set(turn.inputMessageId, turn);
    for (const runId of [turn.rootRunId, turn.activeRunId, turn.terminalRunId]) {
      if (runId) turnByRunId.set(runId, turn);
    }
  }
  const routeByMessageId = new Map(
    (input.messageRoutes ?? []).map((route) => [route.messageId, route]),
  );
  const messages = input.transcript.map((line, index) => {
    const identity = readMessageIdentity(line);
    if (identity === undefined) {
      issues.push({
        code: "MISSING_MESSAGE_ID",
        detail: `Transcript line ${index + 1} has no durable message, dialog, or run identity.`,
      });
    }
    const route = identity === undefined ? undefined : routeByMessageId.get(identity);
    const primaryTurn = identity === undefined ? undefined : turnByInputMessageId.get(identity);
    const runId = line.terminal?.runId
      ?? line.dialog?.parentRunId
      ?? route?.runId
      ?? primaryTurn?.rootRunId
      ?? undefined;
    const deliveryState = readMessageDeliveryState(line);
    const explicitTurnId = line.terminal?.turnId
      ?? route?.turnId
      ?? (runId === undefined ? undefined : turnByRunId.get(runId)?.id)
      ?? primaryTurn?.id;
    return {
      id: identity ?? `desktop-unowned:${input.threadId}:${index}`,
      role: line.role,
      line,
      createdAt: line.timestamp,
      ...(explicitTurnId === undefined && runId === undefined && deliveryState === undefined
        ? {}
        : {
            metadata: {
              ...(explicitTurnId !== undefined ? { kestrelTurnId: explicitTurnId } : {}),
              ...(runId !== undefined ? { kestrelRunId: runId } : {}),
              ...(deliveryState !== undefined ? { deliveryState } : {}),
            },
          }),
    } satisfies DesktopConversationMessage;
  });
  const interactions = (input.inboxItems ?? []).flatMap((item) => {
    if (
      (item.kind !== "approval_request" && item.kind !== "user_input_request") ||
      item.requestId === undefined
    ) {
      return [];
    }
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
      eventType: item.detail ?? item.kind,
      prompt: item.title,
      status: "pending",
      turnId: item.turnId ?? null,
      assistantMessageId: null,
      responseMessageId: null,
      createdAt: item.createdAt,
      ...(item.metadata === undefined ? {} : { requestEnvelope: item.metadata }),
    } satisfies ConversationInteraction];
  });
  const queue = toConversationQueue(input, turns, turnByRunId);
  const snapshot: ConversationSnapshot<DesktopConversationMessage> = {
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

function toConversationTurn(turn: DesktopConversationTurn): ConversationTurn {
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
          ? "failed"
          : turn.terminalStatus === "CANCELLED"
            ? "cancelled"
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
  input: Parameters<typeof adaptDesktopConversation>[0],
  turns: readonly ConversationTurn[],
  turnByRunId: ReadonlyMap<string, ConversationTurn>,
): ConversationQueueState {
  const activeTurns = turns.filter(
    (turn) => turn.status === "running" || turn.status === "waiting_for_input",
  );
  const activeTurnId = input.activeRunId === undefined
    ? activeTurns.length === 1 ? activeTurns[0]!.id : null
    : turnByRunId.get(input.activeRunId)?.id ?? null;
  const pauseReason = input.followUpQueue?.state !== "paused"
    ? null
    : input.followUpQueue.pauseReason === "failed"
      ? "turn_failed"
      : input.followUpQueue.pauseReason === "cancelled"
        ? "turn_cancelled"
        : "interaction_required";
  return {
    state: input.followUpQueue?.state === "paused" ? "paused" : "running",
    pauseReason,
    activeTurnId,
    version: 0,
  };
}

function readMessageIdentity(line: RendererTranscriptLine): string | undefined {
  if (typeof line.data === "object" && line.data !== null && !Array.isArray(line.data)) {
    const data = line.data as Record<string, unknown>;
    if (data.kind === "desktop.user-message.v1" && typeof data.messageId === "string") {
      return data.messageId;
    }
    if (typeof data.kestrelMessageId === "string" && data.kestrelMessageId.trim().length > 0) {
      return data.kestrelMessageId;
    }
  }
  if (line.dialog?.messageId !== undefined) return line.dialog.messageId;
  if (line.terminal?.runId !== undefined) return `terminal:${line.terminal.runId}`;
  return undefined;
}

function readMessageDeliveryState(
  line: RendererTranscriptLine,
): "submitting" | "queued" | undefined {
  if (typeof line.data !== "object" || line.data === null || Array.isArray(line.data)) {
    return undefined;
  }
  const data = line.data as Record<string, unknown>;
  return data.kind === "desktop.user-message.v1" &&
    (data.deliveryState === "submitting" || data.deliveryState === "queued")
    ? data.deliveryState
    : undefined;
}
