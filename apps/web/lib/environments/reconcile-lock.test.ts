import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  type EnvironmentReconcileLock,
  withEnvironmentOperationLock,
  withEnvironmentReconcileLock,
} from "./reconcile-lock";

test("production Environment locks are transaction scoped for pooled Postgres", () => {
  const source = readFileSync(
    new URL("./reconcile-lock.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /pg_try_advisory_xact_lock/u);
  assert.doesNotMatch(source, /pg_advisory_unlock/u);
});

test("Environment reconciliation closes an unacquired lock without running", async () => {
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

test("Environment operation locks use a stable operation-specific key", async () => {
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
      operationId: " operation-123 ",
      createLock,
      run: async () => "completed",
    }),
    { acquired: true, result: "completed" }
  );
  assert.deepEqual(lockKeys, [
    "kestrel:hosted-environments:operation:operation-123",
  ]);
});

test("Environment operation locks reject an empty operation ID", async () => {
  await assert.rejects(
    withEnvironmentOperationLock({
      operationId: " ",
      run: async () => "completed",
    }),
    /operation ID is required/u
  );
});

test("Environment reconciliation releases its lock after success or failure", async () => {
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
