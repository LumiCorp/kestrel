import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopBeforeQuitHandler } from "../src/lifecycle.js";

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("createDesktopBeforeQuitHandler prevents quit once, drains managed runs first, and ignores reentry", async () => {
  const order: string[] = [];
  const stopRuns = createDeferred();
  let prevented = 0;
  let quitCalls = 0;

  const handleBeforeQuit = createDesktopBeforeQuitHandler({
    stopProjectRuns: async () => {
      order.push("stop-project-runs:start");
      await stopRuns.promise;
      order.push("stop-project-runs:done");
    },
    closeWebServer: async () => {
      order.push("close-web-server");
    },
    stopRunner: async () => {
      order.push("stop-runner");
    },
    quitApp: () => {
      quitCalls += 1;
      order.push("quit-app");
    },
  });

  handleBeforeQuit({
    preventDefault() {
      prevented += 1;
      order.push("prevent-default");
    },
  });

  handleBeforeQuit({
    preventDefault() {
      prevented += 1;
      order.push("prevent-default:reentry");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(prevented, 1);
  assert.equal(quitCalls, 0);
  assert.deepEqual(order, [
    "prevent-default",
    "stop-project-runs:start",
  ]);

  stopRuns.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(quitCalls, 1);
  assert.deepEqual(order, [
    "prevent-default",
    "stop-project-runs:start",
    "stop-project-runs:done",
    "close-web-server",
    "stop-runner",
    "quit-app",
  ]);
});

test("createDesktopBeforeQuitHandler still quits when cleanup throws", async () => {
  let prevented = 0;
  let quitCalls = 0;

  const handleBeforeQuit = createDesktopBeforeQuitHandler({
    stopProjectRuns: async () => {
      throw new Error("stop failure");
    },
    quitApp: () => {
      quitCalls += 1;
    },
  });

  handleBeforeQuit({
    preventDefault() {
      prevented += 1;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(prevented, 1);
  assert.equal(quitCalls, 1);
});
