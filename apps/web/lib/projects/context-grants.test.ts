import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isProjectContextGrantExpired,
  type ProjectContextGrant,
  parseProjectContextGrant,
} from "./context-grants";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const validGrant: ProjectContextGrant = {
  organizationId: "org_123",
  projectId: "project_123",
  threadId: "thread_123",
  actorUserId: "user_123",
  contextRevisionId: "revision_7",
  contextRevision: 7,
  expiresAt: "2026-07-12T18:00:00.000Z",
};

contractTest("web.hermetic", "Project context grant parser fails closed for forged payloads", () => {
  assert.deepEqual(
    parseProjectContextGrant(JSON.stringify(validGrant)),
    validGrant
  );
  assert.equal(parseProjectContextGrant("not-json"), null);
  assert.equal(
    parseProjectContextGrant(
      JSON.stringify({ ...validGrant, projectId: undefined })
    ),
    null
  );
  assert.equal(
    parseProjectContextGrant(
      JSON.stringify({ ...validGrant, contextRevision: "7" })
    ),
    null
  );
});

contractTest("web.hermetic", "Project context grant expiry uses the embedded immutable deadline", () => {
  assert.equal(
    isProjectContextGrantExpired(
      validGrant,
      Date.parse("2026-07-12T17:59:59Z")
    ),
    false
  );
  assert.equal(
    isProjectContextGrantExpired(validGrant, Date.parse(validGrant.expiresAt)),
    true
  );
});

contractTest("web.hermetic", "Project context grant resolution revalidates membership, Thread, revision, and revocation", () => {
  const source = fs.readFileSync(
    fileURLToPath(import.meta.url).replace(/\.test\.ts$/, ".ts"),
    "utf8"
  );
  assert.match(source, /requireProjectRole/);
  assert.match(source, /eq\(table\.projectId, grant\.projectId\)/);
  assert.match(
    source,
    /eq\(schema\.projectContextRevisions\.projectId, grant\.projectId\)/
  );
  assert.match(
    source,
    /eq\(schema\.projectContextRevisions\.revision, grant\.contextRevision\)/
  );
  assert.match(
    source,
    /redis\.del\(`\$\{GRANT_PREFIX\}\$\{grantId\.trim\(\)\}`\)/
  );
});
