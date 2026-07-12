import test from "node:test";
import assert from "node:assert/strict";

import {
  OptimisticConcurrencyError,
  PostgresSessionStore,
  type SqlExecutor,
} from "../../src/store/PostgresSessionStore.js";
import { ScriptedSqlExecutor } from "../helpers/ScriptedSqlExecutor.js";
import { createEmptyProjectSnapshot } from "../../src/project/state.js";

test("listRunSummaries projects bounded event aggregates in one query", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /WITH selected_runs AS[\s\S]*SELECT COUNT\(\*\)::integer[\s\S]*metadata_json ->> 'threadId'/,
      rows: [
        {
          run_id: "run-summary",
          session_id: "session-summary",
          event_type: "user.message",
          status: "WAITING",
          started_at: "2026-07-11T12:00:00.000Z",
          completed_at: null,
          error_json: null,
          event_count: "37",
          thread_id: "thread-summary",
        },
      ],
    },
  ]);
  const store = new PostgresSessionStore(sql);

  const summaries = await store.listRunSummaries({
    sessionId: "session-summary",
    status: "WAITING",
    limit: 51,
  });

  assert.deepEqual(sql.queries[0]?.values, ["session-summary", "WAITING", 51]);
  assert.deepEqual(summaries, [
    {
      run: {
        runId: "run-summary",
        sessionId: "session-summary",
        eventType: "user.message",
        status: "WAITING",
        startedAt: "2026-07-11T12:00:00.000Z",
        completedAt: undefined,
        error: undefined,
      },
      eventCount: 37,
      threadId: "thread-summary",
    },
  ]);
  assert.equal(sql.queries.length, 1);
  sql.assertExhausted();
});

test("commitStep wraps writes in transaction and commits", async () => {
  const sql = new ScriptedSqlExecutor([
    { match: /^BEGIN/ },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          session_id: "s1",
          current_version: 1,
          current_step_agent: "stepA",
          updated_at: new Date().toISOString(),
          current_state_json: { foo: "bar" },
        },
      ],
      rowCount: 1,
    },
    { match: /^UPDATE sessions/, rowCount: 1 },
    { match: /^INSERT INTO session_versions/, rowCount: 1 },
    { match: /^INSERT INTO effects/, rowCount: 1 },
    { match: /^INSERT INTO runtime_events_outbox/, rows: [{ id: 41 }], rowCount: 1 },
    { match: /^INSERT INTO run_events/, rowCount: 1 },
    { match: /^COMMIT/ },
  ]);

  const store = new PostgresSessionStore(sql);

  const result = await store.commitStep({
    runId: "run-1",
    event: {
      id: "e1",
      type: "MESSAGE",
      sessionId: "s1",
      payload: {},
    },
    sessionId: "s1",
    expectedVersion: 1,
    nextStepAgent: "stepB",
    statePatch: { x: 1 },
    effects: [
      {
        type: "test_noop",
        payload: {},
        idempotencyKey: "k1",
        failurePolicy: "STOP",
      },
    ],
    emitEvents: [
      {
        type: "runtime.event",
        payload: { y: 2 },
      },
    ],
    stepIndex: 0,
  });

  assert.equal(result.session.version, 2);
  assert.deepEqual(result.persistedOutboxEventIds, [41]);

  const began = sql.queries.some((query) => query.text.startsWith("BEGIN"));
  const committed = sql.queries.some((query) => query.text.startsWith("COMMIT"));
  const rolledBack = sql.queries.some((query) => query.text.startsWith("ROLLBACK"));

  assert.equal(began, true);
  assert.equal(committed, true);
  assert.equal(rolledBack, false);
  sql.assertExhausted();
});

test("updateSessionProjectSnapshot writes product state without updating runtime session version", async () => {
  const sql = new ScriptedSqlExecutor([
    { match: /^BEGIN/ },
    {
      match: /^SELECT session_id, current_version, current_step_agent, updated_at, current_state_json, legacy_readonly\s+FROM sessions\s+WHERE session_id = \$1\s+FOR UPDATE/,
      rows: [
        {
          session_id: "session-product",
          current_version: 7,
          current_step_agent: "agent.loop",
          updated_at: new Date().toISOString(),
          current_state_json: {
            product: {
              taskGraph: { version: 1, rootTaskIds: ["task-one"], tasks: {} },
              workspaceCheckpointState: { version: 1, checkpoints: [], restores: [], cleanups: [] },
            },
          },
          legacy_readonly: false,
        },
      ],
      rowCount: 1,
    },
    {
      match: /^SELECT session_id, version, project_snapshot_json, task_graph_json, workspace_checkpoint_state_json, created_at, updated_at\s+FROM session_product_state\s+WHERE session_id = \$1\s+FOR UPDATE/,
      rows: [],
      rowCount: 0,
    },
    {
      match: /^INSERT INTO session_product_state/,
      rows: [
        {
          session_id: "session-product",
          version: 1,
          project_snapshot_json: {
            ...createEmptyProjectSnapshot(),
            setup: {
              ...createEmptyProjectSnapshot().setup,
              repoLabel: "product-state",
            },
          },
          task_graph_json: { version: 1, rootTaskIds: ["task-one"], tasks: {} },
          workspace_checkpoint_state_json: { version: 1, checkpoints: [], restores: [], cleanups: [] },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      rowCount: 1,
    },
    { match: /^COMMIT/ },
  ]);

  const store = new PostgresSessionStore(sql);
  const productState = await store.updateSessionProjectSnapshot({
    sessionId: "session-product",
    graphVersion: 1,
    reason: "project_board_action",
    apply: (snapshot) => ({
      ...snapshot,
      setup: {
        ...snapshot.setup,
        repoLabel: "product-state",
      },
    }),
  });

  assert.equal(productState.version, 1);
  assert.equal(productState.projectSnapshot.setup.repoLabel, "product-state");
  assert.deepEqual(productState.taskGraph, { version: 1, rootTaskIds: ["task-one"], tasks: {} });
  assert.equal(sql.queries.some((query) => /^UPDATE sessions/u.test(query.text)), false);
  sql.assertExhausted();
});

test("getSessionProductState preserves stored project graph version", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /^SELECT session_id, version, project_snapshot_json, task_graph_json, workspace_checkpoint_state_json, created_at, updated_at\s+FROM session_product_state\s+WHERE session_id = \$1/,
      rows: [
        {
          session_id: "session-product-graph",
          version: 3,
          project_snapshot_json: {
            ...createEmptyProjectSnapshot(),
            graphVersion: 42,
            setup: {
              ...createEmptyProjectSnapshot().setup,
              repoLabel: "graph-version",
            },
          },
          task_graph_json: {},
          workspace_checkpoint_state_json: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      rowCount: 1,
    },
  ]);

  const store = new PostgresSessionStore(sql);
  const productState = await store.getSessionProductState("session-product-graph");

  assert.equal(productState?.projectSnapshot.graphVersion, 42);
  assert.equal(productState?.projectSnapshot.setup.repoLabel, "graph-version");
  sql.assertExhausted();
});

test("commitStep rolls back on optimistic concurrency conflict", async () => {
  const sql = new ScriptedSqlExecutor([
    { match: /^BEGIN/ },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          session_id: "s1",
          current_version: 2,
          current_step_agent: "stepA",
          updated_at: new Date().toISOString(),
          current_state_json: {},
        },
      ],
      rowCount: 1,
    },
    { match: /^ROLLBACK/ },
  ]);

  const store = new PostgresSessionStore(sql);

  await assert.rejects(
    () =>
      store.commitStep({
        runId: "run-1",
        event: {
          id: "e1",
          type: "MESSAGE",
          sessionId: "s1",
          payload: {},
        },
        sessionId: "s1",
        expectedVersion: 1,
        statePatch: {},
        effects: [],
        emitEvents: [],
        stepIndex: 0,
      }),
    OptimisticConcurrencyError,
  );

  const rolledBack = sql.queries.some((query) => query.text.startsWith("ROLLBACK"));
  assert.equal(rolledBack, true);
  sql.assertExhausted();
});

test("commitStep uses SqlExecutor transaction wrapper when available", async () => {
  const queries: string[] = [];
  let transactionUsed = false;

  const executor: SqlExecutor = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      _values?: unknown[],
    ): Promise<{ rows: Row[]; rowCount: number }> {
      queries.push(text);

      if (text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              session_id: "s1",
              current_version: 1,
              current_step_agent: "stepA",
              updated_at: new Date().toISOString(),
              current_state_json: {},
            } as unknown as Row,
          ],
          rowCount: 1,
        };
      }

      if (text.startsWith("UPDATE sessions")) {
        return { rows: [], rowCount: 1 };
      }

      if (text.startsWith("INSERT INTO runtime_events_outbox")) {
        return { rows: [{ id: 5 } as unknown as Row], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    },
    async transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      transactionUsed = true;
      return operation(this);
    },
  };

  const store = new PostgresSessionStore(executor);

  const result = await store.commitStep({
    runId: "run-2",
    event: {
      id: "e2",
      type: "MESSAGE",
      sessionId: "s1",
      payload: {},
    },
    sessionId: "s1",
    expectedVersion: 1,
    nextStepAgent: "stepB",
    statePatch: { ok: true },
    effects: [],
    emitEvents: [{ type: "runtime.event", payload: { ok: true } }],
    stepIndex: 0,
  });

  assert.equal(transactionUsed, true);
  assert.equal(result.session.version, 2);
  assert.equal(queries.some((query) => query.startsWith("BEGIN")), false);
});

test("startRun reconciles a stale terminal lease before creating a new run", async () => {
  const sql = new ScriptedSqlExecutor([
    { match: /^BEGIN/ },
    {
      match: /^SELECT session_id, active_run_id, current_state_json\s+FROM sessions\s+WHERE session_id = \$1\s+FOR UPDATE/,
      rows: [
        {
          session_id: "session-stale",
          active_run_id: "run-stale",
          current_state_json: {
            agent: {
              terminal: {
                status: "COMPLETED",
                finalStepAgent: "agent.exec.finalize",
              },
            },
          },
        },
      ],
      rowCount: 1,
    },
    {
      match: /^SELECT run_id, session_id, status, completed_at, error_json\s+FROM runs\s+WHERE run_id = \$1\s+FOR UPDATE/,
      rows: [
        {
          run_id: "run-stale",
          session_id: "session-stale",
          status: "RUNNING",
          completed_at: null,
          error_json: null,
        },
      ],
      rowCount: 1,
    },
    { match: /^UPDATE runs\s+SET status = \$2,/i, rowCount: 1 },
    { match: /^UPDATE sessions\s+SET active_run_id = NULL,/i, rowCount: 1 },
    { match: /^UPDATE sessions\s+SET active_run_id = \$2,/i, rows: [{ session_id: "session-stale" }], rowCount: 1 },
    { match: /^INSERT INTO runs \(run_id, session_id, event_type, status\)/, rowCount: 1 },
    { match: /^COMMIT/ },
  ]);

  const store = new PostgresSessionStore(sql);

  await store.startRun("run-new", {
    id: "evt-start",
    type: "user.message",
    sessionId: "session-stale",
    payload: {},
  });

  const recoveredRunUpdate = sql.queries.find((query) => query.text.startsWith("UPDATE runs"));
  assert.deepEqual(recoveredRunUpdate?.values?.slice(0, 2), ["run-stale", "COMPLETED"]);

  const releaseUpdate = sql.queries.find(
    (query) =>
      query.text.includes("SET active_run_id = NULL") &&
      query.values?.[0] === "session-stale" &&
      query.values?.[1] === "run-stale",
  );
  assert.equal(releaseUpdate !== undefined, true);

  const leaseUpdate = sql.queries.find(
    (query) =>
      query.text.includes("SET active_run_id = $2") && query.values?.[1] === "run-new",
  );
  assert.equal(leaseUpdate !== undefined, true);
  sql.assertExhausted();
});

test("startRun releases a missing active run row before creating a new run", async () => {
  const sql = new ScriptedSqlExecutor([
    { match: /^BEGIN/ },
    {
      match: /^SELECT session_id, active_run_id, current_state_json\s+FROM sessions\s+WHERE session_id = \$1\s+FOR UPDATE/,
      rows: [
        {
          session_id: "session-missing-run",
          active_run_id: "run-missing",
          current_state_json: {
            agent: {
              phase: "thinking",
            },
          },
        },
      ],
      rowCount: 1,
    },
    {
      match: /^SELECT run_id, session_id, status, completed_at, error_json\s+FROM runs\s+WHERE run_id = \$1\s+FOR UPDATE/,
      rows: [],
      rowCount: 0,
    },
    { match: /^UPDATE sessions\s+SET active_run_id = NULL,/i, rowCount: 1 },
    {
      match: /^UPDATE sessions\s+SET active_run_id = \$2,/i,
      rows: [{ session_id: "session-missing-run" }],
      rowCount: 1,
    },
    { match: /^INSERT INTO runs \(run_id, session_id, event_type, status\)/, rowCount: 1 },
    { match: /^COMMIT/ },
  ]);

  const store = new PostgresSessionStore(sql);

  await store.startRun("run-new", {
    id: "evt-start",
    type: "user.message",
    sessionId: "session-missing-run",
    payload: {},
  });

  const releaseUpdate = sql.queries.find(
    (query) =>
      query.text.includes("SET active_run_id = NULL") &&
      query.values?.[0] === "session-missing-run" &&
      query.values?.[1] === "run-missing",
  );
  assert.equal(releaseUpdate !== undefined, true);

  const leaseUpdate = sql.queries.find(
    (query) =>
      query.text.includes("SET active_run_id = $2") && query.values?.[1] === "run-new",
  );
  assert.equal(leaseUpdate !== undefined, true);
  assert.equal(sql.queries.some((query) => query.text.startsWith("UPDATE runs")), false);
  sql.assertExhausted();
});

test("cancelActiveRun fails the persisted active run and releases the session lease", async () => {
  const sql = new ScriptedSqlExecutor([
    { match: /^BEGIN/ },
    {
      match: /^SELECT session_id, active_run_id, current_state_json\s+FROM sessions\s+WHERE session_id = \$1\s+FOR UPDATE/,
      rows: [
        {
          session_id: "session-cancel-stale",
          active_run_id: "run-cancel-stale",
          current_state_json: {
            agent: {
              phase: "thinking",
            },
          },
        },
      ],
      rowCount: 1,
    },
    {
      match: /^SELECT run_id, session_id, status, completed_at, error_json\s+FROM runs\s+WHERE run_id = \$1\s+FOR UPDATE/,
      rows: [
        {
          run_id: "run-cancel-stale",
          session_id: "session-cancel-stale",
          status: "RUNNING",
          completed_at: null,
          error_json: null,
        },
      ],
      rowCount: 1,
    },
    { match: /^UPDATE runs\s+SET status = 'FAILED',/i, rowCount: 1 },
    { match: /^UPDATE sessions\s+SET active_run_id = NULL,/i, rowCount: 1 },
    { match: /^COMMIT/ },
  ]);

  const store = new PostgresSessionStore(sql);

  const result = await store.cancelActiveRun("session-cancel-stale", {
    code: "RUN_CANCELLED",
    message: "Run cancelled.",
    details: {
      source: "operator",
    },
  });

  assert.equal(result.runId, "run-cancel-stale");
  const failedRunUpdate = sql.queries.find((query) => query.text.startsWith("UPDATE runs"));
  assert.equal(failedRunUpdate?.values?.[0], "run-cancel-stale");
  assert.equal((failedRunUpdate?.values?.[1] as Record<string, unknown> | undefined)?.code, undefined);
  assert.deepEqual(JSON.parse(failedRunUpdate?.values?.[1] as string), {
    code: "RUN_CANCELLED",
    message: "Run cancelled.",
    details: {
      source: "operator",
    },
  });
  const releaseUpdate = sql.queries.find(
    (query) =>
      query.text.includes("SET active_run_id = NULL") &&
      query.values?.[0] === "session-cancel-stale" &&
      query.values?.[1] === "run-cancel-stale",
  );
  assert.equal(releaseUpdate !== undefined, true);
  sql.assertExhausted();
});

test("commitStep sanitizes malformed unicode before JSONB-bound writes", async () => {
  const captured: Array<{ text: string; values: unknown[] | undefined }> = [];
  const executor: SqlExecutor = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: Row[]; rowCount: number }> {
      captured.push({ text, values });

      if (text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              session_id: "s-json",
              current_version: 1,
              current_step_agent: "stepA",
              updated_at: new Date().toISOString(),
              current_state_json: {},
            } as unknown as Row,
          ],
          rowCount: 1,
        };
      }

      if (text.startsWith("UPDATE sessions")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO effects")) {
        return {
          rows: [
            {
              run_id: "run-json",
              session_id: "s-json",
              step_index: 0,
              effect_type: "test_noop",
              payload_json: {},
              idempotency_key: "fx-json",
              failure_policy: "STOP",
              status: "PENDING",
              created_at: new Date().toISOString(),
            } as unknown as Row,
          ],
          rowCount: 1,
        };
      }
      if (text.startsWith("INSERT INTO runtime_events_outbox")) {
        return { rows: [{ id: 17 } as unknown as Row], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO artifacts")) {
        return { rows: [{ artifact_id: "artifact-1", created_at: new Date().toISOString() } as unknown as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    async transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return operation(this);
    },
  };

  const store = new PostgresSessionStore(executor);
  await store.commitStep({
    runId: "run-json",
    event: {
      id: "evt-json",
      type: "MESSAGE",
      sessionId: "s-json",
      payload: {},
    },
    sessionId: "s-json",
    expectedVersion: 1,
    nextStepAgent: "stepB",
    statePatch: {
      note: "a\ud800b",
    },
    effects: [
      {
        type: "test_noop",
        payload: { effect: "c\ud800d" },
        idempotencyKey: "fx-json",
        failurePolicy: "STOP",
      },
    ],
    emitEvents: [
      {
        type: "runtime.event",
        payload: { outbox: "e\ud800f" },
      },
    ],
    runLogs: [
      {
        runId: "run-json",
        sessionId: "s-json",
        level: "INFO",
        eventName: "log.json",
        metadata: { log: "g\ud800h" },
      },
    ],
    runEvents: [
      {
        runId: "run-json",
        sessionId: "s-json",
        timestamp: new Date().toISOString(),
        level: "INFO",
        type: "quality.computed",
        metadata: { event: "i\ud800j" },
      },
    ],
    artifacts: [
      {
        id: "artifact-1",
        type: "tool-output",
        payload: { artifact: "k\ud800l" },
      },
    ],
    stepIndex: 0,
  });

  const serializedValues = captured
    .flatMap((entry) => entry.values ?? [])
    .filter((value): value is string => typeof value === "string" && value.startsWith("{"));

  assert.equal(serializedValues.some((value) => value.includes("\ud800")), false);
  assert.equal(
    serializedValues.some((value) => JSON.stringify(JSON.parse(value)).includes("\uFFFD")),
    true,
  );
});

test("commitStep batches step-frame writes and persistence inserts", async () => {
  const queryCounts: Record<string, number> = {};
  const count = (key: string): void => {
    queryCounts[key] = (queryCounts[key] ?? 0) + 1;
  };

  const executor: SqlExecutor = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      _values?: unknown[],
    ): Promise<{ rows: Row[]; rowCount: number }> {
      if (text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              session_id: "s-batch",
              current_version: 1,
              current_step_agent: "stepA",
              updated_at: new Date().toISOString(),
              current_state_json: { prior: true },
            } as unknown as Row,
          ],
          rowCount: 1,
        };
      }

      if (text.startsWith("UPDATE sessions")) {
        return { rows: [], rowCount: 1 };
      }

      if (text.startsWith("INSERT INTO session_versions")) {
        return { rows: [], rowCount: 1 };
      }

      if (text.startsWith("INSERT INTO effects")) {
        count("effects");
        return {
          rows: [
            {
              run_id: "run-batch",
              session_id: "s-batch",
              step_index: 0,
              effect_type: "test_noop",
              payload_json: { op: 1 },
              idempotency_key: "fx-1",
              failure_policy: "STOP",
              status: "PENDING",
              created_at: "2026-03-05T00:00:00.000Z",
            } as unknown as Row,
            {
              run_id: "run-batch",
              session_id: "s-batch",
              step_index: 0,
              effect_type: "test_noop",
              payload_json: { op: 2 },
              idempotency_key: "fx-2",
              failure_policy: "STOP",
              status: "PENDING",
              created_at: "2026-03-05T00:00:00.000Z",
            } as unknown as Row,
          ],
          rowCount: 2,
        };
      }

      if (text.startsWith("INSERT INTO runtime_events_outbox")) {
        count("outbox");
        return {
          rows: [{ id: 101 } as unknown as Row, { id: 102 } as unknown as Row],
          rowCount: 2,
        };
      }

      if (text.startsWith("INSERT INTO run_logs")) {
        count("run_logs");
        return { rows: [], rowCount: 2 };
      }

      if (text.startsWith("INSERT INTO run_events")) {
        count("run_events");
        return { rows: [], rowCount: 2 };
      }

      if (text.startsWith("INSERT INTO artifacts")) {
        count("artifacts");
        return {
          rows: [
            { artifact_id: "a-1", created_at: "2026-03-05T00:00:00.000Z" } as unknown as Row,
            { artifact_id: "a-2", created_at: "2026-03-05T00:00:00.000Z" } as unknown as Row,
          ],
          rowCount: 2,
        };
      }

      if (text.startsWith("INSERT INTO claims")) {
        count("claims");
        return {
          rows: [
            { claim_id: "c-1", created_at: "2026-03-05T00:00:00.000Z" } as unknown as Row,
            { claim_id: "c-2", created_at: "2026-03-05T00:00:00.000Z" } as unknown as Row,
          ],
          rowCount: 2,
        };
      }

      if (text.startsWith("INSERT INTO claim_evidence")) {
        count("claim_evidence");
        return { rows: [], rowCount: 2 };
      }

      return { rows: [], rowCount: 1 };
    },
    async transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return operation(this);
    },
  };

  const store = new PostgresSessionStore(executor);
  const result = await store.commitStep({
    runId: "run-batch",
    event: {
      id: "evt-batch",
      type: "MESSAGE",
      sessionId: "s-batch",
      payload: {},
    },
    sessionId: "s-batch",
    expectedVersion: 1,
    nextStepAgent: "stepB",
    statePatch: { next: true },
    effects: [
      {
        type: "test_noop",
        payload: { op: 1 },
        idempotencyKey: "fx-1",
        failurePolicy: "STOP",
      },
      {
        type: "test_noop",
        payload: { op: 2 },
        idempotencyKey: "fx-2",
        failurePolicy: "STOP",
      },
    ],
    emitEvents: [
      { type: "runtime.event.1", payload: { ok: 1 } },
      { type: "runtime.event.2", payload: { ok: 2 } },
    ],
    runLogs: [
      { runId: "run-batch", sessionId: "s-batch", stepIndex: 0, eventName: "step_started", level: "INFO" },
      { runId: "run-batch", sessionId: "s-batch", stepIndex: 0, eventName: "step_done", level: "INFO" },
    ],
    runEvents: [
      {
        runId: "run-batch",
        sessionId: "s-batch",
        stepIndex: 0,
        type: "step.started",
        level: "INFO",
        timestamp: "2026-03-05T00:00:00.000Z",
      },
      {
        runId: "run-batch",
        sessionId: "s-batch",
        stepIndex: 0,
        type: "step.committed",
        level: "INFO",
        timestamp: "2026-03-05T00:00:01.000Z",
      },
    ],
    artifacts: [
      { id: "a-1", type: "artifact", payload: { a: 1 } },
      { id: "a-2", type: "artifact", payload: { a: 2 } },
    ],
    claims: [
      { id: "c-1", text: "claim-1", evidenceIds: ["a-1"], status: "proposed" },
      { id: "c-2", text: "claim-2", evidenceIds: ["a-2"], status: "verified" },
    ],
    stepIndex: 0,
  });

  assert.equal(queryCounts.effects, 1);
  assert.equal(queryCounts.outbox, 1);
  assert.equal(queryCounts.run_logs, 1);
  assert.equal(queryCounts.run_events, 1);
  assert.equal(queryCounts.artifacts, 1);
  assert.equal(queryCounts.claims, 1);
  assert.equal(queryCounts.claim_evidence, 1);
  assert.equal(result.persistedEffects.length, 2);
  assert.deepEqual(result.persistedOutboxEventIds, [101, 102]);
  assert.equal(result.persistedArtifacts.length, 2);
  assert.equal(result.persistedClaims.length, 2);
});

test("getArtifact reads a session-scoped artifact by id", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /SELECT artifact_id, run_id, session_id, step_index, artifact_type, payload_json, created_at[\s\S]+WHERE artifact_id = \$1 AND session_id = \$2/,
      rows: [
        {
          artifact_id: "artifact-1",
          run_id: "run-1",
          session_id: "session-1",
          step_index: 3,
          artifact_type: "tool-output",
          payload_json: { result: "stored evidence" },
          created_at: "2026-05-16T12:00:00.000Z",
        },
      ],
      rowCount: 1,
    },
  ]);
  const store = new PostgresSessionStore(sql);

  const artifact = await store.getArtifact({
    artifactId: "artifact-1",
    sessionId: "session-1",
  });

  assert.deepEqual(artifact, {
    artifactId: "artifact-1",
    runId: "run-1",
    sessionId: "session-1",
    stepIndex: 3,
    type: "tool-output",
    payload: { result: "stored evidence" },
    createdAt: "2026-05-16T12:00:00.000Z",
  });
  sql.assertExhausted();
});

test("listArtifacts applies session, run, step, and type filters", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /SELECT artifact_id, run_id, session_id, step_index, artifact_type, payload_json, created_at[\s\S]+WHERE session_id = \$1 AND run_id = \$2 AND step_index = \$3 AND artifact_type = \$4[\s\S]+ORDER BY created_at DESC, artifact_id ASC[\s\S]+LIMIT \$5/,
      rows: [
        {
          artifact_id: "artifact-2",
          run_id: "run-1",
          session_id: "session-1",
          step_index: 3,
          artifact_type: "tool-output-digest",
          payload_json: { digest: "summary" },
          created_at: "2026-05-16T12:01:00.000Z",
        },
      ],
      rowCount: 1,
    },
  ]);
  const store = new PostgresSessionStore(sql);

  const artifacts = await store.listArtifacts({
    sessionId: "session-1",
    runId: "run-1",
    stepIndex: 3,
    type: "tool-output-digest",
    limit: 20,
  });

  assert.deepEqual(artifacts, [
    {
      artifactId: "artifact-2",
      runId: "run-1",
      sessionId: "session-1",
      stepIndex: 3,
      type: "tool-output-digest",
      payload: { digest: "summary" },
      createdAt: "2026-05-16T12:01:00.000Z",
    },
  ]);
  assert.deepEqual(sql.queries[0]?.values, ["session-1", "run-1", 3, "tool-output-digest", 20]);
  sql.assertExhausted();
});

test("claimNextRegionWorkItem claims deterministically with cursor wrap", async () => {
  const sql = new ScriptedSqlExecutor([
    { match: /^BEGIN/ },
    { match: /SELECT id[\s\S]+region > \$2/, rows: [], rowCount: 0 },
    { match: /SELECT id[\s\S]+ORDER BY region ASC, id ASC[\s\S]+LIMIT 1/, rows: [{ id: 7 }], rowCount: 1 },
    {
      match: /^UPDATE region_work_items/,
      rows: [
        {
          id: 7,
          session_id: "s-1",
          region: "alpha",
          step_agent: "worker",
          status: "CLAIMED",
          state_node_json: { parent: "p", child: "c" },
          created_at: "2026-02-26T00:00:00.000Z",
          claimed_at: "2026-02-26T00:00:01.000Z",
          completed_at: null,
          error_json: null,
        },
      ],
      rowCount: 1,
    },
    { match: /^COMMIT/ },
  ]);

  const store = new PostgresSessionStore(sql);
  const claimed = await store.claimNextRegionWorkItem("s-1", "zulu");

  assert.equal(claimed?.id, 7);
  assert.equal(claimed?.region, "alpha");
  assert.equal(claimed?.stepAgent, "worker");
});

test("appendLegacyArchive persists snapshot row", async () => {
  const sql = new ScriptedSqlExecutor([
    { match: /^INSERT INTO legacy_session_archives/, rowCount: 1 },
  ]);

  const store = new PostgresSessionStore(sql);
  await store.appendLegacyArchive({
    sessionId: "legacy-s1",
    snapshot: { old: true },
    reason: "test_reason",
  });

  const insert = sql.queries.find((query) =>
    query.text.startsWith("INSERT INTO legacy_session_archives"),
  );
  assert.equal(insert !== undefined, true);
});

test("getReplayStream can reconstruct delegation lineage from kernel orchestration records", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /^SELECT delegation_id, parent_thread_id, child_thread_id/,
      rows: [
        {
          delegation_id: "delegation-1",
          parent_thread_id: "thread-parent",
          child_thread_id: "thread-child",
          title: "Investigate",
          prompt: "Look into the failure",
          status: "WAITING",
          policy_json: {
            supervision: {
              groupId: "supervision-group-1",
            },
          },
          created_at: "2026-03-16T12:00:00.000Z",
          updated_at: "2026-03-16T12:05:00.000Z",
        },
      ],
      rowCount: 1,
    },
    {
      match: /^SELECT thread_id, session_id, title, status, parent_thread_id, active_run_id, current_request_id, last_run_status, wait_for_json, metadata_json, created_at, updated_at\s+FROM orchestration_threads/,
      rows: [
        {
          thread_id: "thread-child",
          session_id: "session-child",
          title: "Child",
          status: "WAITING",
          parent_thread_id: "thread-parent",
          active_run_id: "run-child",
          current_request_id: null,
          last_run_status: "WAITING",
          wait_for_json: null,
          metadata_json: null,
          created_at: "2026-03-16T12:00:00.000Z",
          updated_at: "2026-03-16T12:05:00.000Z",
        },
      ],
      rowCount: 1,
    },
    {
      match: /^SELECT run_id, session_id, step_index, event_type, level, metadata_json, occurred_at\s+FROM run_events/,
      rows: [
        {
          run_id: "run-parent",
          session_id: "thread-parent",
          step_index: 0,
          event_type: "delegation.progress",
          level: "INFO",
          metadata_json: {
            supervisionGroupId: "supervision-group-1",
            fanInDecision: "wait_for_more",
          },
          occurred_at: "2026-03-16T12:04:59.000Z",
        },
        {
          run_id: "run-parent",
          session_id: "thread-parent",
          step_index: 0,
          event_type: "delegation.waiting",
          level: "INFO",
          metadata_json: { delegationId: "delegation-1", childThreadId: "thread-child" },
          occurred_at: "2026-03-16T12:05:00.000Z",
        },
        {
          run_id: "run-child",
          session_id: "session-child",
          step_index: 0,
          event_type: "run.waiting",
          level: "INFO",
          metadata_json: { threadId: "thread-child", delegationId: "delegation-1" },
          occurred_at: "2026-03-16T12:05:01.000Z",
        },
      ],
      rowCount: 3,
    },
  ]);

  const store = new PostgresSessionStore(sql);
  const replay = await store.getReplayStream({
    delegationId: "delegation-1",
  });

  assert.equal(replay.length, 3);
  assert.equal(replay.some((event) => event.sessionId === "session-child"), true);
  assert.equal(replay.some((event) => event.type === "delegation.waiting"), true);
  assert.equal(replay.some((event) => event.type === "delegation.progress"), true);
  const query = sql.queries[2];
  assert.equal(query?.text.includes("metadata_json ->> 'delegationId'"), true);
  assert.equal(query?.text.includes("metadata_json ->> 'supervisionGroupId'"), true);
});

test("getReplayStream normalizes legacy GMT offset filter timestamps", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /^SELECT run_id, session_id, step_index, event_type, level, metadata_json, occurred_at\s+FROM run_events/,
      rows: [],
      rowCount: 0,
    },
  ]);

  const store = new PostgresSessionStore(sql);
  await store.getReplayStream({
    fromTimestamp: "2026-03-16T17:32:09 GMT-0400",
    toTimestamp: "2026-03-16T17:32:10 GMT-0400",
  });

  const query = sql.queries[0];
  assert.equal(query?.values?.includes("2026-03-16T21:32:09.000Z"), true);
  assert.equal(query?.values?.includes("2026-03-16T21:32:10.000Z"), true);
});

test("upsertThread persists orchestration thread records through SessionStore", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /^INSERT INTO orchestration_threads/,
      rowCount: 1,
    },
  ]);

  const store = new PostgresSessionStore(sql);
  await store.upsertThread({
    threadId: "thread-1",
    sessionId: "session-1",
    title: "Root",
    status: "IDLE",
    createdAt: "2026-03-16T17:32:09 GMT-0400",
    updatedAt: "2026-03-16T17:32:10 GMT-0400",
  });

  assert.equal(sql.queries[0]?.text.startsWith("INSERT INTO orchestration_threads"), true);
  assert.equal(sql.queries[0]?.values?.[10], "2026-03-16T21:32:09.000Z");
  assert.equal(sql.queries[0]?.values?.[11], "2026-03-16T21:32:10.000Z");
});

test("upsertThread guards active run ids behind an existing same-session run", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /^INSERT INTO orchestration_threads/,
      rowCount: 1,
    },
  ]);

  const store = new PostgresSessionStore(sql);
  await store.upsertThread({
    threadId: "thread-1",
    sessionId: "session-1",
    title: "Root",
    status: "WAITING",
    activeRunId: "run-maybe-stale",
    createdAt: "2026-03-16T17:32:09 GMT-0400",
    updatedAt: "2026-03-16T17:32:10 GMT-0400",
  });

  const query = sql.queries[0];
  assert.match(query?.text ?? "", /WHEN \$6::text IS NULL THEN NULL/);
  assert.match(query?.text ?? "", /FROM runs/);
  assert.match(query?.text ?? "", /run_id = \$6::text/);
  assert.match(query?.text ?? "", /session_id = \$2/);
  assert.match(query?.text ?? "", /WHEN EXCLUDED\.active_run_id IS NULL THEN NULL/);
  assert.match(query?.text ?? "", /run_id = EXCLUDED\.active_run_id/);
  assert.match(query?.text ?? "", /session_id = EXCLUDED\.session_id/);
  assert.equal(query?.values?.[5], "run-maybe-stale");
});

test("assembly change proposals persist provider/model/prompt requests as explicit columns", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /^INSERT INTO orchestration_assembly_change_proposals/,
      rowCount: 1,
    },
  ]);

  const store = new PostgresSessionStore(sql);
  await store.upsertAssemblyChangeProposal({
    proposalId: "proposal-1",
    threadId: "thread-1",
    requestedToolAllowlist: ["web.search"],
    requestedProvider: "openai",
    requestedModel: "gpt-4.1-mini",
    requestedPromptVariant: "reference-react:chat:responses",
    proposedBy: "model",
    status: "PENDING",
    reason: "Need responses-compatible routing",
    metadata: {
      compatibilityStatus: "compatible",
    },
    createdAt: "2026-03-16T17:32:09 GMT-0400",
  });

  assert.equal(sql.queries[0]?.values?.[4], "openai");
  assert.equal(sql.queries[0]?.values?.[5], "gpt-4.1-mini");
  assert.equal(sql.queries[0]?.values?.[6], "reference-react:chat:responses");
  assert.equal(sql.queries[0]?.values?.[13], JSON.stringify({ compatibilityStatus: "compatible" }));
  assert.equal(sql.queries[0]?.values?.[14], "2026-03-16T21:32:09.000Z");
  sql.assertExhausted();
});

test("assembly change proposals read explicit compatibility request columns with metadata fallback", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match:
        /^SELECT proposal_id, thread_id, requested_bundle_id, requested_tool_allowlist_json, requested_provider, requested_model, requested_prompt_variant, requested_specialist_ids_json, requested_context_policy_id, requested_approval_policy_id, proposed_by, status, reason, metadata_json, created_at, resolved_at/,
      rows: [
        {
          proposal_id: "proposal-1",
          thread_id: "thread-1",
          requested_bundle_id: null,
          requested_tool_allowlist_json: ["web.search"],
          requested_provider: "openai",
          requested_model: "gpt-4.1-mini",
          requested_prompt_variant: "reference-react:chat:responses",
          requested_specialist_ids_json: [],
          requested_context_policy_id: null,
          requested_approval_policy_id: null,
          proposed_by: "model",
          status: "PENDING",
          reason: "Need responses-compatible routing",
          metadata_json: { compatibilityStatus: "compatible" },
          created_at: "2026-03-16T21:32:09.000Z",
          resolved_at: null,
        },
      ],
      rowCount: 1,
    },
    {
      match:
        /^SELECT proposal_id, thread_id, requested_bundle_id, requested_tool_allowlist_json, requested_provider, requested_model, requested_prompt_variant, requested_specialist_ids_json, requested_context_policy_id, requested_approval_policy_id, proposed_by, status, reason, metadata_json, created_at, resolved_at/,
      rows: [
        {
          proposal_id: "proposal-legacy",
          thread_id: "thread-1",
          requested_bundle_id: null,
          requested_tool_allowlist_json: ["web.search"],
          requested_provider: null,
          requested_model: null,
          requested_prompt_variant: null,
          requested_specialist_ids_json: [],
          requested_context_policy_id: null,
          requested_approval_policy_id: null,
          proposed_by: "model",
          status: "PENDING",
          reason: "Legacy metadata fallback",
          metadata_json: {
            requestedProvider: "anthropic",
            requestedModel: "claude-3-7-sonnet",
            requestedPromptVariant: "reference-react:chat:messages",
          },
          created_at: "2026-03-16T21:32:09.000Z",
          resolved_at: null,
        },
      ],
      rowCount: 1,
    },
  ]);

  const store = new PostgresSessionStore(sql);
  const explicit = await store.getAssemblyChangeProposal("proposal-1");
  const fallback = await store.getAssemblyChangeProposal("proposal-legacy");

  assert.equal(explicit?.requestedProvider, "openai");
  assert.equal(explicit?.requestedModel, "gpt-4.1-mini");
  assert.equal(explicit?.requestedPromptVariant, "reference-react:chat:responses");
  assert.equal(fallback?.requestedProvider, "anthropic");
  assert.equal(fallback?.requestedModel, "claude-3-7-sonnet");
  assert.equal(fallback?.requestedPromptVariant, "reference-react:chat:messages");
  sql.assertExhausted();
});

test("enforced schema check requires orchestration kernel tables", async () => {
  const sql = new ScriptedSqlExecutor([
    {
      match: /^SELECT[\s\S]+has_orchestration_threads[\s\S]+has_orchestration_thread_compaction_events/,
      rows: [
        {
          has_schema_version: true,
          has_legacy_readonly: true,
          has_run_events: true,
          has_run_logs: false,
          has_region_work_items: true,
          has_claimed_at: true,
          has_completed_at: true,
          has_error_json: true,
          has_legacy_session_archives: true,
          has_current_state_json: true,
          has_active_run_id: true,
          has_active_run_started_at: true,
          has_state_patch_json: true,
          has_snapshot_kind: true,
          has_orchestration_threads: false,
          has_orchestration_delegations: false,
          has_orchestration_interaction_requests: false,
          has_orchestration_approval_grants: false,
          has_orchestration_context_summary_artifacts: false,
          has_orchestration_thread_compaction_events: false,
          has_orchestration_operator_focus: false,
          has_orchestration_operator_attention: false,
          has_orchestration_assembly_bundles: false,
          has_orchestration_thread_assembly_records: false,
          has_orchestration_assembly_change_proposals: false,
          has_assembly_proposal_requested_provider: false,
          has_assembly_proposal_requested_model: false,
          has_assembly_proposal_requested_prompt_variant: false,
          has_orchestration_assembly_change_decisions: false,
          has_orchestration_specialist_definitions: false,
          has_orchestration_context_policy_definitions: false,
        },
      ],
      rowCount: 1,
    },
  ]);

  const store = new PostgresSessionStore(sql, {
    enforceSchemaV3: true,
  });

  await assert.rejects(
    () => store.getSession("session-1"),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Kestrel schema v3 is required. Run database migrations before starting runtime.",
  );
});
