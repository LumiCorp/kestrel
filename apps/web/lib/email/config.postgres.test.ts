import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

contractTest(
  "web.postgres",
  "platform email rejects an unavailable environment credential and accepts an encrypted key",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");
    process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
    process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
      "test-key": randomBytes(32).toString("base64"),
    });

    const [{ resetDbRuntimeForTests }, { EmailConfigError, saveEmailConfig }] =
      await Promise.all([import("@/lib/db/runtime"), import("./config")]);
    const sql = postgres(databaseUrl, { max: 1 });
    const userId = `platform-email-user-${crypto.randomUUID()}`;
    const now = new Date();

    context.after(async () => {
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${userId}, 'Platform Email User', ${`${userId}@example.test`}, true, ${now}, ${now}
      )
    `;

    await assert.rejects(
      saveEmailConfig({
        actorUserId: userId,
        credentialSource: "environment",
        fromName: "Kestrel One",
        fromEmail: "hello@example.test",
        enabled: false,
        env: { NODE_ENV: "test" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EmailConfigError);
        assert.equal(error.code, "EMAIL_ENVIRONMENT_CREDENTIAL_MISSING");
        return true;
      },
    );
    const missingEnvironmentRows = await sql<[{ count: string }]>`
      SELECT count(*)::text AS count FROM "platform_email_config"
    `;
    assert.equal(missingEnvironmentRows[0]?.count, "0");

    const stored = await saveEmailConfig({
      actorUserId: userId,
      credentialSource: "stored",
      apiKey: "re_platform_email_test_key",
      fromName: "Kestrel One",
      fromEmail: "hello@example.test",
      enabled: false,
    });
    assert.equal(stored.credentialConfigured, true);
    assert.equal(stored.status, "disabled");
  },
);
