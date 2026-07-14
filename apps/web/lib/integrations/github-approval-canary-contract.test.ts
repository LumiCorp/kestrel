import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import {
  findGithubIssueApprovalRequest,
  hasGithubApprovalDecision,
  respondToGithubApproval,
} from "./github-approval-canary-contract";

const pendingMessage: UIMessage = {
  id: "assistant-canary",
  role: "assistant",
  parts: [
    { type: "text", text: "I need approval before creating the issue." },
    {
      type: "dynamic-tool",
      toolName: "kestrel_one.github_issue_create",
      toolCallId: "approval:runtime-run:4:canary",
      state: "approval-requested",
      approval: { id: "runtime-run:4:canary" },
      input: {
        repository: "acme/widgets",
        title: "Kestrel approval canary canary-123",
        body: "This request must be denied.",
      },
    } as UIMessage["parts"][number],
  ],
};

test("approval canary selects only the exact GitHub issue request", () => {
  assert.equal(
    findGithubIssueApprovalRequest({
      messages: [pendingMessage],
      repository: "other/widgets",
      title: "Kestrel approval canary canary-123",
      body: "This request must be denied.",
    }),
    null
  );
  const request = findGithubIssueApprovalRequest({
    messages: [pendingMessage],
    repository: "acme/widgets",
    title: "Kestrel approval canary canary-123",
    body: "This request must be denied.",
  });
  assert.equal(request?.approvalId, "runtime-run:4:canary");
  assert.equal(request?.toolCallId, "approval:runtime-run:4:canary");
});

test("approval canary produces and verifies an exact denied response", () => {
  const request = findGithubIssueApprovalRequest({
    messages: [pendingMessage],
    repository: "acme/widgets",
    title: "Kestrel approval canary canary-123",
    body: "This request must be denied.",
  });
  assert.ok(request);
  const responded = respondToGithubApproval({
    request,
    approved: false,
    reason: "Kestrel approval-ledger canary denial",
  });
  assert.equal(
    hasGithubApprovalDecision({
      messages: [responded],
      approvalId: request.approvalId,
      approved: false,
    }),
    true
  );
  assert.deepEqual(responded.parts[0], pendingMessage.parts[0]);
});
