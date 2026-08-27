import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRunnerInteractionRequest,
  parseRunnerHostedToolApprovalInteractionV4,
} from "../src/execution.js";

const canonical = {
  version: "runner_hosted_tool_approval_interaction_v4",
  requestId: "approval-1",
  kind: "approval",
  eventType: "user.approval",
  prompt: "Approve exec_command?",
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
    toolName: "exec_command",
    stableToolIdentity: {
      version: "stable_tool_approval_identity_v1",
      toolId: "exec_command",
      descriptorContractRevision: `sha256:${"a".repeat(64)}`,
      approvalAuthorityRevision: "authority-1",
    },
    requestingActor: {
      actorType: "end_user",
      actorId: "user-1",
      tenantId: "org-1",
    },
    rememberedApprovalScope: {
      kind: "exec_command_exact",
      command: "pnpm run dev",
      cwd: ".",
      envNames: ["OPENROUTER_API_KEY", "TAVILY_API_KEY"],
      envMode: "inherit",
    },
    requestedAt: "2026-08-27T12:00:00.000Z",
    expiresAt: "2026-08-27T12:05:00.000Z",
    presentation: { title: "Run command" },
  },
} as const;

test("canonical hosted approval preserves exact exec_command scope", () => {
  assert.deepEqual(parseRunnerHostedToolApprovalInteractionV4(canonical), canonical);
  assert.deepEqual(parseRunnerInteractionRequest(canonical), canonical);
});

test("legacy approval envelopes are rejected by the canonical parser", () => {
  assert.throws(
    () => parseRunnerInteractionRequest({ ...canonical, version: "runner_hosted_tool_approval_interaction_v3" }),
    /legacy hosted tool approval/u,
  );
  assert.throws(
    () => parseRunnerInteractionRequest({
      version: "v1",
      kind: "approval",
      eventType: "user.approval",
      prompt: "Approve?",
      approval: { toolCallId: "call-1", toolName: "exec_command", input: {} },
    }),
    /cannot represent tool approval/u,
  );
});
