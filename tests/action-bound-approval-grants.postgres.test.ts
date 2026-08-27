import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import type { RunnerInteractionRequestV1 } from "@kestrel-agents/protocol";
import { PostgresOrchestrationStore } from "../src/orchestration/PostgresOrchestrationStore.js";
import type { SqlExecutor } from "../src/store/PostgresSessionStore.js";
import { legacyRecoveryReviewInteractionFixture } from "./fixtures/structured-review-contract.js";

const databaseUrl = process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();

test("approval migration expires every legacy active grant without a binding", async () => {
  assert.ok(databaseUrl, "KESTREL_PRODUCT_RUNNER_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const suffix = randomUUID();
  const sessionId = `approval-session-${suffix}`;
  const threadId = `approval-thread-${suffix}`;
  const requestId = `approval-request-${suffix}`;
  const legacyGrantId = `approval-legacy-${suffix}`;
  try {
    await pool.query("INSERT INTO sessions (session_id) VALUES ($1)", [sessionId]);
    await pool.query(
      `INSERT INTO orchestration_threads
         (thread_id, session_id, title, status)
       VALUES ($1, $2, 'Approval migration', 'WAITING')`,
      [threadId, sessionId],
    );
    await pool.query(
      `INSERT INTO orchestration_interaction_requests
         (request_id, thread_id, kind, status, event_type)
       VALUES ($1, $2, 'approval', 'RESOLVED', 'user.approval')`,
      [requestId, threadId],
    );

    const migration = await readFile(
      new URL("../db/migrations/030_action_bound_approval_grants.sql", import.meta.url),
      "utf8",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE orchestration_approval_grants DROP CONSTRAINT orchestration_approval_grants_bound_status_check",
      );
      await client.query(
        `INSERT INTO orchestration_approval_grants
           (grant_id, thread_id, request_id, scope, status, issued_by, issued_at)
         VALUES ($1, $2, $3, 'turn', 'ACTIVE', 'legacy-operator', now())`,
        [legacyGrantId, threadId, requestId],
      );
      await client.query(migration);
      const legacy = await client.query<{ status: string }>(
        "SELECT status FROM orchestration_approval_grants WHERE grant_id = $1",
        [legacyGrantId],
      );
      assert.equal(legacy.rows[0]?.status, "EXPIRED");
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    await pool.end();
  }
});

test("Local Core PostgreSQL persists and reloads the canonical interaction envelope", async () => {
  assert.ok(databaseUrl, "KESTREL_PRODUCT_RUNNER_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const suffix = randomUUID();
  const sessionId = `review-session-${suffix}`;
  const threadId = `review-thread-${suffix}`;
  const requestId = `review-request-${suffix}`;
  const interaction = {
    ...(structuredClone(legacyRecoveryReviewInteractionFixture) as unknown as RunnerInteractionRequestV1),
    requestId,
  };
  try {
    await pool.query("INSERT INTO sessions (session_id) VALUES ($1)", [sessionId]);
    await pool.query(
      `INSERT INTO orchestration_threads
         (thread_id, session_id, title, status)
       VALUES ($1, $2, 'Structured review persistence', 'WAITING')`,
      [threadId, sessionId],
    );
    const store = new PostgresOrchestrationStore(
      pool as unknown as SqlExecutor,
    );
    await store.upsertInteractionRequest({
      requestId,
      threadId,
      kind: "user_input",
      status: "PENDING",
      eventType: "user.reply",
      waitKind: "user",
      prompt: interaction.prompt,
      interaction,
      metadata: { reason: "recovery_review" },
      createdAt: new Date().toISOString(),
    });

    const restored = await store.getInteractionRequest(requestId);
    assert.deepEqual(restored?.interaction, interaction);
  } finally {
    await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    await pool.end();
  }
});

test("Local Core PostgreSQL preserves the waiting run identity across create, update, get, list, and restart", async () => {
  assert.ok(databaseUrl, "KESTREL_PRODUCT_RUNNER_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const suffix = randomUUID();
  const sessionId = `identity-session-${suffix}`;
  const threadId = `identity-thread-${suffix}`;
  const firstRunId = `identity-run-first-${suffix}`;
  const secondRunId = `identity-run-second-${suffix}`;
  const requestId = `identity-request-${suffix}`;
  try {
    await pool.query("INSERT INTO sessions (session_id) VALUES ($1)", [sessionId]);
    await pool.query(
      `INSERT INTO runs (run_id, session_id, event_type, status)
       VALUES ($1, $3, 'user.message', 'WAITING'), ($2, $3, 'user.reply', 'WAITING')`,
      [firstRunId, secondRunId, sessionId],
    );
    await pool.query(
      `INSERT INTO orchestration_threads (thread_id, session_id, title, status)
       VALUES ($1, $2, 'Approval run identity', 'WAITING')`,
      [threadId, sessionId],
    );
    const record = {
      requestId,
      threadId,
      runId: firstRunId,
      kind: "approval" as const,
      status: "PENDING" as const,
      eventType: "user.approval",
      metadata: { conversationRunId: firstRunId },
      createdAt: new Date().toISOString(),
    };
    const store = new PostgresOrchestrationStore(pool as unknown as SqlExecutor);
    await store.upsertInteractionRequest(record);
    assert.equal((await store.getInteractionRequest(requestId))?.runId, firstRunId);

    await store.upsertInteractionRequest({
      ...record,
      runId: secondRunId,
      metadata: { conversationRunId: secondRunId },
    });
    assert.equal((await store.listInteractionRequests({ threadId }))[0]?.runId, secondRunId);

    const restartedStore = new PostgresOrchestrationStore(pool as unknown as SqlExecutor);
    assert.equal((await restartedStore.getInteractionRequest(requestId))?.runId, secondRunId);
  } finally {
    await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    await pool.end();
  }
});

test("PostgreSQL reserves local dialog names for the parent lifetime and fences stale completion", async () => {
  assert.ok(databaseUrl, "KESTREL_PRODUCT_RUNNER_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const suffix = randomUUID();
  const sessionId = `dialog-session-${suffix}`;
  const parentThreadId = `dialog-parent-${suffix}`;
  const firstChildThreadId = `dialog-child-first-${suffix}`;
  const secondChildThreadId = `dialog-child-second-${suffix}`;
  const store = new PostgresOrchestrationStore(pool as unknown as SqlExecutor);
  try {
    await pool.query("INSERT INTO sessions (session_id) VALUES ($1)", [sessionId]);
    await pool.query(
      `INSERT INTO orchestration_threads (thread_id, session_id, title, status)
       VALUES ($1, $3, 'Dialog parent', 'IDLE'), ($2, $3, 'Dialog child', 'IDLE'), ($4, $3, 'Duplicate child', 'IDLE')`,
      [parentThreadId, firstChildThreadId, sessionId, secondChildThreadId],
    );
    const first = dialogRecord({
      delegationId: `dialog-first-${suffix}`,
      parentThreadId,
      childThreadId: firstChildThreadId,
      name: "Scout",
      revision: 0,
    });
    assert.equal(await store.createDialog(first), true);
    assert.equal(await store.createDialog(dialogRecord({
      delegationId: `dialog-second-${suffix}`,
      parentThreadId,
      childThreadId: secondChildThreadId,
      name: "scout",
      revision: 0,
    })), false);

    const closed = {
      ...first,
      status: "CANCELLED" as const,
      policy: {
        ...first.policy,
        dialog: {
          ...(first.policy?.dialog as Record<string, unknown>),
          status: "closed",
          activity: "idle",
          revision: 1,
        },
      },
      updatedAt: new Date().toISOString(),
    };
    assert.equal(await store.compareAndSetDialog(closed, 0), true);
    assert.equal(await store.compareAndSetDialog(first, 0), false);
    assert.equal(
      ((await store.getDelegation(first.delegationId))?.policy?.dialog as { revision?: number } | undefined)?.revision,
      1,
    );
  } finally {
    await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    await pool.end();
  }
});

test("interaction run identity migration backfills a referenced metadata run", async () => {
  assert.ok(databaseUrl, "KESTREL_PRODUCT_RUNNER_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const suffix = randomUUID();
  const sessionId = `backfill-session-${suffix}`;
  const threadId = `backfill-thread-${suffix}`;
  const runId = `backfill-run-${suffix}`;
  const requestId = `backfill-request-${suffix}`;
  try {
    await pool.query("INSERT INTO sessions (session_id) VALUES ($1)", [sessionId]);
    await pool.query(
      "INSERT INTO runs (run_id, session_id, event_type, status) VALUES ($1, $2, 'user.message', 'WAITING')",
      [runId, sessionId],
    );
    await pool.query(
      "INSERT INTO orchestration_threads (thread_id, session_id, title, status) VALUES ($1, $2, 'Backfill', 'WAITING')",
      [threadId, sessionId],
    );
    await pool.query(
      `INSERT INTO orchestration_interaction_requests
         (request_id, thread_id, kind, status, event_type, metadata_json, run_id)
       VALUES ($1, $2, 'approval', 'PENDING', 'user.approval', $3::jsonb, NULL)`,
      [requestId, threadId, JSON.stringify({ conversationRunId: runId })],
    );
    const migration = await readFile(
      new URL("../db/migrations/037_interaction_request_run_identity.sql", import.meta.url),
      "utf8",
    );
    await pool.query(migration);
    const restored = await pool.query<{ run_id: string | null }>(
      "SELECT run_id FROM orchestration_interaction_requests WHERE request_id = $1",
      [requestId],
    );
    assert.equal(restored.rows[0]?.run_id, runId);
  } finally {
    await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    await pool.end();
  }
});

function dialogRecord(input: {
  delegationId: string;
  parentThreadId: string;
  childThreadId: string;
  name: string;
  revision: number;
}) {
  const now = new Date().toISOString();
  return {
    delegationId: input.delegationId,
    parentThreadId: input.parentThreadId,
    childThreadId: input.childThreadId,
    title: input.name,
    prompt: "investigate",
    status: "RUNNING" as const,
    provider: "openrouter" as const,
    model: "test-model",
    resultContract: "persistent_dialog_v1",
    policy: {
      dialog: {
        version: "v1",
        name: input.name,
        normalizedName: input.name.toLocaleLowerCase(),
        status: "open",
        activity: "working",
        revision: input.revision,
        messages: [],
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}
