import type {
  DesktopConversationMessageRoute,
  DesktopConversationMessageResult,
  DesktopFollowUpQueueEntry,
} from "../../src/contracts";
import {
  acceptRendererPrompt,
  appendRendererTranscript,
  type DesktopRendererState,
  type RendererTranscriptLine,
} from "./state";

interface ConversationSubmissionProjectionInput {
  threadId: string;
  messageId: string;
  message: string;
  submittedAt: string;
  disposition: DesktopConversationMessageResult["disposition"] | "submitting";
}

export interface DesktopConversationSubmissionIdentity {
  threadId: string;
  sessionId: string;
  messageId: string;
  message: string;
  submittedAt: string;
  projectPath?: string | undefined;
}

export function resolveDesktopStartedSubmission(input: {
  sourceMessageId?: string | undefined;
  sessionId: string;
  pending: readonly DesktopConversationSubmissionIdentity[];
  queued: readonly DesktopConversationSubmissionIdentity[];
}): DesktopConversationSubmissionIdentity | undefined {
  if (input.sourceMessageId !== undefined) {
    return [...input.pending, ...input.queued].find(
      (submission) => submission.messageId === input.sourceMessageId,
    );
  }
  const sessionCandidates = new Map<string, DesktopConversationSubmissionIdentity>();
  for (const submission of [...input.pending, ...input.queued]) {
    if (submission.sessionId === input.sessionId) {
      sessionCandidates.set(submission.messageId, submission);
    }
  }
  return sessionCandidates.size === 1
    ? sessionCandidates.values().next().value
    : undefined;
}

export function projectDesktopConversationSubmission(
  state: DesktopRendererState,
  input: ConversationSubmissionProjectionInput,
): DesktopRendererState {
  const accepted = acceptRendererPrompt(state, input.threadId, input.message);
  if (input.disposition === "queued") {
    return removeUserMessage(
      accepted,
      input.threadId,
      input.messageId,
    );
  }
  return upsertUserMessage(
    accepted,
    input.threadId,
    userMessageLine(input, input.disposition === "submitting"),
  );
}

export function revertDesktopConversationSubmission(
  state: DesktopRendererState,
  threadId: string,
  messageId: string,
): DesktopRendererState {
  return removeUserMessage(state, threadId, messageId);
}

export function recoverDesktopConversationSubmissionDisposition(input: {
  messageId: string;
  observedStart: boolean;
  routes: readonly DesktopConversationMessageRoute[];
}): DesktopConversationMessageResult["disposition"] | undefined {
  if (input.observedStart) return "started";
  return input.routes.find((route) => route.messageId === input.messageId)?.disposition;
}

export function projectDesktopStartingFollowUps(
  state: DesktopRendererState,
  threadId: string,
  items: readonly DesktopFollowUpQueueEntry[],
): DesktopRendererState {
  return items
    .filter(
      (item) =>
        item.state === "starting" && item.sourceMessageId !== undefined,
    )
    .reduce(
      (current, item) =>
        appendRendererTranscript(current, threadId, {
          role: "user",
          text: item.message,
          timestamp: item.createdAt,
          data: {
            kind: "desktop.user-message.v1",
            messageId: item.sourceMessageId,
            followUpId: item.followUpId,
          },
        }),
      state,
    );
}

export function queuedDesktopFollowUps(
  items: readonly DesktopFollowUpQueueEntry[],
): DesktopFollowUpQueueEntry[] {
  return items.filter((item) => item.state === "queued");
}

export function markDesktopFollowUpStarted(
  items: readonly DesktopFollowUpQueueEntry[],
  sourceMessageId: string,
): DesktopFollowUpQueueEntry[] {
  return items.map((item) =>
    item.sourceMessageId === sourceMessageId
      ? { ...item, state: "starting" }
      : item,
  );
}

function userMessageLine(
  input: Pick<
    ConversationSubmissionProjectionInput,
    "messageId" | "message" | "submittedAt"
  >,
  submitting = false,
): RendererTranscriptLine {
  return {
    role: "user",
    text: input.message,
    timestamp: input.submittedAt,
    data: {
      kind: "desktop.user-message.v1",
      messageId: input.messageId,
      ...(submitting ? { deliveryState: "submitting" } : {}),
    },
  };
}

function upsertUserMessage(
  state: DesktopRendererState,
  threadId: string,
  line: RendererTranscriptLine,
): DesktopRendererState {
  const messageId = readUserMessageId(line);
  if (messageId === undefined) {
    return appendRendererTranscript(state, threadId, line);
  }
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (thread?.transcript.some((entry) => readUserMessageId(entry) === messageId) !== true) {
    return appendRendererTranscript(state, threadId, line);
  }
  return {
    ...state,
    threads: state.threads.map((entry) => entry.id !== threadId
      ? entry
      : {
          ...entry,
          updatedAt: line.timestamp,
          transcript: entry.transcript.map((candidate) =>
            readUserMessageId(candidate) === messageId ? line : candidate),
        }),
  };
}

function removeUserMessage(
  state: DesktopRendererState,
  threadId: string,
  messageId: string,
): DesktopRendererState {
  return {
    ...state,
    threads: state.threads.map((thread) =>
      thread.id !== threadId
        ? thread
        : {
            ...thread,
            transcript: thread.transcript.filter((line) => {
              if (
                line.role !== "user" ||
                typeof line.data !== "object" ||
                line.data === null ||
                Array.isArray(line.data)
              ) {
                return true;
              }
              const data = line.data as Record<string, unknown>;
              return !(
                data.kind === "desktop.user-message.v1" &&
                data.messageId === messageId
              );
            }),
          },
    ),
  };
}

function readUserMessageId(line: RendererTranscriptLine): string | undefined {
  if (
    line.role !== "user" ||
    typeof line.data !== "object" ||
    line.data === null ||
    Array.isArray(line.data)
  ) {
    return undefined;
  }
  const data = line.data as Record<string, unknown>;
  return data.kind === "desktop.user-message.v1" && typeof data.messageId === "string"
    ? data.messageId
    : undefined;
}
