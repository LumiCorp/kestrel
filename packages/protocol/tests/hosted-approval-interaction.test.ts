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
  prompt: "Approve hosted.tool?",
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
    presentation: { title: "Approve tool" },
  },
} as const;

test("hosted approval interaction V2 is separate from strict V1", () => {
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
});
