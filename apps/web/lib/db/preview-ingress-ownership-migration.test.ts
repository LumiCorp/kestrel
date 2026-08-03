import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");

test("historical preview ownership migration remains immutable", async () => {
  const migration = await readFile(path.join(root, "0051_preview_ingress_ownership.sql"), "utf8");
  assert.match(migration, /preview_ingress_provider/u);
  assert.match(migration, /ingress_provider/u);
  assert.match(migration, /ALTER COLUMN "connection_id" DROP NOT NULL/u);
  assert.match(migration, /kestrel_edge/u);
  assert.match(migration, /status" NOT IN/u);
});
