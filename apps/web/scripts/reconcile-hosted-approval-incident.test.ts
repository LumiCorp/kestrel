import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("hosted approval incident reconciliation is scoped, preconditioned, and non-replaying", async () => {
  const source = await readFile(
    new URL("./reconcile-hosted-approval-incident.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /36dd83cc-5dc8-4343-914a-f2bd71026b60/u);
  assert.match(source, /affected\.length !== 3/u);
  assert.match(source, /deliveries\.length !== 0/u);
  assert.match(source, /approvals\.length !== 0/u);
  assert.match(source, /if \(!apply\)/u);
  assert.match(source, /return knowledgeDb\.transaction\(async \(tx\) =>/u);
  assert.match(source, /status: "failed"/u);
  assert.match(source, /effectStatus: "not_started"/u);
  assert.match(source, /responseRetryable: false/u);
  assert.doesNotMatch(source, /insert\(schema\.appOperationApprovals\)/u);
  assert.doesNotMatch(source, /sendOrganizationEmail|provider\.send/u);
});
