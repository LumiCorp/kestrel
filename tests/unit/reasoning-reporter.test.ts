import assert from "node:assert/strict";
import test from "node:test";

import {
  FanoutReasoningReporter,
  NoopReasoningReporter,
} from "../../src/logging/RunLogger.js";
import type { ModelReasoningUpdateV1 } from "../../src/kestrel/contracts/events.js";

const update: ModelReasoningUpdateV1 = {
  version: "v1",
  runId: "run-1",
  sessionId: "session-1",
  ts: "2026-07-15T12:00:00.000Z",
  seq: 1,
  event: "delta",
  attempt: 1,
  format: "summary",
  delta: "Checking the contract.",
  contentState: "live",
};

test("live reasoning listeners cannot apply backpressure to provider inference", async () => {
  let listenerStarted = false;
  let releaseListener!: () => void;
  const listenerFinished = new Promise<void>((resolve) => {
    releaseListener = resolve;
  });
  const reporter = new FanoutReasoningReporter(
    new NoopReasoningReporter(),
    async () => {
      listenerStarted = true;
      await listenerFinished;
    },
  );

  await reporter.emit(update);

  assert.equal(listenerStarted, true);
  releaseListener();
  await listenerFinished;
});

test("rejected live reasoning delivery does not fail provider inference", async () => {
  const reporter = new FanoutReasoningReporter(
    new NoopReasoningReporter(),
    async () => {
      throw new Error("transport disconnected");
    },
  );

  await reporter.emit(update);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
});
