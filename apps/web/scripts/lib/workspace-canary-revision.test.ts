import test from "node:test";
import assert from "node:assert/strict";

import { parseWorkspaceCanaryRevision } from "./workspace-canary-revision";

const revision = `"kestrel-sha256-${"a".repeat(64)}"`;

test("Workspace canary preserves strong Kestrel revisions", () => {
  assert.equal(parseWorkspaceCanaryRevision(revision), revision);
});

test("Workspace canary restores a transport-weakened Kestrel revision", () => {
  assert.equal(parseWorkspaceCanaryRevision(`W/${revision}`), revision);
});

test("Workspace canary rejects missing and non-Kestrel validators", () => {
  assert.throws(() => parseWorkspaceCanaryRevision(null), /valid Kestrel/u);
  assert.throws(
    () => parseWorkspaceCanaryRevision('W/"untrusted"'),
    /valid Kestrel/u,
  );
});
