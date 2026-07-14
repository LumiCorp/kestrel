import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ENVIRONMENT_RECONCILE_CRON,
  runScheduledEnvironmentReconciliation,
} from "./reconcile-schedule";

test("hosted Environment reconciliation runs every minute", () => {
  assert.equal(ENVIRONMENT_RECONCILE_CRON, "* * * * *");
});

test("Vercel invokes the authenticated Environment reconciliation route every minute", () => {
  const config = JSON.parse(
    fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../vercel.json"
      ),
      "utf8"
    )
  ) as { crons?: Array<{ path?: string; schedule?: string }> };
  assert.deepEqual(config.crons, [
    {
      path: "/api/cron/environments/reconcile",
      schedule: ENVIRONMENT_RECONCILE_CRON,
    },
  ]);
});

test("scheduled Environment reconciliation uses the shared advisory lock", async () => {
  const events: string[] = [];
  const result = await runScheduledEnvironmentReconciliation({
    reconcile: async () => {
      events.push("reconcile");
      return {
        operationCount: 1,
        environmentGatewayCount: 2,
        workspaceCount: 3,
      };
    },
    createLock: async () => ({
      async tryAcquire() {
        events.push("acquire");
        return true;
      },
      async release() {
        events.push("release");
      },
      async close() {
        events.push("close");
      },
    }),
  });

  assert.deepEqual(events, ["acquire", "reconcile", "release", "close"]);
  assert.equal(result.acquired, true);
  assert.deepEqual(result.result, {
    operationCount: 1,
    environmentGatewayCount: 2,
    workspaceCount: 3,
  });
});

test("scheduled Environment reconciliation skips overlap without running", async () => {
  let reconciled = false;
  const result = await runScheduledEnvironmentReconciliation({
    reconcile: async () => {
      reconciled = true;
      return {
        operationCount: 0,
        environmentGatewayCount: 0,
        workspaceCount: 0,
      };
    },
    createLock: async () => ({
      async tryAcquire() {
        return false;
      },
      async release() {
        throw new Error("Unacquired lock must not be released.");
      },
      async close() {},
    }),
  });

  assert.equal(reconciled, false);
  assert.deepEqual(result, { acquired: false, result: null });
});
