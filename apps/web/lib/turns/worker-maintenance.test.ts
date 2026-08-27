import assert from "node:assert/strict";
import test from "node:test";
import { runTurnWorkerMaintenance } from "./worker-maintenance";

test("receipt and receiving failures do not stop unrelated worker maintenance", async () => {
  const completed: string[] = [];
  const reported: string[] = [];

  await runTurnWorkerMaintenance({
    reconcileReceivingWebhooks: async () => {
      throw new Error("private receiving detail");
    },
    reportReceivingWebhookFailure: () => reported.push("receiving"),
    recoverEmailReceipts: async () => {
      throw new Error("private receipt detail");
    },
    reportEmailReceiptFailure: () => reported.push("receipt"),
    recoverSchedules: async () => {
      completed.push("schedules");
    },
    reconcileTurns: async () => {
      completed.push("turns");
    },
    drainMobilePush: async () => {
      completed.push("push");
    },
    reportMobilePushFailure: () => reported.push("push"),
  });

  assert.deepEqual(reported, ["receiving", "receipt"]);
  assert.deepEqual(completed, ["schedules", "turns", "push"]);
});
