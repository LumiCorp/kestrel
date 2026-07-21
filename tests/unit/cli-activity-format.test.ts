import assert from "node:assert/strict";

import type { AgentRunLogLine } from "../../cli/contracts.js";
import { formatActivityPresentation } from "../../cli/ink/views/activityFormat.js";
import { contractTest } from "../helpers/contract-test.js";


function line(
  eventName: string,
  metadata?: Record<string, unknown>,
  overrides?: Partial<AgentRunLogLine>,
): AgentRunLogLine {
  return {
    timestamp: new Date().toISOString(),
    level: "INFO",
    eventName,
    ...(metadata !== undefined ? { metadata } : {}),
    ...overrides,
  };
}

contractTest("runtime.hermetic", "formats progress tool updates with human-readable tool status", () => {
  const formatted = formatActivityPresentation(
    line("progress_tool", {
      tool: { name: "free.weather.current", status: "DONE", latencyMs: 812 },
    }),
  );

  assert.equal(formatted.summary, "Tool 'free.weather.current' completed in 812ms.");
});

contractTest("runtime.hermetic", "formats route decision with lane", () => {
  const formatted = formatActivityPresentation(
    line("route_decision", {
      executionLane: "tooling",
    }),
  );

  assert.equal(formatted.summary, "Routing to tooling.");
});

contractTest("runtime.hermetic", "formats decision rejection with code and message", () => {
  const formatted = formatActivityPresentation(
    line(
      "decision_rejected",
      {
        decisionErrorCode: "DECISION_SCHEMA_FAILED",
        message: "requiredCapabilities missing",
      },
      {
        level: "WARN",
      },
    ),
  );

  assert.equal(
    formatted.summary,
    "Decision rejected (DECISION_SCHEMA_FAILED): requiredCapabilities missing",
  );
});

contractTest("runtime.hermetic", "context shortens run id and includes step index", () => {
  const formatted = formatActivityPresentation(
    line(
      "step_started",
      {
        step: "react.deliberate",
      },
      {
        runId: "12345678-aaaa-bbbb-cccc-1234567890ab",
        stepIndex: 3,
      },
    ),
  );

  assert.equal(formatted.context, "run 12345678 · step 3");
});

contractTest("runtime.hermetic", "formats queue dequeue events with wait time", () => {
  const formatted = formatActivityPresentation(
    line("tool_queue_dequeued", {
      tool: "free.weather.current",
      queueWaitMs: 87,
    }),
  );

  assert.equal(formatted.summary, "Tool 'free.weather.current' left queue after 87ms.");
});

contractTest("runtime.hermetic", "formats progress tool updates with queue metadata", () => {
  const formatted = formatActivityPresentation(
    line("progress_tool", {
      tool: { name: "free.weather.current", status: "DONE", latencyMs: 230 },
      queueWaitMs: 90,
    }),
  );

  assert.equal(
    formatted.summary,
    "Tool 'free.weather.current' completed in 230ms (queued 90ms).",
  );
});
