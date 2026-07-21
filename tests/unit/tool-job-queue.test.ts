import assert from "node:assert/strict";

import { ToolJobQueue, ToolQueueOverflowError } from "../../src/engine/ToolJobQueue.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "ToolJobQueue schedules jobs fairly across runs", async () => {
  const queue = new ToolJobQueue();
  const order: string[] = [];

  const jobs = [
    queue.enqueue({
      runId: "run-a",
      maxConcurrentPerRun: 1,
      maxConcurrentGlobal: 1,
      maxQueuedPerRun: 10,
      retryCount: 0,
      execute: async () => {
        order.push("a1");
        await sleep(5);
        return "a1";
      },
    }),
    queue.enqueue({
      runId: "run-a",
      maxConcurrentPerRun: 1,
      maxConcurrentGlobal: 1,
      maxQueuedPerRun: 10,
      retryCount: 0,
      execute: async () => {
        order.push("a2");
        await sleep(5);
        return "a2";
      },
    }),
    queue.enqueue({
      runId: "run-b",
      maxConcurrentPerRun: 1,
      maxConcurrentGlobal: 1,
      maxQueuedPerRun: 10,
      retryCount: 0,
      execute: async () => {
        order.push("b1");
        await sleep(5);
        return "b1";
      },
    }),
    queue.enqueue({
      runId: "run-b",
      maxConcurrentPerRun: 1,
      maxConcurrentGlobal: 1,
      maxQueuedPerRun: 10,
      retryCount: 0,
      execute: async () => {
        order.push("b2");
        await sleep(5);
        return "b2";
      },
    }),
  ];

  await Promise.all(jobs);
  assert.deepEqual(order, ["a1", "b1", "a2", "b2"]);
});

contractTest("runtime.hermetic", "ToolJobQueue fails fast when per-run queue depth overflows", async () => {
  const queue = new ToolJobQueue();
  let releaseFirst: (() => void) | undefined;

  const first = queue.enqueue({
    runId: "run-overflow",
    maxConcurrentPerRun: 1,
    maxConcurrentGlobal: 1,
    maxQueuedPerRun: 1,
    retryCount: 0,
    execute: async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    },
  });

  const second = queue.enqueue({
    runId: "run-overflow",
    maxConcurrentPerRun: 1,
    maxConcurrentGlobal: 1,
    maxQueuedPerRun: 1,
    retryCount: 0,
    execute: async () => "second",
  });

  assert.throws(() => {
    queue.enqueue({
      runId: "run-overflow",
      maxConcurrentPerRun: 1,
      maxConcurrentGlobal: 1,
      maxQueuedPerRun: 1,
      retryCount: 0,
      execute: async () => "third",
    });
  }, ToolQueueOverflowError);

  releaseFirst?.();
  await Promise.all([first, second]);
});

contractTest("runtime.hermetic", "ToolJobQueue retries once for retryable errors", async () => {
  const queue = new ToolJobQueue();
  let attempts = 0;
  const retryEvents: Array<{ attempt: number; maxAttempts: number }> = [];

  const result = await queue.enqueue({
    runId: "run-retry",
    maxConcurrentPerRun: 1,
    maxConcurrentGlobal: 1,
    maxQueuedPerRun: 5,
    retryCount: 1,
    isRetryableError: () => true,
    onRetry: ({ attempt, maxAttempts }) => {
      retryEvents.push({ attempt, maxAttempts });
    },
    execute: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      }
      return "ok";
    },
  });

  assert.equal(result.result, "ok");
  assert.equal(result.attempts, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(retryEvents, [{ attempt: 2, maxAttempts: 2 }]);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
