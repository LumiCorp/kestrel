import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRunTurnResult } from "../../cli/runner/finalizedOutput.js";
import type { RunTurnResult } from "../../cli/runtime/KestrelChatRuntime.js";

const output = {
  status: "COMPLETED" as const,
  sessionId: "session-1",
  runId: "run-1",
  errors: [],
  quality: {
    citationCoverage: 1,
    unresolvedClaims: 0,
    reworkRate: 0,
    thrashIndex: 0,
  },
  telemetry: {
    stepsExecuted: 1,
    toolCalls: 0,
    modelCalls: 1,
    durationMs: 1,
  },
};

test("summarizeRunTurnResult preserves an explicit null finalized payload", () => {
  const result: RunTurnResult = {
    assistantText: "done",
    output,
    finalizedPayload: null,
  };

  assert.deepEqual(summarizeRunTurnResult(result), {
    text: "done",
    raw: null,
  });
});

test("summarizeRunTurnResult falls back to output when finalized payload is absent", () => {
  const result: RunTurnResult = {
    assistantText: null,
    output,
  };

  assert.deepEqual(summarizeRunTurnResult(result), {
    text: "",
    raw: output,
  });
});
