import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
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
  assert.equal(parsed?.requestId, "request-1");
  assert.equal(parsed?.runtimeApprovalId, "run-1:0:approval");
  assert.equal(parsed?.runId, "run-1");
  assert.deepEqual(parsed?.toolInput, emailInput());
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
  const toolInput = emailInput();
  const approvalId = "run-1:0:approval";
  const toolName = "kestrel_one.email_send";
  const now = Date.now();
  const binding = {
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
    approvalId,
    threadId: "thread-1",
    runId: "run-1",
    actionKey: toolName,
    payloadHash: `sha256:${createHash("sha256").update(serializeCanonicalApprovalPayload(toolInput)).digest("hex")}`,
    toolClass: "external_side_effect" as const,
    capabilities: ["external.confirm", "network.call"],
    authorityKind: "runtime_policy" as const,
    authorityRevision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    requestedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  return {
    id: "event-1",
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
              version: "v1",
              requestId: "request-1",
              kind: "approval",
              eventType: "user.approval",
              prompt: "Approve send?",
              approval: { toolCallId: approvalId, toolName },
            },
            metadata: {
              approvalId,
              toolName,
              toolInput,
              externalApprovalBinding: binding,
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
