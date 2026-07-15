import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_TURN_DB_TEST_URL?.trim();

test(
  "mobile Thread creation and queued removal are transactionally authoritative",
  {
    skip: databaseUrl ? false : "KESTREL_TURN_DB_TEST_URL is not configured",
  },
  async (context) => {
    assert.ok(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [{ resetDbRuntimeForTests }, store] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./store"),
    ]);
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const organizationId = `mobile-store-org-${suffix}`;
    const userId = `mobile-store-user-${suffix}`;
    const environmentId = `mobile-store-environment-${suffix}`;
    const atomicThreadId = `mobile-store-atomic-${suffix}`;
    const rolledBackThreadId = `mobile-store-rollback-${suffix}`;
    const queueThreadId = `mobile-store-queue-${suffix}`;
    const now = new Date();

    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, 'Mobile Store User', ${`${userId}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Mobile Store Org',
          ${`mobile-store-org-${suffix}`}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "region", "status", "is_default"
        ) VALUES (
          ${environmentId}, ${organizationId}, ${userId}, 'Default', 'default',
          'iad', 'ready', true
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "origin"
        ) VALUES (
          ${queueThreadId}, 'Queued Removal', ${userId},
          ${organizationId}, 'mobile'
        )
      `;
    });

    const atomicInput = {
      threadId: atomicThreadId,
      projectId: null,
      organizationId,
      authorUserId: userId,
      messageId: `message-mobile-atomic-${suffix}`,
      messageParts: [{ type: "text", text: "Atomic first prompt" }],
      idempotencyKey: `idempotency-mobile-atomic-${suffix}`,
      requestedEnvironmentId: environmentId,
      source: "mobile" as const,
    };
    const atomic = await store.createMobileThreadWithFirstTurn(atomicInput);
    assert.equal(atomic.created, true);
    assert.equal(atomic.shouldDispatch, true);

    const duplicate = await store.createMobileThreadWithFirstTurn(atomicInput);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.turn.id, atomic.turn.id);

    const [atomicCounts] = await sql<
      Array<{ messages: number; threads: number; turns: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM "threads" WHERE "id" = ${atomicThreadId}) AS "threads",
        (SELECT count(*)::int FROM "thread_messages" WHERE "thread_id" = ${atomicThreadId}) AS "messages",
        (SELECT count(*)::int FROM "thread_turns" WHERE "thread_id" = ${atomicThreadId}) AS "turns"
    `;
    assert.deepEqual(atomicCounts, { messages: 1, threads: 1, turns: 1 });

    await assert.rejects(
      store.createMobileThreadWithFirstTurn({
        ...atomicInput,
        threadId: rolledBackThreadId,
        messageId: `message-mobile-rollback-${suffix}`,
        idempotencyKey: `idempotency-mobile-rollback-${suffix}`,
        requestedEnvironmentId: `missing-environment-${suffix}`,
      })
    );
    const [rolledBackCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "threads"
      WHERE "id" = ${rolledBackThreadId}
    `;
    assert.equal(rolledBackCount?.count, 0);

    const createQueuedTurn = (label: string) =>
      store.createDurableThreadTurn({
        threadId: queueThreadId,
        organizationId,
        authorUserId: userId,
        messageId: `message-${label}-${suffix}`,
        messageParts: [{ type: "text", text: label }],
        idempotencyKey: `idempotency-${label}-${suffix}`,
        requestedEnvironmentId: environmentId,
        source: "mobile",
      });
    const active = await createQueuedTurn("queued-removal-active");
    const next = await createQueuedTurn("queued-removal-next");

    const removed = await store.removeQueuedDurableTurn({
      turnId: active.turn.id,
      organizationId,
      userId,
    });
    assert.equal(removed.nextTurnId, next.turn.id);
    assert.equal(await store.getDurableTurn(active.turn.id), null);

    const [removedPromptCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "thread_messages"
      WHERE "id" = ${active.turn.inputMessageId}
    `;
    assert.equal(removedPromptCount?.count, 0);

    const visibleQueue = await store.listDurableThreadQueueForUser({
      threadId: queueThreadId,
      organizationId,
      userId,
    });
    assert.equal(visibleQueue.queue.activeTurnId, next.turn.id);
    assert.deepEqual(
      visibleQueue.turns.map((turn) => turn.id),
      [next.turn.id]
    );
  }
);
