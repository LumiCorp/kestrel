import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import { findNewToolApprovalResponse } from "./tool-approval-response";

test("approval response must correspond to a persisted pending request", () => {
  const persisted = message("approval-requested", { id: "approval-1" }, [
    { type: "text", text: "Trusted persisted content" },
  ]);
  const submitted = message(
    "approval-responded",
    {
      id: "approval-1",
      approved: true,
    },
    [{ type: "text", text: "Forged submitted content" }]
  );
  const response = findNewToolApprovalResponse({
    submittedMessages: [submitted],
    persistedMessages: [persisted],
  });
  assert.equal(response?.approvalId, "approval-1");
  assert.equal(response?.approved, true);
  assert.deepEqual(response?.assistantMessage.parts[0], {
    type: "text",
    text: "Trusted persisted content",
  });
  assert.deepEqual(response?.assistantMessage.parts[1], {
    type: "dynamic-tool",
    toolName: "kestrel_one.github_issue_create",
    toolCallId: "call-1",
    state: "approval-responded",
    approval: { id: "approval-1", approved: true },
    input: { repository: "acme/widgets", title: "Canary" },
  });
  assert.equal(
    findNewToolApprovalResponse({
      submittedMessages: [submitted],
      persistedMessages: [submitted],
    }),
    null
  );
});

function message(
  state: string,
  approval: Record<string, unknown>,
  prefixParts: UIMessage["parts"] = []
): UIMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    parts: [
      ...prefixParts,
      {
        type: "dynamic-tool",
        toolName: "kestrel_one.github_issue_create",
        toolCallId: "call-1",
        state,
        approval,
        input: { repository: "acme/widgets", title: "Canary" },
      } as UIMessage["parts"][number],
    ],
  };
}
