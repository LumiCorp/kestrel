import assert from "node:assert/strict";
import test from "node:test";

import { getDesktopComposerSubmissionPolicy } from "../renderer/src/composerPolicy.js";
import type { DesktopOperatorInboxItem } from "../src/contracts.js";

test("Desktop composer answers the exact pending user-input request", () => {
  const request = {
    itemId: "request:request-1",
    kind: "user_input_request",
    threadId: "thread-main:session-1",
    sessionId: "session-1",
    title: "Which workspace should I inspect?",
    actionable: true,
    requestId: "request-1",
    createdAt: "2026-07-20T12:00:00.000Z",
  } satisfies DesktopOperatorInboxItem;

  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [request],
    runActive: true,
  }), {
    mode: "reply_to_request",
    item: request,
  });
});

test("Desktop composer ignores resolved user-input requests", () => {
  const request = {
    itemId: "request:request-1",
    kind: "user_input_request",
    threadId: "thread-main:session-1",
    sessionId: "session-1",
    title: "Which workspace should I inspect?",
    actionable: false,
    requestId: "request-1",
    createdAt: "2026-07-20T12:00:00.000Z",
  } satisfies DesktopOperatorInboxItem;

  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [request],
    runActive: false,
  }), { mode: "start_turn" });
});

test("Desktop composer queues ordinary input only while a run is active", () => {
  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [],
    runActive: true,
  }), { mode: "queue_follow_up" });
  assert.deepEqual(getDesktopComposerSubmissionPolicy({
    inboxItems: [],
    runActive: false,
  }), { mode: "start_turn" });
});
