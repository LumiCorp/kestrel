import assert from "node:assert/strict";
import test from "node:test";
import {
  hashGitHubActionPayload,
  readGitHubApprovalRequest,
} from "./github-action-approval-contract";

test("GitHub approval requests parse only structured mutation waits", () => {
  const request = readGitHubApprovalRequest({
    type: "run.waiting",
    payload: {
      waitFor: {
        eventType: "user.approval",
        metadata: {
          approvalId: "runtime-run:3:abc123",
          toolName: "kestrel_one.github_issue_create",
          toolInput: {
            repository: "acme/widgets",
            title: "Investigate the canary",
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    },
  });
  assert.equal(request?.operation, "issue.create");
  assert.equal(request?.repository, "acme/widgets");
  assert.equal(
    readGitHubApprovalRequest({ type: "run.progress", payload: {} }),
    null
  );
});

test("GitHub approval payload hashes are key-order independent", () => {
  assert.equal(
    hashGitHubActionPayload({
      operation: "issue.create",
      repository: "acme/widgets",
      title: "Canary",
    }),
    hashGitHubActionPayload({
      title: "Canary",
      repository: "acme/widgets",
      operation: "issue.create",
    })
  );
});
