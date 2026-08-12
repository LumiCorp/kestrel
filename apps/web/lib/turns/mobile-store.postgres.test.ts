import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";


const databaseUrl = process.env.KESTREL_TURN_DB_TEST_URL?.trim();

test(
  "mobile Thread creation, retry, and queued removal are transactionally authoritative",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_TURN_DB_TEST_URL is required");
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
    const retryThreadId = `mobile-store-retry-${suffix}`;
    const foreignParentThreadId = `mobile-store-foreign-parent-${suffix}`;
    const foreignBranchThreadId = `mobile-store-foreign-branch-${suffix}`;
    const foreignParentBindingId = `binding:${foreignParentThreadId}`;
    const foreignParticipantId = `runtime:${organizationId}:codex`;
    const foreignAnchorMessageId = `message-foreign-anchor-${suffix}`;
    const foreignModelId = `desktop-local:openai:codex-${suffix}`;
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
        ) VALUES
        (
          ${queueThreadId}, 'Queued Removal', ${userId},
          ${organizationId}, 'mobile'
        ),
        (
          ${retryThreadId}, 'Durable Retry', ${userId},
          ${organizationId}, 'mobile'
        )
      `;
      await transaction`
        INSERT INTO "runtime_participants" (
          "id", "organization_id", "runtime_id", "display_name", "created_at"
        ) VALUES (
          ${foreignParticipantId}, ${organizationId}, 'codex', 'Codex', ${now}
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "origin",
          "runtime_id", "runtime_binding_id"
        ) VALUES (
          ${foreignParentThreadId}, 'Foreign Parent', ${userId},
          ${organizationId}, 'web', 'codex', ${foreignParentBindingId}
        )
      `;
      await transaction`
        INSERT INTO "runtime_bindings" (
          "id", "thread_id", "participant_id", "runtime_id",
          "capability_digest", "environment_id", "selected_model_id",
          "status", "native_session_state", "created_at", "updated_at"
        ) VALUES (
          ${foreignParentBindingId}, ${foreignParentThreadId},
          ${foreignParticipantId}, 'codex', 'parent-capability-digest',
          ${environmentId}, ${foreignModelId}, 'ready', 'ready', ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "thread_messages" (
          "id", "thread_id", "role", "author_user_id", "parts", "source",
          "created_at"
        ) VALUES (
          ${foreignAnchorMessageId}, ${foreignParentThreadId}, 'user', ${userId},
          ${JSON.stringify([{ type: "text", text: "Foreign branch anchor" }])}::jsonb,
          'web', ${now}
        )
      `;
    });

    const foreignBranchInput = {
      threadId: foreignBranchThreadId,
      parentThreadId: foreignParentThreadId,
      anchorMessageId: foreignAnchorMessageId,
      projectId: null,
      organizationId,
      authorUserId: userId,
      requestedEnvironmentId: environmentId,
      messageId: `message-foreign-branch-${suffix}`,
      messageParts: [{ type: "text", text: "Continue in the branch" }],
      idempotencyKey: `idempotency-foreign-branch-${suffix}`,
      requestedModelId: foreignModelId,
      requestedRuntimeId: "codex" as const,
      runtimeAdmission: {
        runtimeId: "codex" as const,
        environmentId,
        capabilityDigest: "fresh-branch-capability-digest",
        selectedModelId: foreignModelId,
        observedAt: new Date().toISOString(),
        readinessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      source: "mobile" as const,
    };
    const foreignBranch = await store.createMobileThreadBranchWithFirstTurn(
      foreignBranchInput,
    );
    const duplicateForeignBranch =
      await store.createMobileThreadBranchWithFirstTurn(foreignBranchInput);
    assert.equal(foreignBranch.created, true);
    assert.equal(duplicateForeignBranch.created, false);
    assert.equal(duplicateForeignBranch.turn.id, foreignBranch.turn.id);
    const [foreignBinding] = await sql<
      Array<{
        capabilityDigest: string | null;
        environmentId: string | null;
        nativeSessionState: string;
        runtimeId: string;
        selectedModelId: string | null;
      }>
    >`
      SELECT
        "runtime_id" AS "runtimeId",
        "capability_digest" AS "capabilityDigest",
        "environment_id" AS "environmentId",
        "selected_model_id" AS "selectedModelId",
        "native_session_state" AS "nativeSessionState"
      FROM "runtime_bindings"
      WHERE "thread_id" = ${foreignBranchThreadId}
    `;
    assert.deepEqual(foreignBinding, {
      capabilityDigest: "fresh-branch-capability-digest",
      environmentId,
      nativeSessionState: "uninitialized",
      runtimeId: "codex",
      selectedModelId: foreignModelId,
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

    const originalRetry = await store.createDurableThreadTurn({
      threadId: retryThreadId,
      organizationId,
      authorUserId: userId,
      messageId: `message-retry-root-${suffix}`,
      messageParts: [{ type: "text", text: "Retry this prompt" }],
      idempotencyKey: `idempotency-retry-root-${suffix}`,
      requestedEnvironmentId: environmentId,
      source: "mobile",
    });
    assert.ok(await store.claimDurableThreadTurn(originalRetry.turn.id));
    await store.completeDurableThreadTurn({
      turnId: originalRetry.turn.id,
      status: "failed",
      failureCode: "AGENT_RUN_FAILED",
    });
    const retrySource = await store.getDurableTurnRetrySourceForUser({
      turnId: originalRetry.turn.id,
      organizationId,
      userId,
    });
    assert.ok(retrySource);
    const retryInput = {
      threadId: retryThreadId,
      organizationId,
      authorUserId: userId,
      messageId: `message-retry-attempt-${suffix}`,
      messageParts: retrySource.messageParts,
      sourceMessageId: retrySource.sourceMessageId,
      idempotencyKey: `idempotency-retry-attempt-${suffix}`,
      requestedEnvironmentId: environmentId,
      source: "mobile" as const,
    };
    const retried = await store.createDurableThreadTurn(retryInput);
    const duplicateRetry = await store.createDurableThreadTurn(retryInput);
    assert.equal(retried.created, true);
    assert.equal(duplicateRetry.created, false);
    assert.equal(duplicateRetry.turn.id, retried.turn.id);
    const [retryPrompt] = await sql<
      Array<{ sourceMessageId: string | null; turnId: string | null }>
    >`
      SELECT
        "source_message_id" AS "sourceMessageId",
        "turn_id" AS "turnId"
      FROM "thread_messages"
      WHERE "id" = ${retryInput.messageId}
    `;
    assert.deepEqual(retryPrompt, {
      sourceMessageId: originalRetry.turn.inputMessageId,
      turnId: retried.turn.id,
    });

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
