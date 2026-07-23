import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  type EnvironmentReconcileLock,
  withEnvironmentOperationLock,
  withEnvironmentReconcileLock,
} from "./reconcile-lock";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "production Environment locks are transaction scoped for pooled Postgres", () => {
  const source = readFileSync(
    new URL("./reconcile-lock.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /pg_try_advisory_xact_lock/u);
  assert.doesNotMatch(source, /pg_advisory_unlock/u);
});

contractTest("web.hermetic", "Environment reconciliation closes an unacquired lock without running", async () => {
  const calls: string[] = [];
  const lock: EnvironmentReconcileLock = {
    async tryAcquire() {
      calls.push("try");
      return false;
    },
    async release() {
      calls.push("release");
    },
    async close() {
      calls.push("close");
    },
  };
  const result = await withEnvironmentReconcileLock({
    createLock: async () => lock,
    run: async () => {
      calls.push("run");
      return "completed";
    },
  });
  assert.deepEqual(result, { acquired: false, result: null });
  assert.deepEqual(calls, ["try", "close"]);
});

contractTest("web.hermetic", "Environment operation locks use a stable Environment-specific key", async () => {
  const lockKeys: string[] = [];
  const createLock = async (
    lockKey: string
  ): Promise<EnvironmentReconcileLock> => {
    lockKeys.push(lockKey);
    return {
      async tryAcquire() {
        return true;
      },
      async release() {},
      async close() {},
    };
  };
  assert.deepEqual(
    await withEnvironmentOperationLock({
      environmentId: " environment-123 ",
      createLock,
      run: async () => "completed",
    }),
    { acquired: true, result: "completed" }
  );
  assert.deepEqual(lockKeys, [
    "kestrel:hosted-environments:environment:environment-123",
  ]);
});

contractTest("web.hermetic", "Environment operation locks reject an empty Environment ID", async () => {
  await assert.rejects(
    withEnvironmentOperationLock({
      environmentId: " ",
      run: async () => "completed",
    }),
    /Environment ID is required/u
  );
});

contractTest("web.hermetic", "Environment reconciliation releases its lock after success or failure", async () => {
  for (const shouldFail of [false, true]) {
    const calls: string[] = [];
    const lock: EnvironmentReconcileLock = {
      async tryAcquire() {
        calls.push("try");
        return true;
      },
      async release() {
        calls.push("release");
      },
      async close() {
        calls.push("close");
      },
    };
    const work = withEnvironmentReconcileLock({
      createLock: async () => lock,
      run: async () => {
        calls.push("run");
        if (shouldFail) throw new Error("reconcile failed");
        return "completed";
      },
    });
    if (shouldFail) await assert.rejects(work, /reconcile failed/u);
    else assert.deepEqual(await work, { acquired: true, result: "completed" });
    assert.deepEqual(calls, ["try", "run", "release", "close"]);
  }
});
