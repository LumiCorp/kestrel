import test from "node:test";
import assert from "node:assert/strict";

import {
  PostgresSessionStore,
  type SqlExecutor,
} from "../../src/store/PostgresSessionStore.js";

test("Postgres run reads normalize driver Date values at the store boundary", async () => {
  const executor: SqlExecutor = {
    async query<Row extends Record<string, unknown>>() {
      return {
        rows: [{
          run_id: "run-date-value",
          session_id: "session-date-value",
          event_type: "user.message",
          status: "COMPLETED",
          started_at: new Date("2026-08-13T12:00:00.000Z"),
          completed_at: new Date("2026-08-13T12:00:01.000Z"),
          error_json: null,
        }] as unknown as Row[],
        rowCount: 1,
      };
    },
  };
  const store = new PostgresSessionStore(executor);

  const runs = await store.listRuns({ limit: 1 });

  assert.deepEqual(runs, [{
    runId: "run-date-value",
    sessionId: "session-date-value",
    eventType: "user.message",
    status: "COMPLETED",
    startedAt: "2026-08-13T12:00:00.000Z",
    completedAt: "2026-08-13T12:00:01.000Z",
    error: undefined,
  }]);
});
