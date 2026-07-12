import assert from "node:assert/strict";
import test from "node:test";
import { cleanupProjectBlobKeys } from "./blob-cleanup";

test("Project blob cleanup attempts every unique key without rejecting", async () => {
  const attempted: string[] = [];
  const result = await cleanupProjectBlobKeys(
    ["one", "two", "one", "three"],
    async (storageKey) => {
      attempted.push(storageKey);
      if (storageKey === "two") {
        throw new Error("storage unavailable");
      }
    }
  );

  assert.deepEqual(attempted, ["one", "two", "three"]);
  assert.deepEqual(result, { attemptedCount: 3, failedCount: 1 });
});
