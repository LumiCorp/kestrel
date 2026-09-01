import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryOrchestrationStore } from "../../src/orchestration/InMemoryOrchestrationStore.js";
import { PostgresOrchestrationStore } from "../../src/orchestration/PostgresOrchestrationStore.js";
import type { SqlExecutor } from "../../src/store/PostgresSessionStore.js";

test("in-memory assembly appends serialize concurrent equal-time changes", async () => {
  const store = new InMemoryOrchestrationStore();
  const createdAt = "2026-08-28T12:00:00.000Z";
  const firstPromise = store.appendThreadAssemblyRecord({
    recordId: "record-first",
    threadId: "thread-concurrent",
    bundleId: "bundle-first",
    cause: "proposal",
    authority: "operator",
    createdAt,
  });
  const secondPromise = store.appendThreadAssemblyRecord({
    recordId: "record-second",
    threadId: "thread-concurrent",
    bundleId: "bundle-second",
    cause: "capability_loss",
    authority: "policy",
    createdAt,
  });

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const records = await store.listThreadAssemblyRecords("thread-concurrent");

  assert.equal(first.createdAt, createdAt);
  assert.equal(second.createdAt, "2026-08-28T12:00:00.001Z");
  assert.deepEqual(records.map((record) => record.recordId), [
    "record-second",
    "record-first",
  ]);
});

test("in-memory assembly append returns an identical retry and rejects a conflicting body", async () => {
  const store = new InMemoryOrchestrationStore();
  await store.appendThreadAssemblyRecord({
    recordId: "record-idempotent-predecessor",
    threadId: "thread-idempotent",
    bundleId: "bundle-predecessor",
    cause: "thread_start",
    authority: "profile",
    createdAt: "2026-08-28T12:00:00.000Z",
  });
  const record = {
    recordId: "record-idempotent",
    threadId: "thread-idempotent",
    bundleId: "bundle-idempotent",
    cause: "proposal" as const,
    authority: "operator" as const,
    metadata: { proposalId: "proposal-idempotent" },
    createdAt: "2026-08-28T12:00:00.000Z",
  };

  const persisted = await store.appendThreadAssemblyRecord(record);
  const retried = await store.appendThreadAssemblyRecord({ ...record });

  assert.deepEqual(retried, persisted);
  assert.equal(persisted.createdAt, "2026-08-28T12:00:00.001Z");
  assert.equal((await store.listThreadAssemblyRecords(record.threadId)).length, 2);
  await assert.rejects(
    () => store.appendThreadAssemblyRecord({
      ...record,
      bundleId: "bundle-conflict",
    }),
    /already exists with a different body/u,
  );
  assert.equal((await store.listThreadAssemblyRecords(record.threadId)).length, 2);
});

test("Postgres assembly append locks the thread before deriving its durable order", async () => {
  const queries: string[] = [];
  let transactionCalls = 0;
  const db: SqlExecutor = {
    async query() {
      throw new Error("assembly append must use the transaction executor");
    },
    async transaction(operation) {
      transactionCalls += 1;
      const transaction: SqlExecutor = {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values: unknown[] = [],
        ) {
          queries.push(text);
          if (/FROM orchestration_threads/u.test(text)) {
            return {
              rows: [{ thread_id: "thread-order" }] as unknown as Row[],
              rowCount: 1,
            };
          }
          if (/WHERE record_id = \$1/u.test(text)) {
            return { rows: [] as Row[], rowCount: 0 };
          }
          if (/ORDER BY created_at DESC/u.test(text)) {
            return {
              rows: [{
                record_id: "record-previous",
                thread_id: "thread-order",
                bundle_id: "bundle-previous",
                cause: "thread_start",
                authority: "profile",
                metadata_json: null,
                created_at: "2099-01-01T00:00:00.000Z",
              }] as unknown as Row[],
              rowCount: 1,
            };
          }
          if (/INSERT INTO orchestration_thread_assembly_records/u.test(text)) {
            return {
              rows: [{
                record_id: values[0],
                thread_id: values[1],
                bundle_id: values[2],
                cause: values[3],
                authority: values[4],
                metadata_json: null,
                created_at: values[6],
              }] as unknown as Row[],
              rowCount: 1,
            };
          }
          throw new Error(`Unexpected query: ${text}`);
        },
      };
      return operation(transaction);
    },
  };

  const persisted = await new PostgresOrchestrationStore(db)
    .appendThreadAssemblyRecord({
      recordId: "record-next",
      threadId: "thread-order",
      bundleId: "bundle-next",
      cause: "proposal",
      authority: "operator",
      createdAt: "2026-08-28T12:00:00.000Z",
    });

  assert.equal(transactionCalls, 1);
  assert.match(queries[0] ?? "", /FROM orchestration_threads[\s\S]*FOR UPDATE/u);
  assert.equal(persisted.createdAt, "2099-01-01T00:00:00.001Z");
});

test("Postgres assembly append returns an identical retry and rejects a conflicting body", async () => {
  const persistedRow = {
    record_id: "record-idempotent",
    thread_id: "thread-idempotent",
    bundle_id: "bundle-idempotent",
    cause: "proposal",
    authority: "operator",
    metadata_json: { proposalId: "proposal-idempotent" },
    created_at: "2026-08-28T12:00:00.001Z",
  };
  let insertCalls = 0;
  const db: SqlExecutor = {
    async query() {
      throw new Error("assembly append must use the transaction executor");
    },
    async transaction(operation) {
      const transaction: SqlExecutor = {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
        ) {
          if (/FROM orchestration_threads/u.test(text)) {
            return {
              rows: [{ thread_id: "thread-idempotent" }] as unknown as Row[],
              rowCount: 1,
            };
          }
          if (/WHERE record_id = \$1/u.test(text)) {
            return {
              rows: [persistedRow] as unknown as Row[],
              rowCount: 1,
            };
          }
          if (/INSERT INTO orchestration_thread_assembly_records/u.test(text)) {
            insertCalls += 1;
          }
          throw new Error(`Unexpected query: ${text}`);
        },
      };
      return operation(transaction);
    },
  };
  const store = new PostgresOrchestrationStore(db);
  const record = {
    recordId: "record-idempotent",
    threadId: "thread-idempotent",
    bundleId: "bundle-idempotent",
    cause: "proposal" as const,
    authority: "operator" as const,
    metadata: { proposalId: "proposal-idempotent" },
    createdAt: "2026-08-28T12:00:00.000Z",
  };

  assert.deepEqual(await store.appendThreadAssemblyRecord(record), {
    recordId: record.recordId,
    threadId: record.threadId,
    bundleId: record.bundleId,
    cause: record.cause,
    authority: record.authority,
    metadata: record.metadata,
    createdAt: "2026-08-28T12:00:00.001Z",
  });
  await assert.rejects(
    () => store.appendThreadAssemblyRecord({
      ...record,
      authority: "policy",
    }),
    /already exists with a different body/u,
  );
  assert.equal(insertCalls, 0);
});

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
