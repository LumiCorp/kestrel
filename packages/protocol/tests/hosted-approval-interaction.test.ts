import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRunnerHostedToolApprovalInteractionV2,
  parseRunnerInteractionRequestV1,
} from "../src/index.js";

const interaction = {
  version: "runner_hosted_tool_approval_interaction_v2",
  requestId: "approval-1",
  kind: "approval",
  eventType: "user.approval",
  prompt: "Approve hosted.tool? Reply with decision 'approve_once' or 'decline'.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["decision"],
    properties: {
      decision: { type: "string", enum: ["decline", "approve_once"] },
    },
  },
  approval: {
    preparedInvocationId: "prepared-1",
    toolName: "hosted.tool",
    stableToolIdentity: {
      version: "stable_tool_approval_identity_v1",
      toolId: "hosted.tool",
      descriptorContractRevision: `sha256:${"a".repeat(64)}`,
      approvalAuthorityRevision: "approval-authority-v1",
    },
    requestingActor: {
      actorType: "end_user",
      actorId: "user-1",
      tenantId: "org-1",
    },
    presentation: { title: "Approve tool" },
  },
} as const;

test("hosted approval interaction V2 is separate from strict V1", () => {
  const {
    requestingActor: _requestingActor,
    ...approvalWithoutRequestingActor
  } = interaction.approval;
  assert.deepEqual(
    parseRunnerHostedToolApprovalInteractionV2(interaction),
    interaction,
  );
  assert.throws(
    () => parseRunnerInteractionRequestV1(interaction),
    /version must be 'v1'/u,
  );
  assert.throws(
    () =>
      parseRunnerHostedToolApprovalInteractionV2({
        ...interaction,
        approval: {
          ...interaction.approval,
          toolCallId: "legacy-mixed-id",
        },
      }),
    /toolCallId is not supported/u,
  );
  assert.throws(
    () =>
      parseRunnerHostedToolApprovalInteractionV2({
        ...interaction,
        inputSchema: {
          ...interaction.inputSchema,
          properties: {
            decision: {
              type: "string",
              enum: ["decline", "approve_once", "remember_approval"],
            },
          },
        },
      }),
    /inputSchema is invalid/u,
  );
  assert.throws(
    () =>
      parseRunnerHostedToolApprovalInteractionV2({
        ...interaction,
        approval: {
          ...interaction.approval,
          requestingActor: {
            ...interaction.approval.requestingActor,
            actorId: "",
          },
        },
      }),
    /requestingActor is invalid/u,
  );
  assert.throws(
    () =>
      parseRunnerHostedToolApprovalInteractionV2({
        ...interaction,
        approval: approvalWithoutRequestingActor,
      }),
    /requestingActor is invalid/u,
  );
  assert.throws(
    () =>
      parseRunnerHostedToolApprovalInteractionV2({
        ...interaction,
        inputSchema: {
          ...interaction.inputSchema,
          properties: {
            decision: {
              type: "string",
              enum: ["approve_once", "decline"],
            },
          },
        },
      }),
    /inputSchema is invalid/u,
  );
  assert.throws(
    () =>
      parseRunnerHostedToolApprovalInteractionV2({
        ...interaction,
        inputSchema: {
          ...interaction.inputSchema,
          properties: {
            decision: {
              type: "string",
              enum: ["decline", "decline"],
            },
          },
        },
      }),
    /inputSchema is invalid/u,
  );
  assert.throws(
    () =>
      parseRunnerHostedToolApprovalInteractionV2({
        ...interaction,
        approval: {
          preparedInvocationId: interaction.approval.preparedInvocationId,
          toolName: interaction.approval.toolName,
          presentation: interaction.approval.presentation,
        },
      }),
    /stable tool approval identity/u,
  );
  assert.throws(
    () =>
      parseRunnerHostedToolApprovalInteractionV2({
        ...interaction,
        approval: {
          ...interaction.approval,
          stableToolIdentity: {
            ...interaction.approval.stableToolIdentity,
            toolId: "hosted.other-tool",
          },
        },
      }),
    /stableToolIdentity\.toolId must match/u,
  );
});

test("hosted approval interaction V2 advertises exactly its schema decisions", () => {
  const parsed = parseRunnerHostedToolApprovalInteractionV2(interaction);
  const advertised = [...parsed.prompt.matchAll(/'(approve_once|decline)'/gu)]
    .map((match) => match[1])
    .sort();
  const accepted = [...parsed.inputSchema.properties.decision.enum].sort();

  assert.deepEqual(advertised, accepted);
  assert.deepEqual(accepted, ["approve_once", "decline"]);
  assert.doesNotMatch(parsed.prompt, /remember_approval|'approve'|'deny'/u);
});
