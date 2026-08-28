import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();
const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.resolve(
    directory,
    "../../drizzle/migrations/0003_platform_oauth_registration_identity_recovery.sql",
  ),
  "utf8",
);

test("legacy Platform OAuth settings migration disables invalid rows and preserves valid registrations", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  const sql = postgres(databaseUrl, { max: 1 });
  const before = new Date("2020-01-01T00:00:00.000Z");

  context.after(async () => {
    await sql.end({ timeout: 0 });
  });

  await sql.unsafe(`
    CREATE TEMP TABLE platform_oauth_registrations (
      id text PRIMARY KEY,
      provider text NOT NULL,
      client_id text,
      tenant_or_issuer text,
      enabled boolean NOT NULL,
      revision integer NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `);
  await sql`
    INSERT INTO platform_oauth_registrations (
      id, provider, client_id, tenant_or_issuer, enabled, revision, updated_at
    ) VALUES
      ('google-null-tenant', 'google_workspace', 'google-client', NULL, true, 3, ${before}),
      ('google-blank-client', 'google_workspace', '  ', NULL, true, 4, ${before}),
      ('google-tenant', 'google_workspace', 'google-client', 'legacy-issuer.example.test', true, 5, ${before}),
      ('microsoft-null-tenant', 'microsoft_365', 'microsoft-client', NULL, true, 6, ${before}),
      ('microsoft-organizations', 'microsoft_365', 'microsoft-client', 'organizations', true, 7, ${before}),
      ('microsoft-guid', 'microsoft_365', 'microsoft-client', 'A3A39A57-A605-4DB5-B8C3-A7AF1AD223E7', true, 8, ${before}),
      ('microsoft-blank-tenant', 'microsoft_365', 'microsoft-client', ' ', true, 9, ${before}),
      ('microsoft-noncanonical-client', 'microsoft_365', ' microsoft-client ', 'organizations', true, 10, ${before})
  `;

  await sql.unsafe(migration);

  const rows = await sql<
    Array<{
      id: string;
      clientId: string | null;
      tenantOrIssuer: string | null;
      enabled: boolean;
      revision: number;
      updatedAt: Date;
    }>
  >`
    SELECT
      id,
      client_id AS "clientId",
      tenant_or_issuer AS "tenantOrIssuer",
      enabled,
      revision,
      updated_at AS "updatedAt"
    FROM platform_oauth_registrations
    ORDER BY id
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const invalidExpectedRevisions = new Map([
    ["google-blank-client", 5],
    ["google-tenant", 6],
    ["microsoft-blank-tenant", 10],
    ["microsoft-noncanonical-client", 11],
  ]);
  for (const [id, revision] of invalidExpectedRevisions) {
    const row = byId.get(id);
    assert.ok(row, `${id} fixture row exists`);
    assert.equal(row.enabled, false);
    assert.equal(row.revision, revision);
    assert.ok(row.updatedAt > before);
  }

  const validExpectedRevisions = new Map([
    ["google-null-tenant", 3],
    ["microsoft-null-tenant", 6],
    ["microsoft-organizations", 7],
    ["microsoft-guid", 8],
  ]);
  for (const [id, revision] of validExpectedRevisions) {
    const row = byId.get(id);
    assert.ok(row, `${id} fixture row exists`);
    assert.equal(row.enabled, true);
    assert.equal(row.revision, revision);
    assert.equal(row.updatedAt.toISOString(), before.toISOString());
  }

  assert.equal(byId.get("google-blank-client")?.clientId, "  ");
  assert.equal(byId.get("microsoft-blank-tenant")?.tenantOrIssuer, " ");
});
