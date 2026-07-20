import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadRecord } from "../../src/kestrel/contracts/orchestration.js";
import {
  enqueueFollowUp,
  editFollowUp,
  markFollowUpStarting,
  pauseFollowUpQueue,
  readFollowUpQueue,
  removeFollowUp,
  resumeFollowUps,
} from "../../src/orchestration/FollowUpQueue.js";

const thread: ThreadRecord = {
  threadId: "thread-1",
  sessionId: "session-1",
  title: "Queue",
  status: "RUNNING",
  createdAt: "2026-07-20T12:00:00.000Z",
  updatedAt: "2026-07-20T12:00:00.000Z",
};

test("follow-up queue persists deterministic FIFO entries and deduplicates stable IDs", () => {
  const first = enqueueFollowUp(thread, {
    followUpId: "follow-up-1",
    message: "first",
    attachmentIds: [],
    interactionMode: "build",
    actSubmode: "safe",
    createdAt: "2026-07-20T12:00:01.000Z",
    state: "queued",
  });
  const second = enqueueFollowUp(first, {
    followUpId: "follow-up-2",
    message: "second",
    attachmentIds: ["attachment-2"],
    createdAt: "2026-07-20T12:00:01.000Z",
    state: "queued",
  });
  const duplicate = enqueueFollowUp(second, {
    followUpId: "follow-up-1",
    message: "must not replace",
    attachmentIds: [],
    createdAt: "2026-07-20T12:00:03.000Z",
    state: "queued",
  });

  assert.deepEqual(readFollowUpQueue(duplicate).items.map((entry) => entry.followUpId), [
    "follow-up-1",
    "follow-up-2",
  ]);
  assert.equal(readFollowUpQueue(duplicate).items[0]?.message, "first");
  const edited = editFollowUp(duplicate, "follow-up-1", "revised first");
  assert.equal(readFollowUpQueue(edited).items[0]?.message, "revised first");
  assert.deepEqual(readFollowUpQueue(edited).items.map((entry) => entry.followUpId), ["follow-up-1", "follow-up-2"]);
});

test("follow-up queue recovers starting entries when paused and resumed", () => {
  const queued = enqueueFollowUp(thread, {
    followUpId: "follow-up-1",
    message: "first",
    attachmentIds: [],
    createdAt: "2026-07-20T12:00:01.000Z",
    state: "queued",
  });
  const starting = markFollowUpStarting(queued, "follow-up-1");
  assert.equal(readFollowUpQueue(starting).items[0]?.state, "starting");

  const paused = pauseFollowUpQueue(starting, "failed");
  assert.equal(readFollowUpQueue(paused).state, "paused");
  assert.equal(readFollowUpQueue(paused).items[0]?.state, "queued");

  const resumed = resumeFollowUps(paused);
  assert.deepEqual(readFollowUpQueue(resumed), {
    state: "ready",
    items: [{
      followUpId: "follow-up-1",
      message: "first",
      attachmentIds: [],
      createdAt: "2026-07-20T12:00:01.000Z",
      state: "queued",
    }],
  });
  assert.deepEqual(readFollowUpQueue(removeFollowUp(resumed, "follow-up-1")), {
    state: "ready",
    items: [],
  });
});
