import test from "node:test";
import assert from "node:assert/strict";

import { closeRuntimeResources } from "../../cli/runtime/KestrelChatRuntime.js";

test("closeRuntimeResources always attempts pool close when tool close fails", async () => {
  const calls: string[] = [];

  await assert.rejects(
    closeRuntimeResources(
      async () => {
        calls.push("tool");
        throw new Error("tool failed");
      },
      async () => {
        calls.push("pool");
      },
    ),
    /tool failed/,
  );

  assert.deepEqual(calls, ["tool", "pool"]);
});

test("closeRuntimeResources closes dev shell service before pool", async () => {
  const calls: string[] = [];

  await closeRuntimeResources(
    async () => {
      calls.push("tool");
    },
    async () => {
      calls.push("pool");
    },
    async () => {
      calls.push("dev-shell");
    },
  );

  assert.deepEqual(calls, ["tool", "dev-shell", "pool"]);
});

test("closeRuntimeResources throws AggregateError when both closes fail", async () => {
  await assert.rejects(
    async () => {
      await closeRuntimeResources(
        async () => {
          throw new Error("tool failed");
        },
        async () => {
          throw new Error("pool failed");
        },
      );
    },
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal((error as AggregateError).errors.length, 2);
      return true;
    },
  );
});
