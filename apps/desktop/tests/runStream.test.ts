import assert from "node:assert/strict";

import {
  describeDesktopRunnerActivity,
  projectDesktopConversationTimeline,
  projectDesktopRunStream,
} from "../renderer/src/runStream.js";
import type { DesktopRunnerEvent } from "../src/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "Desktop projects assistant progress and tool activity into the conversation stream", () => {
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

contractTest("desktop.hermetic", "Desktop accumulates live reasoning deltas in one visible stream item", () => {
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

contractTest("desktop.hermetic", "Desktop ignores repeated reasoning starts after an interrupted stream", () => {
  const events = [
    event("run.model.reasoning.started", {
      update: baseUpdate({ event: "started", attempt: 1, format: "provider_reasoning_text", contentState: "live" }),
    }),
    event("run.model.reasoning.delta", {
      update: baseUpdate({ event: "delta", attempt: 1, format: "provider_reasoning_text", contentState: "live", delta: "Inspecting " }),
    }),
    event("run.model.reasoning.started", {
      update: { ...baseUpdate({ event: "started", attempt: 1, format: "provider_reasoning_text", contentState: "live" }), seq: 2 },
    }),
    event("run.model.reasoning.delta", {
      update: { ...baseUpdate({ event: "delta", attempt: 1, format: "provider_reasoning_text", contentState: "live", delta: "the workspace." }), seq: 3 },
    }),
  ];

  const projected = events.reduce(projectDesktopRunStream, []);
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.label, "Reasoning");
  assert.equal(projected[0]?.text, "Inspecting the workspace.");
});

contractTest("desktop.hermetic", "Desktop starts a new reasoning block after assistant and tool activity", () => {
  const events = [
    event("run.model.reasoning.started", {
      update: baseUpdate({ event: "started", attempt: 1, format: "summary", contentState: "live" }),
    }),
    event("run.model.reasoning.delta", {
      update: baseUpdate({ event: "delta", attempt: 1, format: "summary", contentState: "live", delta: "First thought." }),
    }),
    event("run.agent_progress", {
      update: baseUpdate({ message: "I’m continuing the requested work.", stepIndex: 1, stepAgent: "agent.loop" }),
    }),
    event("run.tool.completed", {
      update: baseUpdate({ toolCallId: "tool-1", toolName: "fs.search_text", phase: "completed" }),
    }),
    event("run.model.reasoning.delta", {
      update: baseUpdate({ event: "delta", attempt: 1, format: "summary", contentState: "live", delta: "Second thought." }),
    }),
  ];

  const projected = events.reduce(projectDesktopRunStream, []);
  assert.deepEqual(projected.map((item) => [item.kind, item.text]), [
    ["reasoning", "First thought."],
    ["assistant", "I’m continuing the requested work."],
    ["tool", "Completed fs.search_text"],
    ["reasoning", "Second thought."],
  ]);
});

contractTest("desktop.hermetic", "Desktop completes an earlier reasoning block without moving it past later activity", () => {
  const events = [
    event("run.model.reasoning.started", {
      update: baseUpdate({ event: "started", attempt: 1, format: "summary", contentState: "live" }),
    }),
    event("run.model.reasoning.delta", {
      update: baseUpdate({ event: "delta", attempt: 1, format: "summary", contentState: "live", delta: "Inspecting." }),
    }),
    event("run.agent_progress", {
      update: baseUpdate({ message: "Still working.", stepIndex: 1, stepAgent: "agent.loop" }),
    }),
    event("run.model.reasoning.completed", {
      update: baseUpdate({ event: "completed", attempt: 1, format: "summary", contentState: "live" }),
    }),
  ];

  const projected = events.reduce(projectDesktopRunStream, []);
  assert.deepEqual(projected.map((item) => [item.kind, item.status]), [
    ["reasoning", "completed"],
    ["assistant", "active"],
  ]);
});

contractTest("desktop.hermetic", "Desktop preserves a live item's first-seen timestamp when later phases update it", () => {
  const started = event("run.tool.started", {
    update: { ...baseUpdate({ toolCallId: "tool-1", toolName: "exec_command", phase: "started" }), ts: "2026-07-20T12:00:01.000Z" },
  });
  const completed = event("run.tool.completed", {
    update: { ...baseUpdate({ toolCallId: "tool-1", toolName: "exec_command", phase: "completed" }), ts: "2026-07-20T12:00:04.000Z" },
  });

  const projected = [started, completed].reduce(projectDesktopRunStream, []);
  assert.equal(projected[0]?.timestamp, "2026-07-20T12:00:01.000Z");
  assert.equal(projected[0]?.status, "completed");
});

contractTest("desktop.hermetic", "Desktop starts each accepted run with an empty transient stream", () => {
  const current = projectDesktopRunStream([], event("run.agent_progress", {
    update: baseUpdate({ message: "Old progress", stepIndex: 1, stepAgent: "agent.loop" }),
  }));
  assert.deepEqual(projectDesktopRunStream(current, event("run.started", {
    sessionId: "session-1",
    eventType: "user.message",
  })), []);
});

contractTest("desktop.hermetic", "Desktop keeps runtime progress updates out of the conversation stream", () => {
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

contractTest("desktop.hermetic", "Desktop surfaces the current runtime progress message in the live activity line", () => {
  const progress = event("run.progress", {
    update: baseUpdate({
      kind: "stage",
      phase: "thinker",
      code: "MODEL_CALL_STARTED",
      message: "Calling decision model…",
      persist: true,
    }),
  });

  assert.equal(describeDesktopRunnerActivity(progress), "Calling decision model…");
});

contractTest("desktop.hermetic", "Desktop interleaves live run items before the terminal assistant response", () => {
  const transcript = [
    { role: "user" as const, text: "Open the report.", timestamp: "2026-07-20T12:00:00.000Z" },
    { role: "assistant" as const, text: "The report is open.", timestamp: "2026-07-20T12:00:03.000Z" },
  ];
  const runStream = [
    {
      id: "reasoning:run-1:1:summary",
      kind: "reasoning" as const,
      label: "Reasoning",
      text: "I will open the report.",
      timestamp: "2026-07-20T12:00:01.000Z",
      status: "completed" as const,
    },
    {
      id: "tool:tool-1",
      kind: "tool" as const,
      label: "Tool",
      text: "Completed exec_command",
      timestamp: "2026-07-20T12:00:02.000Z",
      status: "completed" as const,
    },
  ];

  const timeline = projectDesktopConversationTimeline(transcript, runStream);
  assert.deepEqual(timeline.map((item) => item.type === "transcript" ? item.line.text : item.item.text), [
    "Open the report.",
    "I will open the report.",
    "Completed exec_command",
    "The report is open.",
  ]);
});

contractTest("desktop.hermetic", "Desktop resolves equal event timestamps as user, live run, then terminal response", () => {
  const timestamp = "2026-07-20T12:00:00.000Z";
  const timeline = projectDesktopConversationTimeline(
    [
      { role: "user", text: "Run it.", timestamp },
      { role: "assistant", text: "Done.", timestamp },
    ],
    [{
      id: "tool:tool-1",
      kind: "tool",
      label: "Tool",
      text: "Completed exec_command",
      timestamp,
      status: "completed",
    }],
  );

  assert.deepEqual(timeline.map((item) => item.type === "transcript" ? item.line.text : item.item.text), [
    "Run it.",
    "Completed exec_command",
    "Done.",
  ]);
});

contractTest("desktop.hermetic", "Desktop preserves durable transcript order when transcript timestamps are equal", () => {
  const timestamp = "2026-07-20T12:00:00.000Z";
  const timeline = projectDesktopConversationTimeline(
    [
      { role: "assistant", text: "Previous response.", timestamp },
      { role: "user", text: "Next request.", timestamp },
    ],
    [],
  );

  assert.deepEqual(timeline.map((item) => item.type === "transcript" ? item.line.text : item.item.text), [
    "Previous response.",
    "Next request.",
  ]);
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
