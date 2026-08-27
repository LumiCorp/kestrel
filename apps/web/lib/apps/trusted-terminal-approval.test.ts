import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
  RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
  serializeCanonicalApprovalPayload,
} from "@kestrel-agents/protocol";
import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";
import { parseHostedMutation } from "./hosted-app-operation-contract";
import {
  parseTrustedTerminalApproval,
  readTrustedTerminalApprovalToolName,
  TrustedTerminalApprovalError,
} from "./trusted-terminal-approval";

test("approval tool-name classification is available before strict hosted parsing", () => {
  const event = waitingEvent();
  assert.equal(
    readTrustedTerminalApprovalToolName(event),
    "kestrel_one.email_send",
  );
});

test("trusted terminal approval preserves request, runtime approval, and runner run identities", () => {
  const event = waitingEvent();
  const parsed = parseTrustedTerminalApproval({ event, threadId: "thread-1" });
  assert.equal(parsed?.requestId, "request-v2");
  assert.equal(parsed?.runtimeApprovalId, "request-v2");
  assert.equal(parsed?.runId, "run-1");
  assert.deepEqual(parsed?.toolInput, emailInput());
});

test("trusted terminal approval accepts the canonical V2 prepared invocation", () => {
  const event = waitingV2Event();
  const parsed = parseTrustedTerminalApproval({ event, threadId: "thread-1" });
  assert.equal(parsed?.requestId, "request-v2");
  assert.equal(parsed?.runtimeApprovalId, "request-v2");
  assert.equal(parsed?.runId, "run-1");
  assert.equal(
    parsed?.externalBinding.version,
    RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
  );
  assert.deepEqual(parsed?.toolInput, emailInput());
});

test("trusted terminal approval rejects a V2 card detached from its prepared invocation", () => {
  const event = waitingV2Event();
  if (event.type !== "run.completed") assert.fail("expected terminal event");
  const metadata = event.payload.result.output.waitFor?.metadata as Record<
    string,
    unknown
  >;
  const prepared = metadata.preparedToolCall as Record<string, unknown>;
  prepared.callId = "prepared-other";
  assert.throws(
    () => parseTrustedTerminalApproval({ event, threadId: "thread-1" }),
    (error) =>
      error instanceof TrustedTerminalApprovalError &&
      error.code === "HOSTED_APPROVAL_TERMINAL_BINDING_MISMATCH",
  );
});

test("trusted terminal approval rejects every cross-identity and payload mismatch", () => {
  for (const mutate of [
    (event: RunnerRunTerminalEvent) => { event.runId = "run-other"; },
    (event: RunnerRunTerminalEvent) => { event.threadId = "thread-other"; },
    (event: RunnerRunTerminalEvent) => {
      const wait = event.type === "run.completed" ? event.payload.result.output.waitFor! : null;
      (wait!.metadata as Record<string, unknown>).approvalId = "approval-other";
    },
    (event: RunnerRunTerminalEvent) => {
      const wait = event.type === "run.completed" ? event.payload.result.output.waitFor! : null;
      const metadata = wait!.metadata as Record<string, unknown>;
      (metadata.externalApprovalBinding as Record<string, unknown>).approvalId =
        "approval-other";
    },
    (event: RunnerRunTerminalEvent) => {
      const wait = event.type === "run.completed" ? event.payload.result.output.waitFor! : null;
      (wait!.metadata as Record<string, unknown>).toolInput = { ...emailInput(), subject: "changed" };
    },
  ]) {
    const event = waitingEvent();
    mutate(event);
    assert.throws(
      () => parseTrustedTerminalApproval({ event, threadId: "thread-1" }),
      (error) =>
        error instanceof TrustedTerminalApprovalError &&
        error.code === "HOSTED_APPROVAL_TERMINAL_BINDING_MISMATCH",
    );
  }
});

test("hosted mutation registry normalizes all named provider payloads", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["kestrel_one.email_send", emailInput(), "email.send"],
    ["kestrel_one.github_issue_create", { repository: "acme/widgets", title: "Issue" }, "issue.create"],
    ["kestrel_one.github_pull_request_create", { repository: "acme/widgets", title: "PR", head: "feature", base: "main" }, "pull_request.create"],
    ["kestrel_one.github_pull_request_merge", { repository: "acme/widgets", pullNumber: 1 }, "pull_request.merge"],
    ["kestrel_one.github_release_create", { repository: "acme/widgets", tagName: "v1" }, "release.create"],
    ["kestrel_one.github_workflow_dispatch", { repository: "acme/widgets", workflowId: "deploy.yml", ref: "main" }, "workflow.dispatch"],
    ["kestrel_one.google_calendar_create_event", { event: { summary: "Meet", start: { dateTime: "2026-08-25T14:00:00Z" }, end: { dateTime: "2026-08-25T15:00:00Z" } } }, "events.create"],
    ["kestrel_one.google_calendar_update_event", { eventId: "event-1", patch: { summary: "Updated" } }, "events.update"],
    ["kestrel_one.google_calendar_delete_event", { eventId: "event-1" }, "events.delete"],
    ["kestrel_one.microsoft_365_send_mail", { to: ["a@example.com"], subject: "Hi", body: "Body" }, "mail.send"],
    ["kestrel_one.microsoft_365_send_chat_message", { chatId: "chat-1", content: "Hello" }, "chat.send"],
  ];
  for (const [toolName, input, operation] of cases) {
    assert.equal(parseHostedMutation(toolName, input)?.operationKey, operation);
  }
});

function waitingEvent(): RunnerRunTerminalEvent {
  return waitingV2Event();
}

function waitingV2Event(): RunnerRunTerminalEvent {
  const toolInput = emailInput();
  const approvalId = "request-v2";
  const preparedInvocationId = "prepared-v2";
  const toolName = "kestrel_one.email_send";
  const now = Date.now();
  const stableToolIdentity = {
    version: "stable_tool_approval_identity_v1" as const,
    toolId: toolName,
    descriptorContractRevision: `sha256:${"b".repeat(64)}`,
    approvalAuthorityRevision: "approval-authority-v2",
  };
  const stableAuthorityFingerprint = `sha256:${"c".repeat(64)}`;
  const binding = {
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
    approvalId,
    preparedInvocationId,
    threadId: "thread-1",
    actionKey: toolName,
    payloadHash: `sha256:${createHash("sha256").update(serializeCanonicalApprovalPayload(toolInput)).digest("hex")}`,
    stableAuthorityFingerprint,
    stableToolIdentity,
    requestingActor: {
      actorType: "end_user" as const,
      actorId: "user-1",
      tenantId: "org-1",
    },
    toolClass: "external_side_effect" as const,
    capabilities: ["external.confirm", "network.call"],
    authorityKind: "runtime_policy" as const,
    authorityRevision: "approval-authority-v2",
    requestedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const preparedToolCall = {
    callId: preparedInvocationId,
    runId: "run-1",
    effectiveInput: toolInput,
    stableAuthority: { fingerprint: stableAuthorityFingerprint },
    stableToolIdentity,
    approval: { externalApprovalBinding: binding },
  };
  return {
    id: "event-v2",
    type: "run.completed",
    ts: new Date(now).toISOString(),
    runId: "run-1",
    sessionId: "session-1",
    threadId: "thread-1",
    payload: {
      result: {
        assistantText: "Approve send?",
        output: {
          status: "WAITING",
          sessionId: "session-1",
          runId: "run-1",
          errors: [],
          waitFor: {
            kind: "approval",
            eventType: "user.approval",
            interaction: {
              version: "runner_hosted_tool_approval_interaction_v4",
              requestId: approvalId,
              kind: "approval",
              eventType: "user.approval",
              prompt: "Approve send?",
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
                preparedInvocationId,
                toolName,
                stableToolIdentity,
                requestingActor: binding.requestingActor,
                rememberedApprovalScope: { kind: "tool_identity" },
                requestedAt: binding.requestedAt,
                expiresAt: binding.expiresAt,
                presentation: { title: "Approve send?" },
              },
            },
            metadata: {
              approvalId,
              toolName,
              toolInput,
              externalApprovalBinding: binding,
              preparedToolCall,
            },
          },
        },
      },
    },
  };
}

function emailInput() {
  return { to: ["person@example.com"], subject: "Hello", text: "Body" };
}
