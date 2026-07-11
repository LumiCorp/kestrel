import test from "node:test";
import assert from "node:assert/strict";

import {
  Kestrel,
  RunReplayService,
  AllowlistedToolGateway,
  RetryingModelGateway,
  type ProgressUpdateV1,
} from "../../src/index.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

test("Kestrel emits structured progress updates and skips heartbeat persistence", async () => {
  const store = new InMemorySessionStore();
  const updates: ProgressUpdateV1[] = [];

  const previousHeartbeat = process.env.KCHAT_PROGRESS_HEARTBEAT_MS;
  process.env.KCHAT_PROGRESS_HEARTBEAT_MS = "5";

  try {
    const kestrel = new Kestrel({
      store,
      toolGateway: new AllowlistedToolGateway({
        lookup: async () => {
          await sleep(25);
          return { ok: true };
        },
      }),
      modelGateway: new RetryingModelGateway(async <T>() => {
        await sleep(25);
        return { ok: true } as T;
      }),
      progressListener: (update) => {
        updates.push(update);
      },
    });

    kestrel.registerStep("progressStep", async (_ctx, io) => {
      await io.useModel({ model: "mock", input: "hello" });
      await io.useTool!("lookup", {});
      return {
        status: "COMPLETED",
        statePatch: { done: true },
      };
    });

    const output = await kestrel.run({
      id: "evt-progress-1",
      type: "user.message",
      sessionId: "session-progress-1",
      payload: {
        message: "run with progress",
      },
      stepAgent: "progressStep",
    });

    assert.equal(output.status, "COMPLETED");
    assert.equal(updates.some((update) => update.code === "RUN_STARTED"), true);
    assert.equal(updates.some((update) => update.code === "MODEL_CALL_STARTED"), true);
    assert.equal(updates.some((update) => update.code === "MODEL_CALL_DONE"), true);
    assert.equal(
      updates.some(
        (update) => update.code === "MODEL_CALL_STARTED" && update.message.includes("(mock)"),
      ),
      true,
    );
    assert.equal(
      updates.some(
        (update) =>
          update.code === "MODEL_CALL_DONE" && update.message.includes("from mock"),
      ),
      true,
    );
    assert.equal(updates.some((update) => update.code === "TOOL_CALL_STARTED"), true);
    assert.equal(updates.some((update) => update.code === "TOOL_CALL_DONE"), true);
    assert.equal(updates.some((update) => update.kind === "heartbeat"), true);

    const replay = await new RunReplayService(store).replay({ runId: output.runId });
    assert.equal(replay.events.some((event) => event.type === "progress.stage"), true);
    assert.equal(replay.events.some((event) => event.type === "progress.tool"), true);
    assert.equal(replay.events.some((event) => event.type === "progress.heartbeat"), false);
  } finally {
    if (previousHeartbeat === undefined) {
      delete process.env.KCHAT_PROGRESS_HEARTBEAT_MS;
    } else {
      process.env.KCHAT_PROGRESS_HEARTBEAT_MS = previousHeartbeat;
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
