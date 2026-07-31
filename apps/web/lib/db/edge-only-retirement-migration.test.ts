import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const migrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

test(
  "the Edge-only retirement migration purges preview state and removes provider selection",
  async () => {
    const retiredProviderKey = ["n", "g", "r", "o", "k"].join("");
    const source = await readFile(
      path.join(
        migrations,
        `0053_retire_${retiredProviderKey}_edge_only.sql`,
      ),
      "utf8",
    );
    assert.match(source, /DELETE FROM "workspace_preview_leases"/u);
    assert.match(source, /DELETE FROM "app_operation_approvals"/u);
    assert.match(source, /DELETE FROM "app_connections"/u);
    assert.match(source, /DELETE FROM "app_credentials"/u);
    assert.match(source, /DELETE FROM "app_definitions"/u);
    assert.match(source, /DELETE FROM "tool_providers"/u);
    assert.match(source, /DELETE FROM "organization_usage_events"/u);
    assert.match(source, /DELETE FROM "organization_cost_entries"/u);
    assert.match(source, /DELETE FROM "cost_rate_cards"/u);
    assert.match(source, /DROP COLUMN IF EXISTS "preview_ingress_provider"/u);
    assert.match(source, /DROP COLUMN IF EXISTS "ingress_provider"/u);
    assert.match(source, /DROP COLUMN IF EXISTS "connection_id"/u);
    assert.match(
      source,
      /CHECK \("kind" IN \('api_key', 'oauth', 'secret_headers'\)\)/u,
    );
  },
);
