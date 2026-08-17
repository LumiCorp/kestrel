import test from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import {
  applySubmittedToolApproval,
  findSubmittedToolApproval,
} from "./tool-approval-response";


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
  const submittedApproval = findSubmittedToolApproval([submitted]);
  assert.ok(submittedApproval);
  const response = applySubmittedToolApproval({
    submittedApproval,
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
  const replay = applySubmittedToolApproval({
    submittedApproval,
    persistedMessages: [submitted],
  });
  assert.deepEqual(replay?.assistantMessage, submitted);
  assert.equal(replay?.approvalId, "approval-1");
  assert.equal(replay?.approved, true);
  assert.equal(
    applySubmittedToolApproval({
      submittedApproval: { ...submittedApproval, approved: false },
      persistedMessages: [submitted],
    }),
    null
  );
});

test(
  "compact approval submissions retain only decision identity",
  () => {
    const responded = message(
      "approval-responded",
      {
        id: "approval-1",
        approved: false,
      },
      Array.from({ length: 238 }, (_, index) => ({
        type: "data-kestrel-progress",
        id: `progress-${index}`,
        data: { message: `Step ${index}` },
      }))
    );
    const submittedApproval = findSubmittedToolApproval([responded]);

    assert.deepEqual(submittedApproval, {
      messageId: "assistant-1",
      approvalId: "approval-1",
      approved: false,
    });
    assert.equal(
      applySubmittedToolApproval({
        submittedApproval: {
          messageId: "another-assistant",
          approvalId: "approval-1",
          approved: false,
        },
        persistedMessages: [
          message("approval-requested", { id: "approval-1" }),
        ],
      }),
      null
    );
  }
);

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
