import test from "node:test";
import assert from "node:assert/strict";
import type { schema } from "@/lib/knowledge/db";
import { mobileInteractionDto } from "./dto";


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

test("mobile interaction DTO exposes bounded question fields, not raw envelopes", () => {
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

test("sampling approval hides prompts, tools, and provider data", () => {
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
  if (dto.kind !== "approval") assert.fail("expected approval DTO");
  assert.equal(dto.version, "legacy");
  assert.deepEqual(dto.decisions, ["approve", "deny"]);
  assert.doesNotMatch(JSON.stringify(dto), /private|apiKey|secret/iu);
});

test("hosted V2 approval publishes its exact decision vocabulary", () => {
  const dto = mobileInteractionDto(
    {
      id: "runtime-interaction-1",
      requestId: "approval-1",
      source: "runtime",
      kind: "approval",
      prompt: "Approve this exact tool?",
      status: "pending",
      requestEnvelope: {
        version: "runner_hosted_tool_approval_interaction_v2",
      },
      approvalPolicy: {
        projectId: "project-1",
        environmentId: "environment-1",
        appKey: "google-workspace",
        capabilityKey: "calendar.events.create",
        capabilityDisplayName: "Create calendar events",
        environmentApprovalMode: "ask",
        projectApprovalMode: "ask",
        minimumApprovalMode: "auto",
        reasonCode: "environment_policy",
        canEditProject: false,
      },
      createdAt: new Date("2026-07-13T12:00:00.000Z"),
    },
  );
  assert.equal(dto.kind, "approval");
  if (dto.kind !== "approval") assert.fail("expected approval DTO");
  assert.equal(dto.version, "runner_hosted_tool_approval_interaction_v2");
  assert.deepEqual(dto.decisions, ["decline", "approve_once"]);
});

test("hosted V3 approval publishes the remembered decision vocabulary", () => {
  const dto = mobileInteractionDto(
    {
      id: "runtime-interaction-1",
      requestId: "approval-1",
      source: "runtime",
      kind: "approval",
      prompt: "Approve this exact tool?",
      status: "pending",
      requestEnvelope: {
        version: "runner_hosted_tool_approval_interaction_v3",
        approval: {
          presentation: { policy: { reasonCode: "environment_policy" } },
        },
      },
      approvalPolicy: {
        projectId: "project-1",
        environmentId: "environment-1",
        appKey: "google-workspace",
        capabilityKey: "calendar.events.create",
        capabilityDisplayName: "Create calendar events",
        environmentApprovalMode: "ask",
        projectApprovalMode: "ask",
        minimumApprovalMode: "auto",
        reasonCode: "environment_policy",
        canEditProject: false,
      },
      createdAt: new Date("2026-07-13T12:00:00.000Z"),
    },
  );
  assert.equal(dto.kind, "approval");
  if (dto.kind !== "approval") assert.fail("expected approval DTO");
  assert.equal(dto.version, "runner_hosted_tool_approval_interaction_v3");
  assert.deepEqual(dto.decisions, [
    "decline",
    "approve_once",
    "remember_approval",
  ]);
});

test("hosted V3 approval hides remember after current Project policy becomes stricter", () => {
  const dto = mobileInteractionDto(
    {
      id: "runtime-interaction-2",
      requestId: "approval-2",
      source: "runtime",
      kind: "approval",
      prompt: "Approve this exact tool?",
      status: "pending",
      requestEnvelope: {
        version: "runner_hosted_tool_approval_interaction_v3",
        approval: {
          presentation: { policy: { reasonCode: "environment_policy" } },
        },
      },
      approvalPolicy: {
        projectId: "project-1",
        environmentId: "environment-1",
        appKey: "google-workspace",
        capabilityKey: "calendar.events.create",
        capabilityDisplayName: "Create calendar events",
        environmentApprovalMode: "ask",
        projectApprovalMode: "deny",
        minimumApprovalMode: "auto",
        reasonCode: "environment_policy",
        canEditProject: false,
      },
      createdAt: new Date("2026-07-13T12:00:00.000Z"),
    },
  );
  assert.equal(dto.kind, "approval");
  if (dto.kind !== "approval") assert.fail("expected approval DTO");
  assert.deepEqual(dto.decisions, ["decline"]);
});

test("hosted V3 approval hides remember after current Subject policy becomes stricter", () => {
  const dto = mobileInteractionDto({
    id: "runtime-interaction-3",
    requestId: "approval-3",
    source: "runtime",
    kind: "approval",
    prompt: "Approve this exact tool?",
    status: "pending",
    requestEnvelope: {
      version: "runner_hosted_tool_approval_interaction_v3",
      approval: {
        presentation: { policy: { reasonCode: "environment_policy" } },
      },
    },
    approvalPolicy: {
      projectId: "project-1",
      environmentId: "environment-1",
      appKey: "google-workspace",
      capabilityKey: "calendar.events.create",
      capabilityDisplayName: "Create calendar events",
      environmentApprovalMode: "ask",
      projectApprovalMode: "ask",
      minimumApprovalMode: "auto",
      subjectApprovalMode: "ask",
      reasonCode: "environment_policy",
      canEditProject: false,
    },
    createdAt: new Date("2026-07-13T12:00:00.000Z"),
  });
  assert.equal(dto.kind, "approval");
  if (dto.kind !== "approval") assert.fail("expected approval DTO");
  assert.deepEqual(dto.decisions, ["decline", "approve_once"]);
});

test("closed hosted approvals advertise no Mobile decisions", () => {
  const dto = mobileInteractionDto({
    id: "runtime-interaction-4",
    requestId: "approval-4",
    source: "runtime",
    kind: "approval",
    prompt: "Approve this exact tool?",
    status: "failed",
    requestEnvelope: {
      version: "runner_hosted_tool_approval_interaction_v3",
    },
    createdAt: new Date("2026-07-13T12:00:00.000Z"),
  });
  assert.equal(dto.kind, "approval");
  if (dto.kind !== "approval") assert.fail("expected approval DTO");
  assert.deepEqual(dto.decisions, []);
});

test("hosted approvals bound to a closed resource expose only Decline", () => {
  const dto = mobileInteractionDto({
    id: "runtime-interaction-5",
    requestId: "approval-5",
    source: "runtime",
    kind: "approval",
    prompt: "Approve this exact tool?",
    status: "pending",
    requestEnvelope: {
      version: "runner_hosted_tool_approval_interaction_v3",
      approval: {
        presentation: { policy: { reasonCode: "environment_policy" } },
      },
    },
    approvalPolicy: {
      projectId: "project-1",
      environmentId: "environment-1",
      appKey: "google-workspace",
      capabilityKey: "calendar.events.create",
      capabilityDisplayName: "Create calendar events",
      environmentApprovalMode: "ask",
      projectApprovalMode: "ask",
      minimumApprovalMode: "auto",
      approvalResourceAvailable: false,
      reasonCode: "environment_policy",
      canEditProject: false,
    },
    createdAt: new Date("2026-07-13T12:00:00.000Z"),
  });
  assert.equal(dto.kind, "approval");
  if (dto.kind !== "approval") assert.fail("expected approval DTO");
  assert.deepEqual(dto.decisions, ["decline"]);
});
