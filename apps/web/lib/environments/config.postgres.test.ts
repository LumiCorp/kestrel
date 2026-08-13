import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("hosted Environment eligibility is explicit after the BYO Fly migration", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");

  const [{ resetDbRuntimeForTests }, { getHostedEnvironmentsRollout }] =
    await Promise.all([import("@/lib/db/runtime"), import("./config")]);
  const sql = postgres(databaseUrl, { max: 1 });
  context.after(async () => {
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  const organizationId = `eligibility-${crypto.randomUUID()}`;
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (${organizationId}, 'Eligibility Test', ${organizationId}, now())
  `;

  assert.deepEqual(
    await getHostedEnvironmentsRollout({
      organizationId,
      env: { KESTREL_ENVIRONMENTS_ENABLED: "true" },
    }),
    {
      deploymentEnabled: true,
      organizationConfigured: false,
      organizationEnabled: false,
      effectiveEnabled: false,
    },
  );

  await sql`
    INSERT INTO "organization_feature_flags" (
      "organization_id", "key", "enabled", "updated_by_user_id"
    ) VALUES (${organizationId}, 'hosted_environments', true, NULL)
  `;

  assert.deepEqual(
    await getHostedEnvironmentsRollout({
      organizationId,
      env: { KESTREL_ENVIRONMENTS_ENABLED: "true" },
    }),
    {
      deploymentEnabled: true,
      organizationConfigured: true,
      organizationEnabled: true,
      effectiveEnabled: true,
    },
  );
});
