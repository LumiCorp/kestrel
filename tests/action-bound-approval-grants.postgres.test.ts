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
