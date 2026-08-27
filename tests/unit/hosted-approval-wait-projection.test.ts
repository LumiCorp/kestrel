import assert from "node:assert/strict";
import test from "node:test";

import { toRuntimeWaitMatcher } from "../../src/engine/ExecutionEngineSupport.js";
import { WaitResumeCoordinator } from "../../src/engine/WaitResumeCoordinator.js";
import type { RuntimeInteractionRequest } from "../../src/kestrel/contracts/execution.js";

const interaction = {
  version: "runner_hosted_tool_approval_interaction_v4",
  requestId: "approval-request-1",
  kind: "approval",
  eventType: "user.approval",
  prompt: "Approve the prepared command?",
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
    preparedInvocationId: "prepared-invocation-1",
    toolName: "exec_command",
    stableToolIdentity: {
      version: "stable_tool_approval_identity_v1",
      toolId: "exec_command",
      descriptorContractRevision: `sha256:${"a".repeat(64)}`,
      approvalAuthorityRevision: "authority-1",
    },
    requestingActor: {
      actorId: "user-1",
      actorType: "end_user",
      tenantId: "organization-1",
    },
    rememberedApprovalScope: {
      kind: "exec_command_exact",
      command: "pnpm run something",
      cwd: ".",
      envNames: [],
      envMode: "inherit",
    },
    requestedAt: "2026-08-27T12:00:00.000Z",
    expiresAt: "2026-08-27T12:05:00.000Z",
  },
} as RuntimeInteractionRequest;

const waitFor = {
  kind: "approval" as const,
  eventType: "user.approval",
  metadata: { reason: "environment_policy" },
  interaction,
};

test("runtime wait projection preserves the canonical hosted approval interaction", () => {
  const projected = toRuntimeWaitMatcher(waitFor);

  assert.deepEqual(projected?.interaction, interaction);
});

test("wait coordinator persists the canonical hosted approval interaction", () => {
  const coordinator = new WaitResumeCoordinator({
    appendRunEvent: async () => undefined,
  });

  const waitingFor = coordinator.buildWaitingForFromTransition({
    waitFor,
    resumeStepAgent: "agent.exec.wait_approval",
  });

  assert.deepEqual(waitingFor?.interaction, interaction);
});
