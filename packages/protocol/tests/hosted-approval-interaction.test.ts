import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRunnerHostedToolApprovalInteractionV2,
  parseRunnerHostedToolApprovalInteractionV3,
  parseRunnerHostedToolApprovalInteractionV4,
  parseRunnerInteractionRequest,
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

const rememberedInteraction = {
  ...interaction,
  version: "runner_hosted_tool_approval_interaction_v3",
  prompt:
    "Approve hosted.tool? Choose 'decline', 'approve_once', or 'remember_approval'.",
  inputSchema: {
    ...interaction.inputSchema,
    properties: {
      decision: {
        type: "string",
        enum: ["decline", "approve_once", "remember_approval"],
      },
    },
  },
} as const;

const timedRememberedInteraction = {
  ...rememberedInteraction,
  version: "runner_hosted_tool_approval_interaction_v4",
  approval: {
    ...rememberedInteraction.approval,
    requestedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2026-08-26T12:05:00.000Z",
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

test("hosted approval interaction V3 remains metadata-less and byte-stable", () => {
  assert.deepEqual(
    parseRunnerHostedToolApprovalInteractionV3(rememberedInteraction),
    rememberedInteraction,
  );
  assert.deepEqual(
    parseRunnerInteractionRequest(rememberedInteraction),
    rememberedInteraction,
  );
  assert.throws(
    () => parseRunnerHostedToolApprovalInteractionV2(rememberedInteraction),
    /version must be 'runner_hosted_tool_approval_interaction_v2'/u,
  );
  assert.throws(
    () =>
      parseRunnerHostedToolApprovalInteractionV3({
        ...rememberedInteraction,
        inputSchema: interaction.inputSchema,
      }),
    /inputSchema is invalid/u,
  );
});

test("hosted approval interaction V4 requires forward trusted timing and old Web rejects it", () => {
  assert.deepEqual(
    parseRunnerHostedToolApprovalInteractionV4(timedRememberedInteraction),
    timedRememberedInteraction,
  );
  assert.deepEqual(
    parseRunnerInteractionRequest(timedRememberedInteraction),
    timedRememberedInteraction,
  );
  const { requestedAt: _requestedAt, ...missingRequestedAt } =
    timedRememberedInteraction.approval;
  assert.throws(
    () => parseRunnerHostedToolApprovalInteractionV4({
      ...timedRememberedInteraction,
      approval: missingRequestedAt,
    }),
    /approval.requestedAt/u,
  );
  const { expiresAt: _expiresAt, ...missingExpiresAt } =
    timedRememberedInteraction.approval;
  assert.throws(
    () => parseRunnerHostedToolApprovalInteractionV4({
      ...timedRememberedInteraction,
      approval: missingExpiresAt,
    }),
    /approval.expiresAt/u,
  );
  assert.throws(
    () => parseRunnerHostedToolApprovalInteractionV4({
      ...timedRememberedInteraction,
      approval: {
        ...timedRememberedInteraction.approval,
        requestedAt: "not-a-timestamp",
      },
    }),
    /approval.requestedAt/u,
  );
  assert.throws(
    () => parseRunnerHostedToolApprovalInteractionV4({
      ...timedRememberedInteraction,
      approval: {
        ...timedRememberedInteraction.approval,
        expiresAt: timedRememberedInteraction.approval.requestedAt,
      },
    }),
    /expiresAt must be after/u,
  );
  assert.throws(
    () => parseRunnerHostedToolApprovalInteractionV3(timedRememberedInteraction),
    /version must be 'runner_hosted_tool_approval_interaction_v3'/u,
  );
});

test("hosted approval interaction V3 advertises exactly its schema decisions", () => {
  const parsed = parseRunnerHostedToolApprovalInteractionV3(
    rememberedInteraction,
  );
  const advertised = [
    ...parsed.prompt.matchAll(
      /'(approve_once|decline|remember_approval)'/gu,
    ),
  ]
    .map((match) => match[1])
    .sort();
  const accepted = [...parsed.inputSchema.properties.decision.enum].sort();

  assert.deepEqual(advertised, accepted);
  assert.deepEqual(accepted, [
    "approve_once",
    "decline",
    "remember_approval",
  ]);
  assert.doesNotMatch(parsed.prompt, /'approve'|'deny'/u);
});
