import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";
import {
  hashGitHubActionPayload,
  readGitHubApprovalRequest,
} from "./github-action-approval-contract";


test("GitHub approval requests parse only structured mutation waits", () => {
  const request = readGitHubApprovalRequest({
    type: "run.completed",
    payload: {
      result: {
        assistantText: "Allow this GitHub issue to be created?",
        output: {
          status: "WAITING",
          waitFor: {
            metadata: {
              toolInput: {
                repository: "acme/widgets",
                title: "Investigate the canary",
              },
            },
            interaction: {
              version: "runner_hosted_tool_approval_interaction_v4",
              requestId: "runtime-run:3:abc123",
              kind: "approval",
              eventType: "user.approval",
              prompt: "Allow this GitHub issue to be created?",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["decision"],
                properties: {
                  decision: {
                    type: "string",
                    enum: ["decline", "approve_once", "remember_approval"],
                  },
                },
              },
              approval: {
                preparedInvocationId: "tool-call-1",
                toolName: "kestrel_one.github_issue_create",
                stableToolIdentity: {
                  version: "stable_tool_approval_identity_v1",
                  toolId: "kestrel_one.github_issue_create",
                  descriptorContractRevision: `sha256:${"a".repeat(64)}`,
                  approvalAuthorityRevision: "authority-1",
                },
                requestingActor: {
                  actorId: "user-1",
                  actorType: "end_user",
                  tenantId: "organization-1",
                },
                rememberedApprovalScope: { kind: "tool_identity" },
                requestedAt: "2026-08-27T12:00:00.000Z",
                expiresAt: "2026-08-27T12:05:00.000Z",
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
