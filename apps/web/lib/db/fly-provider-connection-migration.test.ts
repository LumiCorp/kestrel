import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0043_fly_provider_connections.sql"),
  "utf8"
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8"
);

contractTest(
  "web.hermetic",
  "Fly provider connections expand the existing organization credential contract",
  () => {
    assert.match(
      migration,
      /DROP CONSTRAINT IF EXISTS "ai_provider_connections_provider_check"/u
    );
    assert.match(migration, /CHECK \("provider" IN \('fly', 'runpod'\)\)/u);
    assert.doesNotMatch(migration, /api_key/u);
    assert.match(journal, /0043_fly_provider_connections/u);
  }
);
