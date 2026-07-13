import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelHistoryWindow,
  normalizeSubmittedHistory,
} from "../../src/runtime/submittedHistory.js";
import { mergeSubmittedHistoryMetadata } from "../../src/orchestration/TurnOrchestrator.js";

test("normalizeSubmittedHistory keeps conversation rows and drops UI-only rows", () => {
  const history = normalizeSubmittedHistory([
    {
      role: "system",
      text: "Run failed [RUNTIME_ERROR]: old status row",
      timestamp: "2026-05-13T12:00:00.000Z",
    },
    {
      role: "system",
      text: "Would you like me to proceed?",
      timestamp: "2026-05-13T12:00:30.000Z",
      data: { kind: "runtime.waiting_prompt", runId: " run-waiting " },
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
      { role: "system", text: "Would you like me to proceed?" },
      { role: "user", text: "fix the app" },
      { role: "assistant", text: "I need the project path." },
    ],
  );
});

test("tagged runtime waiting prompts survive repeated history normalization", () => {
  const initial = [
    {
      role: "user",
      text: "Build the app",
      timestamp: "2026-05-13T12:00:00.000Z",
    },
    {
      role: "system",
      text: "Would you like me to begin implementation?",
      timestamp: "2026-05-13T12:01:00.000Z",
      data: { kind: "runtime.waiting_prompt", runId: " run-waiting " },
    },
    {
      role: "user",
      text: "Yes",
      timestamp: "2026-05-13T12:02:00.000Z",
    },
  ];

  const once = normalizeSubmittedHistory(initial);
  const twice = normalizeSubmittedHistory(once);

  assert.deepEqual(twice, once);
  assert.deepEqual(buildModelHistoryWindow(twice), once);
  assert.deepEqual(twice?.[1], {
    role: "system",
    text: "Would you like me to begin implementation?",
    timestamp: "2026-05-13T12:01:00.000Z",
    data: { kind: "runtime.waiting_prompt", runId: "run-waiting" },
  });
});

test("submitted waiting prompt echoes reuse runtime identity and canonical placement", () => {
  const merged = mergeSubmittedHistoryMetadata(
    {
      history: [{
        role: "system",
        text: "Which workspace should I inspect?",
        timestamp: "2026-05-13T12:01:00.000Z",
        data: { kind: "runtime.waiting_prompt", runId: "run-waiting" },
      }],
    },
    {
      history: [
        {
          role: "user",
          text: "Inspect the workspace",
          timestamp: "2026-05-13T12:00:00.000Z",
        },
        {
          role: "system",
          text: "Which workspace should I inspect?",
          timestamp: "2026-05-13T12:01:00.250Z",
          data: { kind: "runtime.waiting_prompt", runId: "run-waiting" },
        },
      ],
    },
  );

  assert.deepEqual(merged?.history, [
    {
      role: "user",
      text: "Inspect the workspace",
      timestamp: "2026-05-13T12:00:00.000Z",
    },
    {
      role: "system",
      text: "Which workspace should I inspect?",
      timestamp: "2026-05-13T12:01:00.000Z",
      data: { kind: "runtime.waiting_prompt", runId: "run-waiting" },
    },
  ]);
});

test("identical waiting prompt text from different runs remains distinct", () => {
  const merged = mergeSubmittedHistoryMetadata(
    {
      history: [{
        role: "system",
        text: "Should I continue?",
        timestamp: "2026-05-13T12:01:00.000Z",
        data: { kind: "runtime.waiting_prompt", runId: "run-one" },
      }],
    },
    {
      history: [{
        role: "system",
        text: "Should I continue?",
        timestamp: "2026-05-13T12:02:00.000Z",
        data: { kind: "runtime.waiting_prompt", runId: "run-two" },
      }],
    },
  );

  assert.deepEqual(
    (merged?.history as Array<{ data?: { runId?: string } }>).map((line) => line.data?.runId),
    ["run-one", "run-two"],
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
