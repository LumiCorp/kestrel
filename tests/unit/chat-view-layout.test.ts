import test from "node:test";
import assert from "node:assert/strict";

import { resolveChatLayout } from "../../cli/ink/views/ChatView.js";
import { resolveChatActivityRows, resolveChatComposerInputRows, resolveChatLayoutBudget } from "../../cli/ink/views/chatLayout.js";
import { buildChatVisualRows, buildTranscriptStartScroll } from "../../cli/ink/views/chatRows.js";


test("resolveChatLayout keeps bubble width aligned with wrapped conversation width", () => {
  const compact = resolveChatLayout(80);
  assert.equal(compact.bubbleWidth, compact.conversationWidth);

  const wide = resolveChatLayout(160);
  assert.equal(wide.bubbleWidth, wide.conversationWidth);
  assert.equal(wide.conversationWidth > compact.conversationWidth, true);
});

test("buildTranscriptStartScroll pins the selected transcript to the top of the viewport", () => {
  const rows = buildChatVisualRows(
    [
      {
        role: "user",
        text: "short prompt",
        timestamp: "2026-03-14T13:00:00.000Z",
      },
      {
        role: "assistant",
        text: "a much longer assistant reply that should wrap across multiple rows in the chat view",
        timestamp: "2026-03-14T13:00:01.000Z",
      },
    ],
    36,
  );

  const scroll = buildTranscriptStartScroll({
    rows,
    transcriptIndex: 1,
    listRows: 4,
  });

  assert.equal(scroll?.cursor, 1);
  assert.equal(scroll?.offset, 1);
  assert.equal(scroll?.tailLocked, false);
});

test("shared chat layout budget keeps ChatView layout in sync with controller math", () => {
  const view = resolveChatLayout(120);
  const budget = resolveChatLayoutBudget({
    viewportColumns: 120,
    viewportRows: 40,
    detailDrawerOpen: false,
  });

  assert.equal(view.conversationWidth, budget.conversationWidth);
  assert.equal(view.bubbleWidth, budget.bubbleWidth);
  assert.equal(budget.wrappedBodyWidth > 0, true);
  assert.equal(budget.transcriptRows > 0, true);
});

test("composer input rows are not capped below available viewport space", () => {
  const rows = resolveChatComposerInputRows({
    draft: Array.from({ length: 12 }, (_, index) => `draft line ${index + 1}`).join("\n"),
    inputWidth: 80,
    viewportRows: 40,
    detailDrawerOpen: false,
  });

  assert.equal(rows, 12);
});

test("controller and Ink reserve the same capped rows for shared conversation activity", () => {
  const activity = Array.from({ length: 5 }, (_, index) => ({
    id: `activity-${index}`,
    kind: "agent_progress" as const,
    label: "Agent progress",
    text: `step ${index}`,
    timestamp: "2026-08-17T10:00:00.000Z",
    status: "active" as const,
    runId: "run-1",
    sourceEventId: `event-${index}`,
  }));
  assert.equal(resolveChatActivityRows(activity), 3);
  assert.equal(resolveChatActivityRows([...activity, { ...activity[0]!, id: "hidden", visible: false }]), 3);
});
