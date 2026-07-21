import assert from "node:assert/strict";
import type { schema } from "@/lib/knowledge/db";
import { mobileInteractionDto } from "./dto";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


type Checkpoint = typeof schema.mcpInteractionCheckpoints.$inferSelect;

function checkpoint(overrides: Partial<Checkpoint>): Checkpoint {
  const now = new Date("2026-07-13T12:00:00.000Z");
  return {
    id: "checkpoint-1",
    invocationId: "invocation-1",
    threadId: "thread-1",
    kind: "elicitation",
    status: "requested",
    requestEnvelope: {},
    responseEnvelope: null,
    replayCursor: {},
    resolvedByUserId: null,
    processingStartedAt: null,
    processingExpiresAt: null,
    failureCode: null,
    failureMessage: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    ...overrides,
  };
}

contractTest("web.hermetic", "mobile interaction DTO exposes bounded question fields, not raw envelopes", () => {
  const dto = mobileInteractionDto(
    checkpoint({
      requestEnvelope: {
        message: "Which region?",
        requestedSchema: {
          properties: {
            region: {
              type: "string",
              title: "Region",
              enum: ["east", "west"],
              secretInternalValue: "must-not-escape",
            },
          },
          required: ["region"],
        },
        runnerCredential: "must-not-escape",
      },
    })
  );
  assert.deepEqual(dto.fields, [
    {
      name: "region",
      label: "Region",
      type: "select",
      required: true,
      options: ["east", "west"],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(dto), /secret|credential/iu);
});

contractTest("web.hermetic", "sampling approval hides prompts, tools, and provider data", () => {
  const dto = mobileInteractionDto(
    checkpoint({
      kind: "sampling",
      requestEnvelope: {
        systemPrompt: "private",
        tools: [{ apiKey: "secret" }],
      },
    })
  );
  assert.equal(dto.kind, "approval");
  assert.doesNotMatch(JSON.stringify(dto), /private|apiKey|secret/iu);
});
