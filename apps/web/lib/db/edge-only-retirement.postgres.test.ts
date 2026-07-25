import assert from "node:assert/strict";
import postgres from "postgres";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

contractTest(
  "web.postgres",
  "the migrated database exposes only the Edge preview schema and catalog",
  async () => {
    assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
    const sql = postgres(databaseUrl, { max: 1 });
    const retiredProviderKey = ["n", "g", "r", "o", "k"].join("");
    try {
      const columns = await sql<Array<{ tableName: string; columnName: string }>>`
        SELECT table_name AS "tableName", column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'environments' AND column_name = 'preview_ingress_provider')
            OR
            (table_name = 'workspace_preview_leases' AND column_name IN ('ingress_provider', 'connection_id'))
          )
      `;
      assert.deepEqual(columns, []);

      const rows = await sql<Array<{ relation: string; count: string }>>`
        SELECT 'app_definitions' AS relation, count(*)::text AS count
        FROM "app_definitions" WHERE "key" = ${retiredProviderKey}
        UNION ALL
        SELECT 'tool_providers' AS relation, count(*)::text AS count
        FROM "tool_providers" WHERE "key" = ${retiredProviderKey}
        UNION ALL
        SELECT 'app_credentials' AS relation, count(*)::text AS count
        FROM "app_credentials" WHERE "kind" = ${`${retiredProviderKey}_agent`}
      `;
      assert.deepEqual(
        rows,
        [
          { relation: "app_definitions", count: "0" },
          { relation: "tool_providers", count: "0" },
          { relation: "app_credentials", count: "0" },
        ],
      );

      const [edgeCatalog] = await sql<Array<{ count: string }>>`
        SELECT count(*)::text AS count
        FROM "app_definitions"
        WHERE "key" = 'built_in.previews' AND "published" = true
      `;
      assert.equal(edgeCatalog?.count, "1");
    } finally {
      await sql.end({ timeout: 0 });
    }
  },
);
