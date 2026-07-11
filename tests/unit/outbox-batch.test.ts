import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent } from "../../src/kestrel/contracts/events.js";
import type { OutboxEventRecord } from "../../src/kestrel/contracts/store.js";

import { InlineOutbox } from "../../src/events/Outbox.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

class BatchTrackingStore extends InMemorySessionStore {
  deliveredBatchCalls = 0;
  failedBatchCalls = 0;

  override async markOutboxDelivered(_id: number): Promise<void> {
    throw new Error("single delivered path should not be used");
  }

  override async markOutboxAttemptFailed(_id: number, _error: string): Promise<void> {
    throw new Error("single failed path should not be used");
  }

  override async markOutboxDeliveredBatch(ids: number[]): Promise<void> {
    this.deliveredBatchCalls += 1;
    await super.markOutboxDeliveredBatch(ids);
  }

  override async markOutboxAttemptFailedBatch(entries: Array<{ id: number; error: string }>): Promise<void> {
    this.failedBatchCalls += 1;
    await super.markOutboxAttemptFailedBatch(entries);
  }
}

test("InlineOutbox batches delivery status updates", async () => {
  const store = new BatchTrackingStore();

  await store.ensureSession("session-1", "react.route");

  const event: RuntimeEvent = {
    id: "evt-1",
    type: "INGRESS",
    sessionId: "session-1",
    payload: {},
  };

  await store.startRun("run-1", event);
  await store.commitStep({
    runId: "run-1",
    event,
    sessionId: "session-1",
    expectedVersion: 0,
    nextStepAgent: "react.chat",
    statePatch: {},
    effects: [],
    emitEvents: [
      { type: "test.ok", payload: { idx: 1 } },
      { type: "test.fail", payload: { idx: 2 } },
    ],
    stepIndex: 0,
  });

  const dispatched: string[] = [];
  const outbox = new InlineOutbox(store, {
    async dispatch(item: OutboxEventRecord): Promise<void> {
      dispatched.push(item.eventType);
      if (item.eventType === "test.fail") {
        throw new Error("boom");
      }
    },
  });

  await outbox.dispatchInline("run-1");

  assert.deepEqual(dispatched, ["test.ok", "test.fail"]);
  assert.equal(store.deliveredBatchCalls, 1);
  assert.equal(store.failedBatchCalls, 1);

  const pending = await store.listUndeliveredOutbox(10, "run-1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.eventType, "test.fail");
  assert.equal(pending[0]?.status, "FAILED");
  assert.equal(pending[0]?.attemptCount, 1);
});
