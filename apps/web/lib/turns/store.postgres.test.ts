import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_TURN_DB_TEST_URL?.trim();

async function waitFor<T>(
  read: () => Promise<T>,
  settled: (value: T) => boolean
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (settled(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the durable turn to settle.");
}

test(
  "durable turns converge across claims, dispatch failure, and worker recovery",
  {
    skip: databaseUrl ? false : "KESTREL_TURN_DB_TEST_URL is not configured",
  },
  async (context) => {
    assert.ok(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [{ resetDbRuntimeForTests }, store, queue] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./store"),
      import("./queue"),
    ]);
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const organizationId = `turn-org-${suffix}`;
    const userId = `turn-user-${suffix}`;
    const environmentId = `turn-environment-${suffix}`;
    const successfulThreadId = `turn-success-${suffix}`;
    const dispatchFailureThreadId = `turn-dispatch-failure-${suffix}`;
    const orphanedThreadId = `turn-orphaned-${suffix}`;
    const recoveryThreadId = `turn-recovery-${suffix}`;
    const resumedThreadId = `turn-resumed-${suffix}`;
    const now = new Date();

    context.after(async () => {
      await queue.stopDurableThreadTurnWorker();
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
          ${userId}, 'Turn Worker User', ${`${userId}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Turn Worker Org',
          ${`turn-worker-org-${suffix}`}, ${now}
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
        ) VALUES
          (
            ${successfulThreadId}, 'Successful Turn', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${dispatchFailureThreadId}, 'Dispatch Failure', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${orphanedThreadId}, 'Orphaned Turn', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${recoveryThreadId}, 'Recovery Turn', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${resumedThreadId}, 'Resumed Turn', ${userId},
            ${organizationId}, 'mobile'
          )
      `;
    });

    const createTurn = (threadId: string, label: string) =>
      store.createDurableThreadTurn({
        threadId,
        organizationId,
        authorUserId: userId,
        messageId: `message-${label}-${suffix}`,
        messageParts: [{ type: "text", text: label }],
        idempotencyKey: `idempotency-${label}-${suffix}`,
        requestedEnvironmentId: environmentId,
        source: "mobile",
      });

    const successful = await createTurn(successfulThreadId, "success");
    assert.equal(successful.created, true);
    assert.equal(successful.shouldDispatch, true);
    assert.equal(successful.dispatchTurnId, successful.turn.id);
    const duplicate = await createTurn(successfulThreadId, "success");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.turn.id, successful.turn.id);

    const claims = await Promise.all([
      store.claimDurableThreadTurn(successful.turn.id),
      store.claimDurableThreadTurn(successful.turn.id),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const completed = await store.completeDurableThreadTurn({
      turnId: successful.turn.id,
      status: "completed",
    });
    assert.equal(completed.turn.status, "completed");
    const [successfulQueue] = await sql<
      Array<{ activeTurnId: string | null; state: string }>
    >`
      SELECT
        "active_turn_id" AS "activeTurnId",
        "state"
      FROM "thread_turn_queue_state"
      WHERE "thread_id" = ${successfulThreadId}
    `;
    assert.deepEqual(successfulQueue, {
      activeTurnId: null,
      state: "running",
    });

    const dispatchFailure = await createTurn(
      dispatchFailureThreadId,
      "dispatch-failure"
    );
    assert.equal(
      await queue.finalizeExhaustedDurableTurnJob({
        turnId: dispatchFailure.turn.id,
        retryCount: 2,
        retryLimit: 3,
      }),
      false
    );
    assert.equal(
      (await store.getDurableTurn(dispatchFailure.turn.id))?.status,
      "queued"
    );
    assert.equal(
      await queue.finalizeExhaustedDurableTurnJob({
        turnId: dispatchFailure.turn.id,
        retryCount: 3,
        retryLimit: 3,
      }),
      true
    );
    const failedDispatch = await store.getDurableTurn(dispatchFailure.turn.id);
    assert.equal(failedDispatch?.status, "failed");
    assert.equal(failedDispatch?.failureCode, "TURN_DISPATCH_FAILED");
    const [failedQueue] = await sql<
      Array<{
        activeTurnId: string | null;
        pauseReason: string | null;
        state: string;
      }>
    >`
      SELECT
        "active_turn_id" AS "activeTurnId",
        "pause_reason" AS "pauseReason",
        "state"
      FROM "thread_turn_queue_state"
      WHERE "thread_id" = ${dispatchFailureThreadId}
    `;
    assert.deepEqual(failedQueue, {
      activeTurnId: null,
      pauseReason: "turn_failed",
      state: "paused",
    });

    const failedBeforeResume = await createTurn(
      resumedThreadId,
      "failure-before-resume"
    );
    assert.ok(await store.claimDurableThreadTurn(failedBeforeResume.turn.id));
    await store.completeDurableThreadTurn({
      turnId: failedBeforeResume.turn.id,
      status: "failed",
      failureCode: "RUNTIME_FAILED",
      failureMessage: "Synthetic failure before an explicit user retry.",
    });
    const resumedByUserMessage = await createTurn(
      resumedThreadId,
      "explicit-user-retry"
    );
    assert.equal(resumedByUserMessage.shouldDispatch, true);
    assert.equal(
      resumedByUserMessage.dispatchTurnId,
      resumedByUserMessage.turn.id
    );
    const [resumedQueue] = await sql<
      Array<{
        activeTurnId: string | null;
        pauseReason: string | null;
        state: string;
      }>
    >`
      SELECT
        "active_turn_id" AS "activeTurnId",
        "pause_reason" AS "pauseReason",
        "state"
      FROM "thread_turn_queue_state"
      WHERE "thread_id" = ${resumedThreadId}
    `;
    assert.deepEqual(resumedQueue, {
      activeTurnId: resumedByUserMessage.turn.id,
      pauseReason: null,
      state: "running",
    });

    const orphaned = await createTurn(orphanedThreadId, "orphaned");
    assert.ok(await store.claimDurableThreadTurn(orphaned.turn.id));
    await queue.reconcileDurableThreadTurnQueue();
    const failedOrphaned = await store.getDurableTurn(orphaned.turn.id);
    assert.equal(failedOrphaned?.status, "failed");
    assert.equal(failedOrphaned?.failureCode, "TURN_WORKER_INTERRUPTED");

    const recovery = await createTurn(recoveryThreadId, "recovery");
    assert.equal(recovery.shouldDispatch, true);
    await queue.reconcileDurableThreadTurnQueue();
    await queue.reconcileDurableThreadTurnQueue();
    const [recoveryJobCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "pgboss"."job"
      WHERE
        "name" = ${queue.DURABLE_THREAD_TURN_QUEUE}
        AND "data" ->> 'turnId' = ${recovery.turn.id}
        AND "state" IN ('created', 'retry', 'active')
    `;
    assert.equal(recoveryJobCount?.count, 1);
    await queue.startDurableThreadTurnWorker();
    const recovered = await waitFor(
      () => store.getDurableTurn(recovery.turn.id),
      (turn) =>
        Boolean(
          turn && ["completed", "failed", "cancelled"].includes(turn.status)
        )
    );
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.failureCode, "RUNTIME_FAILED");
    assert.match(
      recovered?.failureMessage ?? "",
      /Hosted Environment configuration is incomplete/u
    );
    const recoveryEvents = await store.listDurableTurnEvents({
      turnId: recovery.turn.id,
    });
    assert.deepEqual(
      recoveryEvents
        .map((event) => event.type)
        .filter((type) => type !== "ui.message"),
      ["turn.queued", "turn.running", "turn.failed"]
    );
    assert.ok(recoveryEvents.some((event) => event.type === "ui.message"));

    await Promise.all([
      queue.enqueueDurableThreadTurn(recovery.turn.id),
      queue.enqueueDurableThreadTurn(recovery.turn.id),
    ]);
    const [deliveryCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "pgboss"."job"
      WHERE
        "name" = ${queue.DURABLE_THREAD_TURN_QUEUE}
        AND "data" ->> 'turnId' = ${recovery.turn.id}
    `;
    assert.ok(deliveryCount && deliveryCount.count >= 3);
  }
);
