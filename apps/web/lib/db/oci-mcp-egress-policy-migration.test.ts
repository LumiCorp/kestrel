import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0057_oci_mcp_egress_policy.sql"),
  "utf8",
);

test("OCI egress migration defaults legacy containers to no network", () => {
  assert.match(migration, /WHERE "source_type" = 'oci'/u);
  assert.match(migration, /"network_access" = 'none'/u);
  assert.match(migration, /\{"mode":"none","version":1\}/u);
  assert.match(migration, /mcp\.oci_egress\.migrated_to_none/u);
  assert.doesNotMatch(migration, /DELETE FROM/u);
});

test("OCI egress migration revokes grants missing immutable profile identity", () => {
  assert.match(migration, /"execution_profile_fingerprint"/u);
  assert.match(migration, /"oci_egress_bindings"/u);
  assert.match(migration, /"status" = 'revoked'/u);
  assert.match(migration, /"mcp_egress_events"/u);
  assert.match(migration, /mcp_egress_events_denial_reason_check/u);
  assert.match(migration, /ADDRESS_FORBIDDEN/u);
});

test("none-policy migration digest matches canonical shared encoding", () => {
  const digest = createHash("sha256")
    .update('{"mode":"none","version":1}')
    .digest("hex");
  assert.match(migration, new RegExp(`sha256:${digest}`, "u"));
});
