import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("Platform OAuth registrations persist encrypted revisions, conflicts, and redacted audit evidence", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });

  const [{ resetDbRuntimeForTests }, registrations] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./platform-oauth-registrations"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const actorUserId = `platform-oauth-admin-${suffix}`;
  const auditFailureFunction = `fail_platform_oauth_audit_${suffix.replaceAll("-", "")}`;
  const auditFailureTrigger = `fail_platform_oauth_audit_trigger_${suffix.replaceAll("-", "")}`;
  const now = new Date();

  context.after(async () => {
    await sql.unsafe(
      `DROP TRIGGER IF EXISTS "${auditFailureTrigger}" ON "admin_event_logs"`,
    );
    await sql.unsafe(`DROP FUNCTION IF EXISTS "${auditFailureFunction}"()`);
    await sql`DELETE FROM "admin_event_logs" WHERE "actor_user_id" = ${actorUserId}`;
    await sql`DELETE FROM "platform_oauth_registrations" WHERE "updated_by_user_id" = ${actorUserId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${actorUserId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${actorUserId}, 'Platform OAuth Admin', ${`${actorUserId}@example.test`}, true, ${now}, ${now}
      )
    `;

  const google = {
    actorUserId,
    provider: "google_workspace" as const,
    clientId: "google-client-1",
    enabledPacks: ["gmail", "calendar"],
    enabled: true,
  };
  const created = await registrations.savePlatformOAuthRegistration({
    ...google,
    clientSecret: "google-secret-1",
    expectedRevision: null,
  });
  assert.equal(created.config.revision, 1);
  const [firstStored] = await sql`
      SELECT "encrypted_client_secret", "revision", "client_id", "enabled_packs"
      FROM "platform_oauth_registrations"
      WHERE "provider" = 'google_workspace'
    `;
  assert.match(firstStored.encrypted_client_secret, /^kgc:v1:/u);
  assert.notEqual(firstStored.encrypted_client_secret, "google-secret-1");
  assert.equal(firstStored.revision, 1);

  const clientIdChanged = await registrations.savePlatformOAuthRegistration({
    ...google,
    clientId: "google-client-2",
    expectedRevision: 1,
  });
  assert.equal(clientIdChanged.config.revision, 2);
  const packChanged = await registrations.savePlatformOAuthRegistration({
    ...google,
    clientId: "google-client-2",
    enabledPacks: ["gmail"],
    expectedRevision: 2,
  });
  assert.equal(packChanged.config.revision, 3);
  const disabled = await registrations.savePlatformOAuthRegistration({
    ...google,
    clientId: "google-client-2",
    enabledPacks: ["gmail"],
    enabled: false,
    expectedRevision: 3,
  });
  assert.equal(disabled.config.revision, 4);
  const rotated = await registrations.savePlatformOAuthRegistration({
    ...google,
    clientId: "google-client-2",
    clientSecret: "google-secret-2",
    enabledPacks: ["gmail"],
    enabled: false,
    expectedRevision: 4,
  });
  assert.equal(rotated.config.revision, 5);
  const [rotatedStored] = await sql`
      SELECT "encrypted_client_secret", "revision", "client_id", "enabled_packs"
      FROM "platform_oauth_registrations"
      WHERE "provider" = 'google_workspace'
    `;
  assert.notEqual(
    rotatedStored.encrypted_client_secret,
    firstStored.encrypted_client_secret,
  );
  assert.equal(rotatedStored.revision, 5);
  assert.equal(rotatedStored.client_id, "google-client-2");
  assert.deepEqual(rotatedStored.enabled_packs, ["gmail"]);

  await assert.rejects(
    registrations.savePlatformOAuthRegistration({
      ...google,
      clientId: "stale-client-id",
      enabledPacks: ["gmail"],
      enabled: false,
      expectedRevision: 4,
    }),
    (error: unknown) => {
      assert.ok(error instanceof registrations.PlatformOAuthRegistrationError);
      assert.equal(error.code, "OAUTH_REGISTRATION_CONFLICT");
      return true;
    },
  );
  const [afterConflict] = await sql`
      SELECT "client_id", "revision"
      FROM "platform_oauth_registrations"
      WHERE "provider" = 'google_workspace'
    `;
  assert.equal(afterConflict.client_id, "google-client-2");
  assert.equal(afterConflict.revision, 5);

  const microsoftCreated = await registrations.savePlatformOAuthRegistration({
    actorUserId,
    provider: "microsoft_365",
    clientId: "microsoft-client-1",
    clientSecret: "microsoft-secret-1",
    tenantOrIssuer: "Organizations",
    enabledPacks: ["teams"],
    enabled: true,
    expectedRevision: null,
  });
  const microsoftTenantChanged =
    await registrations.savePlatformOAuthRegistration({
      actorUserId,
      provider: "microsoft_365",
      clientId: "microsoft-client-1",
      tenantOrIssuer: "A3A39A57-A605-4DB5-B8C3-A7AF1AD223E7",
      enabledPacks: ["teams"],
      enabled: true,
      expectedRevision: microsoftCreated.config.revision,
    });
  assert.equal(microsoftTenantChanged.config.revision, 2);
  assert.equal(
    microsoftTenantChanged.config.tenantOrIssuer,
    "a3a39a57-a605-4db5-b8c3-a7af1ad223e7",
  );

  const auditRows = await sql`
      SELECT "action", "metadata"
      FROM "admin_event_logs"
      WHERE "actor_user_id" = ${actorUserId}
        AND "category" = 'platform_oauth_registration'
      ORDER BY "created_at"
    `;
  assert.equal(auditRows.length, 7);
  assert.equal(
    auditRows.some((row) => JSON.stringify(row).includes("secret")),
    false,
  );
  assert.equal(
    auditRows.some((row) => JSON.stringify(row).includes("kgc:v1")),
    false,
  );

  await sql.unsafe(`
    CREATE FUNCTION "${auditFailureFunction}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.actor_user_id = '${actorUserId}' THEN
        RAISE EXCEPTION 'planned Platform OAuth audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await sql.unsafe(`
    CREATE TRIGGER "${auditFailureTrigger}"
    AFTER INSERT ON "admin_event_logs"
    FOR EACH ROW EXECUTE FUNCTION "${auditFailureFunction}"()
  `);
  await assert.rejects(
    registrations.savePlatformOAuthRegistration({
      ...google,
      clientId: "must-not-commit",
      enabledPacks: ["gmail"],
      enabled: false,
      expectedRevision: 5,
    }),
  );
  const [afterAuditFailure] = await sql`
    SELECT "client_id", "revision"
    FROM "platform_oauth_registrations"
    WHERE "provider" = 'google_workspace'
  `;
  assert.equal(afterAuditFailure.client_id, "google-client-2");
  assert.equal(afterAuditFailure.revision, 5);
  const auditRowsAfterFailure = await sql`
    SELECT "id"
    FROM "admin_event_logs"
    WHERE "actor_user_id" = ${actorUserId}
      AND "category" = 'platform_oauth_registration'
  `;
  assert.equal(auditRowsAfterFailure.length, 7);
});
