import assert from "node:assert/strict";
import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";
import {
  hashGitHubActionPayload,
  readGitHubApprovalRequest,
} from "./github-action-approval-contract";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "GitHub approval requests parse only structured mutation waits", () => {
  const request = readGitHubApprovalRequest({
    type: "run.completed",
    payload: {
      result: {
        assistantText: "Allow this GitHub issue to be created?",
        output: {
          status: "WAITING",
          waitFor: {
            interaction: {
              version: "v1",
              requestId: "runtime-run:3:abc123",
              kind: "approval",
              eventType: "user.approval",
              prompt: "Allow this GitHub issue to be created?",
              approval: {
                toolCallId: "tool-call-1",
                toolName: "kestrel_one.github_issue_create",
                input: {
                  repository: "acme/widgets",
                  title: "Investigate the canary",
                },
              },
            },
          },
        },
      },
    },
  } as unknown as RunnerRunTerminalEvent);
  assert.equal(request?.operation, "issue.create");
  assert.equal(request?.repository, "acme/widgets");
  assert.equal(
    readGitHubApprovalRequest({
      type: "run.failed",
      payload: { error: { message: "failed" } },
    } as unknown as RunnerRunTerminalEvent),
    null
  );
});

contractTest("web.hermetic", "GitHub approval payload hashes are key-order independent", () => {
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
