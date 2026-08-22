import assert from "node:assert/strict";
import test from "node:test";
import { presentToolActivity } from "./tool-activity-presentation";

test("tool activity collapses lifecycle events into one user-facing row", () => {
  assert.deepEqual(
    presentToolActivity([
      {
        toolCallId: "news-1",
        toolName: "internet.news",
        displayName: "Internet News",
        phase: "started",
        sequence: 10,
      },
      {
        toolCallId: "news-1",
        toolName: "internet.news",
        displayName: "Internet News",
        phase: "completed",
        sequence: 12,
      },
    ]),
    [
      {
        toolCallId: "news-1",
        label: "Internet News",
        phase: "completed",
      },
    ],
  );
});

test("tool activity excludes the internal finalization control", () => {
  assert.deepEqual(
    presentToolActivity([
      {
        toolCallId: "final-1",
        toolName: "FinalizeAnswer",
        displayName: "Finalize Answer",
        phase: "completed",
        sequence: 20,
      },
    ]),
    [],
  );
});
