import test from "node:test";
import assert from "node:assert/strict";

import { PostgresOrchestrationStore } from "../../src/orchestration/PostgresOrchestrationStore.js";
import type { SqlExecutor } from "../../src/store/PostgresSessionStore.js";

test("Postgres assembly history applies the durable equal-timestamp record-id order", async () => {
  const queries: string[] = [];
  const createdAt = "2026-08-28T12:00:00.000Z";
  const db = {
    async query(text: string) {
      queries.push(text);
      return {
        rows: [
          {
            record_id: "record-a",
            thread_id: "thread-order",
            bundle_id: "bundle-a",
            cause: "thread_start",
            authority: "profile",
            metadata_json: null,
            created_at: createdAt,
          },
          {
            record_id: "record-z",
            thread_id: "thread-order",
            bundle_id: "bundle-z",
            cause: "thread_start",
            authority: "profile",
            metadata_json: null,
            created_at: createdAt,
          },
        ],
      };
    },
  } as unknown as SqlExecutor;

  const records = await new PostgresOrchestrationStore(db)
    .listThreadAssemblyRecords("thread-order");

  assert.match(queries[0] ?? "", /ORDER BY created_at DESC, record_id DESC/u);
  assert.deepEqual(records.map((record) => record.recordId), [
    "record-z",
    "record-a",
  ]);
});
