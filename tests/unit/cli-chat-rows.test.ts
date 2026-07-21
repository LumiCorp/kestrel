import assert from "node:assert/strict";

import type { TranscriptLine } from "../../cli/contracts.js";
import {
  buildAnchoredAppendScroll,
  buildChatVisualRows,
  buildChatWindow,
  deriveChatContentWidth,
  ensureChatCursorVisible,
  countRenderedChatRows,
  resolveChatVisualAnchor,
  resolveChatVisualCursorFromAnchor,
  wrapTextToWidth,
} from "../../cli/ink/views/chatRows.js";
import { resolveChatLayoutBudget } from "../../cli/ink/views/chatLayout.js";
import { contractTest } from "../helpers/contract-test.js";


function line(input: {
  role: TranscriptLine["role"];
  text: string;
  data?: Record<string, unknown> | undefined;
  timestamp?: string;
}): TranscriptLine {
  return {
    role: input.role,
    text: input.text,
    ...(input.data === undefined ? {} : { data: input.data }),
    timestamp: input.timestamp ?? "2026-03-05T12:00:00.000Z",
  };
}

contractTest("runtime.hermetic", "deriveChatContentWidth enforces minimum width", () => {
  assert.equal(deriveChatContentWidth(20), 24);
  assert.equal(deriveChatContentWidth(80), 70);
});

contractTest("runtime.hermetic", "wrapTextToWidth wraps by whitespace when practical", () => {
  const wrapped = wrapTextToWidth("alpha beta gamma delta", 10);
  assert.deepEqual(wrapped, ["alpha", "beta gamma", "delta"]);
});

contractTest("runtime.hermetic", "wrapTextToWidth hard-wraps long tokens and preserves explicit newlines", () => {
  const wrapped = wrapTextToWidth("supercalifragilistic\nok", 6);
  assert.deepEqual(wrapped, ["superc", "alifra", "gilist", "ic", "ok"]);
});

contractTest("runtime.hermetic", "buildChatVisualRows emits continuation rows with transcript mapping", () => {
  const transcript = [
    line({ role: "assistant", text: "hello world from kestrel with a much longer sentence" }),
    line({ role: "user", text: "short" }),
  ];
  const rows = buildChatVisualRows(transcript, 28);

  assert.equal(rows.length >= 3, true);
  assert.equal(rows[0]?.transcriptIndex, 0);
  assert.equal(rows[0]?.wrappedLineIndex, 0);
  assert.equal(rows[0]?.isFirstLine, true);
  assert.equal(rows[1]?.transcriptIndex, 0);
  assert.equal(rows[1]?.isFirstLine, false);
  assert.equal(rows[rows.length - 1]?.transcriptIndex, 1);
  assert.equal(rows[rows.length - 1]?.isFirstLine, true);
});

contractTest("runtime.hermetic", "buildChatVisualRows marks user-reply waits for attention styling", () => {
  const rows = buildChatVisualRows(
    [
      line({
        role: "system",
        text: "Waiting for your reply.\nWhich workspace should I inspect?",
        data: {
          waitEventType: "user.reply",
          prompt: "Which workspace should I inspect?",
        },
      }),
    ],
    80,
  );

  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.attention), true);
});

contractTest("runtime.hermetic", "countRenderedChatRows includes per-message header and spacer rows", () => {
  const rows = buildChatVisualRows(
    [
      line({ role: "assistant", text: "alpha beta gamma delta epsilon" }),
      line({ role: "user", text: "short" }),
    ],
    18,
  );

  assert.equal(countRenderedChatRows(rows), rows.length + 5);
});

contractTest("runtime.hermetic", "anchor helpers restore nearest visual row after rewrap", () => {
  const transcript = [
    line({ role: "assistant", text: "one two three four five six seven" }),
  ];
  const wide = buildChatVisualRows(transcript, 44);
  const narrow = buildChatVisualRows(transcript, 30);

  const anchor = resolveChatVisualAnchor(wide, 1);
  const cursor = resolveChatVisualCursorFromAnchor(narrow, anchor);

  assert.equal(anchor?.transcriptIndex, 0);
  assert.equal(typeof cursor, "number");
  assert.equal(cursor >= 0 && cursor < narrow.length, true);
});

contractTest("runtime.hermetic", "buildAnchoredAppendScroll pins the prior tail row to the top of the viewport", () => {
  const scroll = buildAnchoredAppendScroll({
    previousVisualCount: 9,
    droppedVisualCount: 0,
    nextVisualCount: 13,
    listRows: 4,
  });

  assert.deepEqual(scroll, {
    offset: 8,
    cursor: 8,
    tailLocked: false,
  });
});

contractTest("runtime.hermetic", "buildAnchoredAppendScroll accounts for trimmed history before anchoring", () => {
  const scroll = buildAnchoredAppendScroll({
    previousVisualCount: 12,
    droppedVisualCount: 5,
    nextVisualCount: 11,
    listRows: 5,
  });

  assert.deepEqual(scroll, {
    offset: 6,
    cursor: 6,
    tailLocked: false,
  });
});

contractTest("runtime.hermetic", "ensureChatCursorVisible advances offset when bubble headers would clip the tail", () => {
  const rows = buildChatVisualRows(
    [
      line({ role: "user", text: "short opener" }),
      line({
        role: "assistant",
        text: "one two three four five six seven eight nine ten eleven twelve",
      }),
    ],
    26,
  );

  const next = ensureChatCursorVisible(
    rows,
    {
      offset: 0,
      cursor: rows.length - 1,
      tailLocked: true,
    },
    6,
  );

  assert.equal(next.cursor, rows.length - 1);
  assert.equal(next.offset > 0, true);
});

contractTest("runtime.hermetic", "buildChatWindow fits the selected slice into the available rendered rows", () => {
  const rows = buildChatVisualRows(
    [
      line({ role: "user", text: "short opener" }),
      line({
        role: "assistant",
        text: "one two three four five six seven eight nine ten eleven twelve",
      }),
    ],
    26,
  );

  const windowed = buildChatWindow(
    rows,
    {
      offset: 0,
      cursor: rows.length - 1,
      tailLocked: true,
    },
    6,
  );

  assert.equal(windowed.start > 0, true);
  assert.equal(windowed.end, rows.length);
  assert.equal(countRenderedChatRows(windowed.items) <= 6, true);
  assert.equal(windowed.items.every((row) => row.transcriptIndex === 1), true);
});

contractTest("runtime.hermetic", "shared wrapped width keeps long assistant tails fully visible in constrained viewport", () => {
  const transcript = [
    line({ role: "user", text: "please summarize this with strong detail and no omissions" }),
    line({
      role: "assistant",
      text:
        "This assistant reply intentionally includes many medium-length tokens so row wrapping depends on the exact body width and not only raw viewport columns. " +
        "The visible tail should always include the final wrapped line when tail-locked.",
    }),
  ];
  const layout = resolveChatLayoutBudget({
    viewportColumns: 84,
    viewportRows: 22,
    detailDrawerOpen: false,
  });

  const legacyRows = buildChatVisualRows(transcript, 84);
  const wrappedRows = buildChatVisualRows(transcript, layout.wrappedBodyWidth);
  assert.equal(wrappedRows.length > legacyRows.length, true);

  const windowed = buildChatWindow(
    wrappedRows,
    {
      offset: 0,
      cursor: wrappedRows.length - 1,
      tailLocked: true,
    },
    layout.transcriptRows,
  );

  assert.equal(windowed.end, wrappedRows.length);
  assert.equal(windowed.scroll.cursor, wrappedRows.length - 1);
  assert.equal(countRenderedChatRows(windowed.items) <= layout.transcriptRows, true);
});
