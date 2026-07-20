import assert from "node:assert/strict";
import test from "node:test";

import { projectDesktopRunStream } from "../renderer/src/runStream.js";
import type { DesktopRunnerEvent } from "../src/contracts.js";

test("Desktop projects assistant progress and tool activity into the conversation stream", () => {
  const progress = event("run.agent_progress", {
    update: baseUpdate({ message: "I am starting the development server.", stepIndex: 1, stepAgent: "agent.loop" }),
  });
  const started = event("run.tool.started", {
    update: baseUpdate({ toolCallId: "tool-1", toolName: "exec_command", phase: "started" }),
  });
  const completed = event("run.tool.completed", {
    update: baseUpdate({ toolCallId: "tool-1", toolName: "exec_command", phase: "completed" }),
  });

  const projected = [progress, started, completed].reduce(projectDesktopRunStream, []);
  assert.deepEqual(projected.map((item) => [item.kind, item.text, item.status]), [
    ["assistant", "I am starting the development server.", "active"],
    ["tool", "Completed exec_command", "completed"],
  ]);
});

test("Desktop accumulates live reasoning deltas in one visible stream item", () => {
  const started = event("run.model.reasoning.started", {
    update: baseUpdate({ event: "started", attempt: 1, format: "summary", contentState: "live" }),
  });
  const first = event("run.model.reasoning.delta", {
    update: baseUpdate({ event: "delta", attempt: 1, format: "summary", contentState: "live", delta: "Inspecting " }),
  });
  const second = event("run.model.reasoning.delta", {
    update: { ...baseUpdate({ event: "delta", attempt: 1, format: "summary", contentState: "live", delta: "the workspace." }), seq: 2 },
  });

  const projected = [started, first, second].reduce(projectDesktopRunStream, []);
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.label, "Reasoning summary");
  assert.equal(projected[0]?.text, "Inspecting the workspace.");
});

test("Desktop starts each accepted run with an empty transient stream", () => {
  const current = projectDesktopRunStream([], event("run.agent_progress", {
    update: baseUpdate({ message: "Old progress", stepIndex: 1, stepAgent: "agent.loop" }),
  }));
  assert.deepEqual(projectDesktopRunStream(current, event("run.started", {
    sessionId: "session-1",
    eventType: "user.message",
  })), []);
});

test("Desktop keeps runtime progress updates out of the conversation stream", () => {
  const projected = projectDesktopRunStream([], event("run.progress", {
    update: baseUpdate({
      kind: "stage",
      phase: "engine",
      code: "STEP_STARTED",
      message: "Run update that belongs in the activity line.",
      persist: false,
    }),
  }));

  assert.deepEqual(projected, []);
});

function event(type: DesktopRunnerEvent["type"], payload: Record<string, unknown>): DesktopRunnerEvent {
  return {
    id: `event-${type}-${Math.random()}`,
    type,
    ts: "2026-07-20T12:00:00.000Z",
    runId: "run-1",
    sessionId: "session-1",
    payload,
  } as DesktopRunnerEvent;
}

function baseUpdate(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "v1",
    runId: "run-1",
    sessionId: "session-1",
    ts: "2026-07-20T12:00:00.000Z",
    seq: 1,
    ...extra,
  };
}
