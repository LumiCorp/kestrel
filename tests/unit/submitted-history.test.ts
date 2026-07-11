import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelHistoryWindow,
  normalizeSubmittedHistory,
} from "../../src/runtime/submittedHistory.js";

test("normalizeSubmittedHistory keeps conversation rows and drops UI-only rows", () => {
  const history = normalizeSubmittedHistory([
    {
      role: "system",
      text: "Run failed [RUNTIME_ERROR]: old status row",
      timestamp: "2026-05-13T12:00:00.000Z",
    },
    {
      role: "user",
      text: "fix the app",
      timestamp: "2026-05-13T12:01:00.000Z",
    },
    {
      role: "assistant",
      text: "I am checking the repo.",
      timestamp: "2026-05-13T12:02:00.000Z",
      data: {
        reasoning: true,
      },
    },
    {
      role: "assistant",
      text: "I need the project path.",
      timestamp: "2026-05-13T12:03:00.000Z",
    },
    {
      role: "assistant",
      timestamp: "2026-05-13T12:04:00.000Z",
    },
  ]);

  assert.deepEqual(
    history?.map((line) => ({ role: line.role, text: line.text })),
    [
      { role: "user", text: "fix the app" },
      { role: "assistant", text: "I need the project path." },
    ],
  );
});

test("normalizeSubmittedHistory preserves attachments on retained rows", () => {
  const attachments = [
    {
      kind: "image",
      attachmentId: "attachment-1",
    },
  ];

  const history = normalizeSubmittedHistory([
    {
      role: "user",
      text: "inspect this screenshot",
      timestamp: "2026-05-13T12:01:00.000Z",
      attachments,
    },
  ]);

  assert.equal(history?.[0]?.attachments, attachments);
});

test("normalizeSubmittedHistory clamps while preserving the first user task", () => {
  const history = normalizeSubmittedHistory([
    {
      role: "user",
      text: "original task",
      timestamp: "2026-05-13T12:00:00.000Z",
    },
    ...Array.from({ length: 70 }, (_, index) => ({
      role: index % 2 === 0 ? "assistant" : "user",
      text: `line-${index}`,
      timestamp: new Date(Date.UTC(2026, 4, 13, 12, index + 1, 0)).toISOString(),
    })),
  ]);

  assert.equal(history?.length, 64);
  assert.equal(history?.[0]?.text, "original task");
  assert.equal(history?.[1]?.text, "line-7");
  assert.equal(history?.[63]?.text, "line-69");
});

test("buildModelHistoryWindow normalizes CLI/TUI and Web/Desktop history identically", () => {
  const attachments = [
    {
      kind: "image",
      attachmentId: "attachment-1",
      filename: "screen.png",
      mimeType: "image/png",
      sizeBytes: 100,
      sha256: "abc123",
    },
  ];
  const mixedHistory = [
    {
      role: "system",
      text: "UI status row",
      timestamp: "2026-05-13T12:00:00.000Z",
    },
    {
      role: "user",
      text: "original task",
      timestamp: "Wed May 13 2026 08:01:00 GMT-0400 (Eastern Daylight Time)",
      attachments,
    },
    {
      role: "assistant",
      text: "reasoning row",
      timestamp: "2026-05-13T12:02:00.000Z",
      data: {
        reasoning: true,
      },
    },
    ...Array.from({ length: 70 }, (_, index) => ({
      role: index % 2 === 0 ? "assistant" : "user",
      text: `line-${index}`,
      timestamp: new Date(Date.UTC(2026, 4, 13, 12, index + 3, 0)).toISOString(),
    })),
  ];

  assert.deepEqual(
    buildModelHistoryWindow(mixedHistory),
    normalizeSubmittedHistory(mixedHistory),
  );
  const history = buildModelHistoryWindow(mixedHistory);
  assert.equal(history.length, 64);
  assert.equal(history[0]?.role, "user");
  assert.equal(history[0]?.text, "original task");
  assert.equal(history[0]?.timestamp, "2026-05-13T12:01:00.000Z");
  assert.equal(history[0]?.attachments, attachments);
});
