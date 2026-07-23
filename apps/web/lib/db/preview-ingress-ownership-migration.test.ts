import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");

contractTest("web.postgres", "preview ingress ownership migration preserves ngrok history and permits Edge leases", async () => {
  const migration = await readFile(path.join(root, "0051_preview_ingress_ownership.sql"), "utf8");
  assert.match(migration, /preview_ingress_provider/u);
  assert.match(migration, /ingress_provider/u);
  assert.match(migration, /ALTER COLUMN "connection_id" DROP NOT NULL/u);
  assert.match(migration, /kestrel_edge/u);
  assert.match(migration, /status" NOT IN \('provisioning', 'active', 'closing'\)/u);
});
