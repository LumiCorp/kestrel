import test from "node:test";
import assert from "node:assert/strict";

import {
  markDesktopFollowUpStarted,
  projectDesktopConversationSubmission,
  projectDesktopStartingFollowUps,
  queuedDesktopFollowUps,
  recoverDesktopConversationSubmissionDisposition,
  resolveDesktopStartedSubmission,
  revertDesktopConversationSubmission,
} from "../renderer/src/conversationSubmission.js";
import {
  createRendererThread,
  updateRendererDraft,
  type DesktopRendererState,
} from "../renderer/src/state.js";
import type { DesktopFollowUpQueueEntry } from "../src/contracts.js";

const MESSAGE_ID = "message-queued-1";
const FOLLOW_UP_ID = `follow-up:${MESSAGE_ID}`;
const SUBMITTED_AT = "2026-08-13T18:00:00.000Z";

test("Desktop renders a submitted message immediately and settles the same identity in place", () => {
  const initial = stateWithDraft("Show this immediately");
  const threadId = initial.activeThreadId;
  const submitting = projectDesktopConversationSubmission(initial, {
    threadId,
    messageId: MESSAGE_ID,
    message: "Show this immediately",
    submittedAt: SUBMITTED_AT,
    disposition: "submitting",
  });

  assert.deepEqual(submitting.threads[0]?.transcript.map((line) => ({
    text: line.text,
    data: line.data,
  })), [{
    text: "Show this immediately",
    data: {
      kind: "desktop.user-message.v1",
      messageId: MESSAGE_ID,
      deliveryState: "submitting",
    },
  }]);

  const started = projectDesktopConversationSubmission(submitting, {
    threadId,
    messageId: MESSAGE_ID,
    message: "Show this immediately",
    submittedAt: SUBMITTED_AT,
    disposition: "started",
  });
  assert.equal(started.threads[0]?.transcript.length, 1);
  assert.deepEqual(started.threads[0]?.transcript[0]?.data, {
    kind: "desktop.user-message.v1",
    messageId: MESSAGE_ID,
  });
});

test("Desktop preserves deliberate repeated text when each submission has a distinct identity", () => {
  const initial = stateWithDraft("Try again");
  const threadId = initial.activeThreadId;
  const first = projectDesktopConversationSubmission(initial, {
    threadId,
    messageId: "message-repeat-1",
    message: "Try again",
    submittedAt: SUBMITTED_AT,
    disposition: "started",
  });
  const second = projectDesktopConversationSubmission(first, {
    threadId,
    messageId: "message-repeat-2",
    message: "Try again",
    submittedAt: "2026-08-13T18:00:01.000Z",
    disposition: "started",
  });

  assert.deepEqual(
    second.threads[0]?.transcript.map((line) => [line.text, (line.data as { messageId: string }).messageId]),
    [["Try again", "message-repeat-1"], ["Try again", "message-repeat-2"]],
  );
});

test("Desktop reverts an optimistic message only when submission is authoritatively rejected", () => {
  const initial = stateWithDraft("Retry me");
  const threadId = initial.activeThreadId;
  const submitting = projectDesktopConversationSubmission(initial, {
    threadId,
    messageId: MESSAGE_ID,
    message: "Retry me",
    submittedAt: SUBMITTED_AT,
    disposition: "submitting",
  });

  const reverted = revertDesktopConversationSubmission(
    submitting,
    threadId,
    MESSAGE_ID,
  );
  assert.deepEqual(reverted.threads[0]?.transcript, []);
});

test("Desktop treats an accepted route as sent when the submit transport times out", () => {
  assert.equal(recoverDesktopConversationSubmissionDisposition({
    messageId: MESSAGE_ID,
    observedStart: true,
    routes: [],
  }), "started");
  assert.equal(recoverDesktopConversationSubmissionDisposition({
    messageId: MESSAGE_ID,
    observedStart: false,
    routes: [{
      messageId: MESSAGE_ID,
      disposition: "started",
      createdAt: SUBMITTED_AT,
      runId: "run-accepted",
      turnId: "turn-accepted",
    }],
  }), "started");
  assert.equal(recoverDesktopConversationSubmissionDisposition({
    messageId: MESSAGE_ID,
    observedStart: false,
    routes: [],
  }), undefined);
});

test("Desktop keeps a queued message out of the sent transcript until its follow-up starts", () => {
  const initial = stateWithDraft("Wait until the current work finishes");
  const threadId = initial.activeThreadId;
  const queued = projectDesktopConversationSubmission(initial, {
    threadId,
    messageId: MESSAGE_ID,
    message: "Wait until the current work finishes",
    submittedAt: SUBMITTED_AT,
    disposition: "queued",
  });

  assert.equal(queued.threads[0]?.draft, "");
  assert.deepEqual(queued.threads[0]?.transcript, []);

  const starting = projectDesktopStartingFollowUps(
    queued,
    threadId,
    [followUp("starting")],
  );
  assert.deepEqual(
    starting.threads[0]?.transcript.map((line) => [line.role, line.text]),
    [["user", "Wait until the current work finishes"]],
  );
});

test("Desktop removes a raced sent projection when Core authoritatively queues the message", () => {
  const initial = stateWithDraft("Queue this exactly once");
  const threadId = initial.activeThreadId;
  const raced = projectDesktopConversationSubmission(initial, {
    threadId,
    messageId: MESSAGE_ID,
    message: "Queue this exactly once",
    submittedAt: SUBMITTED_AT,
    disposition: "started",
  });
  const queued = projectDesktopConversationSubmission(raced, {
    threadId,
    messageId: MESSAGE_ID,
    message: "Queue this exactly once",
    submittedAt: SUBMITTED_AT,
    disposition: "queued",
  });

  assert.deepEqual(queued.threads[0]?.transcript, []);
});

test("Desktop renders only queued entries in the queued follow-up surface", () => {
  assert.deepEqual(
    queuedDesktopFollowUps([followUp("starting"), {
      ...followUp("queued"),
      followUpId: "follow-up:message-queued-2",
      sourceMessageId: "message-queued-2",
    }]).map((item) => item.followUpId),
    ["follow-up:message-queued-2"],
  );
});

test("Desktop hides a routed queue item when its exact message has already started", () => {
  const items = markDesktopFollowUpStarted(
    [followUp("queued")],
    MESSAGE_ID,
  );

  assert.equal(items[0]?.state, "starting");
  assert.deepEqual(queuedDesktopFollowUps(items), []);
});

test("Desktop recovers the exact pending message when legacy run.started omits sourceMessageId", () => {
  const submission = {
    threadId: "renderer-thread-1",
    sessionId: "session-1",
    messageId: MESSAGE_ID,
    message: "Show me before activity",
    submittedAt: SUBMITTED_AT,
  };

  assert.deepEqual(resolveDesktopStartedSubmission({
    sessionId: "session-1",
    pending: [submission],
    queued: [],
  }), submission);
  assert.equal(resolveDesktopStartedSubmission({
    sessionId: "session-1",
    pending: [submission, { ...submission, messageId: "message-2" }],
    queued: [],
  }), undefined);
});

function stateWithDraft(draft: string): DesktopRendererState {
  const thread = createRendererThread();
  const state: DesktopRendererState = {
    entries: {},
    activeThreadId: thread.id,
    threads: [thread],
    theme: "system",
  };
  return updateRendererDraft(state, thread.id, draft);
}

function followUp(
  state: DesktopFollowUpQueueEntry["state"],
): DesktopFollowUpQueueEntry {
  return {
    followUpId: FOLLOW_UP_ID,
    message: "Wait until the current work finishes",
    attachmentIds: [],
    createdAt: SUBMITTED_AT,
    state,
    source: "human",
    sourceMessageId: MESSAGE_ID,
  };
}
