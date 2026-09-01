import test from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import {
  assertDurableApprovalTerminal,
  durableApprovalResponse,
  findGithubDurableApprovalRequest,
  findGithubIssueApprovalRequest,
  hasGithubApprovalDecision,
  respondToGithubApproval,
} from "./github-approval-canary-contract";
import type { ThreadInteractionView } from "@/lib/turns/client-contract";

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
    null,
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
    true,
  );
  assert.deepEqual(responded.parts[0], pendingMessage.parts[0]);
});

const durablePending: ThreadInteractionView = {
  id: "interaction-1",
  requestId: "request-1",
  source: "runtime",
  sourceCheckpointId: null,
  kind: "approval",
  eventType: "user.approval",
  prompt: "Approve kestrel_one.github_issue_create?",
  status: "pending",
  requestEnvelope: {
    version: "runner_hosted_tool_approval_interaction_v4",
    requestId: "request-1",
    kind: "approval",
    eventType: "user.approval",
    prompt: "Approve kestrel_one.github_issue_create?",
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
      preparedInvocationId: "prepared-1",
      toolName: "kestrel_one.github_issue_create",
      stableToolIdentity: {
        version: "stable_tool_approval_identity_v1",
        toolId: "kestrel_one.github_issue_create",
        descriptorContractRevision: `sha256:${"a".repeat(64)}`,
        approvalAuthorityRevision: "authority-1",
      },
      requestingActor: {
        actorType: "end_user",
        actorId: "user-1",
        tenantId: "org-1",
      },
      rememberedApprovalScope: { kind: "tool_identity" },
      requestedAt: "2026-08-26T12:00:00.000Z",
      expiresAt: "2099-08-26T12:05:00.000Z",
      presentation: {
        title: "Create a GitHub issue",
        summary: "Open a new issue on GitHub.",
        fields: [
          { label: "Repository", value: "acme/widgets" },
          { label: "Title", value: "Canary title" },
          { label: "Description", value: "Canary body" },
        ],
        warnings: [],
        policy: {
          mode: "ask",
          reasonCode: "environment_policy",
          explanation: "Ask first.",
          authorityKind: "hosted_app_policy",
          authorityRevision: "authority-1",
        },
      },
    },
  },
  responseEnvelope: null,
  responseMessageId: null,
  turnId: "turn-1",
  assistantMessageId: "message-1",
  createdAt: "2026-08-26T12:00:00.000Z",
  resolvedAt: null,
};

test("durable canary selects only the exact pending V4 prepared invocation", () => {
  assert.equal(
    findGithubDurableApprovalRequest({
      interactions: [durablePending],
      repository: "other/widgets",
      title: "Canary title",
      body: "Canary body",
    }),
    null,
  );
  const request = findGithubDurableApprovalRequest({
    interactions: [durablePending],
    repository: "acme/widgets",
    title: "Canary title",
    body: "Canary body",
  });
  assert.deepEqual(request, {
    interactionId: "interaction-1",
    requestId: "request-1",
    turnId: "turn-1",
    preparedInvocationId: "prepared-1",
    stableToolIdentity: {
      version: "stable_tool_approval_identity_v1",
      toolId: "kestrel_one.github_issue_create",
      descriptorContractRevision: `sha256:${"a".repeat(64)}`,
      approvalAuthorityRevision: "authority-1",
    },
    requestingActor: {
      actorType: "end_user",
      actorId: "user-1",
      tenantId: "org-1",
    },
  });
});

test("durable canary submits the exact three-way decision and requires terminal effect evidence", () => {
  const request = findGithubDurableApprovalRequest({
    interactions: [durablePending],
    repository: "acme/widgets",
    title: "Canary title",
    body: "Canary body",
  });
  assert.ok(request);
  assert.deepEqual(
    durableApprovalResponse({
      request,
      decision: "remember_approval",
      reason: "Remember for canary thread",
    }),
    {
      requestId: "request-1",
      eventType: "user.approval",
      turnId: "turn-1",
      message: "Remember for canary thread",
      decision: "remember_approval",
      reason: "Remember for canary thread",
    },
  );
  assert.equal(
    assertDurableApprovalTerminal({
      interactions: [
        {
          ...durablePending,
          status: "resolved",
          responseEnvelope: { decision: "remember_approval" },
          approvalOutcome: {
            decision: "approved",
            authorizationState: "accepted",
            effectState: "committed",
            retryEligible: false,
          },
        },
      ],
      request,
      decision: "remember_approval",
    }),
    true,
  );
  assert.equal(
    assertDurableApprovalTerminal({
      interactions: [
        {
          ...durablePending,
          status: "resolved",
          responseEnvelope: { decision: "remember_approval" },
          approvalOutcome: {
            decision: "approved",
            authorizationState: "accepted",
            effectState: "not_started",
            retryEligible: false,
          },
        },
      ],
      request,
      decision: "remember_approval",
    }),
    false,
  );
});
