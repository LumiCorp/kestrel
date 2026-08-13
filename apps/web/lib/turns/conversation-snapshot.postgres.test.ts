import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_TURN_DB_TEST_URL?.trim();

test(
  "conversation snapshots never expose an ordinary interaction without its assistant message",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_TURN_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [{ resetDbRuntimeForTests }, store, snapshotStore] =
      await Promise.all([
        import("@/lib/db/runtime"),
        import("./store"),
        import("./conversation-snapshot.server"),
      ]);
    const sql = postgres(databaseUrl, { max: 4 });
    const suffix = crypto.randomUUID();
    const organizationId = `snapshot-org-${suffix}`;
    const userId = `snapshot-user-${suffix}`;
    const environmentId = `snapshot-environment-${suffix}`;
    const threadId = `snapshot-thread-${suffix}`;
    const messageId = `snapshot-user-message-${suffix}`;
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
          ${userId}, 'Snapshot User', ${`${userId}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Snapshot Org', ${`snapshot-org-${suffix}`}, ${now}
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
          ${threadId}, 'Snapshot Thread', ${userId}, ${organizationId}, 'web'
        )
      `;
    });

    const created = await store.createDurableThreadTurn({
      threadId,
      organizationId,
      authorUserId: userId,
      messageId,
      messageParts: [{ type: "text", text: "Ask me a question." }],
      idempotencyKey: messageId,
      requestedEnvironmentId: environmentId,
      source: "web",
    });
    assert.ok(await store.claimDurableThreadTurn(created.turn.id));

    const requestId = `snapshot-request-${suffix}`;
    const assistantMessageId = `snapshot-assistant-${suffix}`;
    const settle = store.persistDurableAssistantOutcome({
      turnId: created.turn.id,
      messages: [
        {
          id: assistantMessageId,
          parts: [{ type: "text", text: "Which workspace should I inspect?" }],
          model: "kestrel-one",
          source: "web",
          projectContextRevisionId: null,
        },
      ],
      interaction: {
        version: "v1",
        requestId,
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Which workspace should I inspect?",
        source: "runtime",
        status: "pending",
      },
    });
    const reads = Array.from({ length: 12 }, () =>
      snapshotStore.readThreadConversationSnapshotForUser({
        threadId,
        organizationId,
        userId,
      }),
    );
    await settle;
    const results = await Promise.all(reads);
    for (const read of results) {
      assert.ok(read);
      const pending = read.snapshot.interactions.find(
        (interaction) => interaction.requestId === requestId,
      );
      if (pending) {
        assert.equal(pending.assistantMessageId, assistantMessageId);
        assert.equal(
          read.snapshot.messages.some(
            (message) =>
              message.id === assistantMessageId &&
              message.metadata?.kestrelTurnId === created.turn.id,
          ),
          true,
        );
      }
    }

    const settled = await snapshotStore.readThreadConversationSnapshotForUser({
      threadId,
      organizationId,
      userId,
    });
    assert.ok(settled);
    assert.equal(
      settled.snapshot.messages.filter(
        (message) => message.id === assistantMessageId,
      ).length,
      1,
    );

    await sql`
      UPDATE "thread_interactions"
      SET "assistant_message_id" = ${messageId}
      WHERE "request_id" = ${requestId}
    `;
    await assert.rejects(
      snapshotStore.readThreadConversationSnapshotForUser({
        threadId,
        organizationId,
        userId,
      }),
      (error: unknown) =>
        error instanceof snapshotStore.ThreadConversationSnapshotError &&
        error.code === "THREAD_CONVERSATION_SNAPSHOT_INCONSISTENT",
    );
  },
);
