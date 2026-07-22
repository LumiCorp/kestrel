import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0042_connection_scoped_app_capabilities.sql"),
  "utf8",
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8",
);

contractTest(
  "web.hermetic",
  "discovered App capabilities migrate to connection-owned identities",
  () => {
    assert.match(
      migration,
      /'knowledge_sources', 'communication', 'workflow', 'custom'/u,
    );
    assert.match(migration, /ADD COLUMN "connection_id" text/u);
    assert.match(
      migration,
      /ADD COLUMN "active" boolean DEFAULT true NOT NULL/u,
    );
    assert.match(migration, /'mcp:' \|\| discovered\."id"/u);
    assert.match(migration, /snapshot\."status" = 'approved'/u);
    assert.match(
      migration,
      /legacy_grant\."environment_id" = server\."environment_id"/u,
    );
    assert.match(journal, /"tag": "0042_connection_scoped_app_capabilities"/u);
  },
);
