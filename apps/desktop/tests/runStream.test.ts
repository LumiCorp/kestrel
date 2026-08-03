import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationTimeline } from "../renderer/src/ConversationTimeline.js";
import {
  describeDesktopRunnerActivity,
  projectDesktopConversationTimeline,
  projectDesktopRunStream,
} from "../renderer/src/runStream.js";
import type { DesktopRunnerEvent } from "../src/contracts.js";


test("Desktop projects assistant progress and tool activity into the conversation stream", () => {
  const progress = event("run.agent_progress", {
    update: baseUpdate({ message: "I am starting the development server.", stepIndex: 1, stepAgent: "agent.loop" }),
  });
  const started = event("run.tool.started", {
    update: baseUpdate({
      toolCallId: "tool-1",
      toolName: "exec_command",
      displayName: "Exec Command",
      input: { command: "npm run dev" },
      phase: "started",
    }),
  });
  const completed = event("run.tool.completed", {
    update: baseUpdate({
      toolCallId: "tool-1",
      toolName: "exec_command",
      displayName: "Exec Command",
      input: { command: "npm run dev" },
      phase: "completed",
    }),
  });

  const projected = [progress, started, completed].reduce(projectDesktopRunStream, []);
  assert.deepEqual(projected.map((item) => [item.kind, item.text, item.status]), [
    ["assistant", "I am starting the development server.", "active"],
    ["tool", "Completed Exec Command (exec_command)", "completed"],
  ]);
  assert.equal(projected[1]?.label, "Tool action");
  assert.equal(projected[1]?.toolName, "exec_command");
  assert.deepEqual(projected[1]?.toolInput, { command: "npm run dev" });
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
  assert.equal(projected[0]?.label, "Provider reasoning summary");
  assert.equal(projected[0]?.text, "Inspecting the workspace.");
});

test("Desktop distinguishes empty, unavailable, and unretained provider reasoning", () => {
  const empty = [
    event("run.model.reasoning.started", {
      update: baseUpdate({ event: "started", attempt: 1, format: "provider_reasoning_text", contentState: "live" }),
    }),
    event("run.model.reasoning.completed", {
      update: baseUpdate({ event: "completed", attempt: 1, format: "provider_reasoning_text", contentState: "live" }),
    }),
  ].reduce(projectDesktopRunStream, []);
  const unavailable = projectDesktopRunStream([], event("run.model.reasoning.unavailable", {
    update: baseUpdate({ event: "unavailable", attempt: 1, format: "provider_reasoning_text", contentState: "live" }),
  }));
  const unretained = projectDesktopRunStream([], event("run.model.reasoning.started", {
    update: baseUpdate({ event: "started", attempt: 1, format: "provider_reasoning_text", contentState: "not_retained" }),
  }));

  assert.deepEqual(
    [empty[0]?.label, empty[0]?.text, empty[0]?.status],
    ["Provider reasoning", "Provider returned no visible reasoning detail.", "completed"],
  );
  assert.equal(unavailable[0]?.text, "Provider reasoning is unavailable for this model.");
  assert.equal(unretained[0]?.text, "Provider reasoning is not retained for this run.");
});

test("Desktop keeps mismatched agent narration separate from canonical Weather action truth", () => {
  const events = [
    event("run.agent_progress", {
      update: baseUpdate({
        message: "Continuing implementation of Likes feature server action and UI components.",
        stepIndex: 1,
        stepAgent: "agent.loop",
      }),
    }),
    event("run.tool.completed", {
      update: baseUpdate({
        toolCallId: "call-weather-1",
        toolName: "free.weather.current",
        displayName: "Current Weather",
        input: { city: "Atlantic Ocean" },
        phase: "completed",
      }),
    }),
  ];
  const runStream = events.reduce(projectDesktopRunStream, []);
  const items = projectDesktopConversationTimeline(
    [{
      role: "user",
      text: "Implement the Likes feature.",
      timestamp: "2026-07-27T13:54:00.000Z",
    }],
    runStream,
  );
  const html = renderToStaticMarkup(React.createElement(ConversationTimeline, {
    items,
    active: true,
    activity: "Working",
    endRef: { current: null },
  }));

  assert.deepEqual(runStream.map((item) => [item.kind, item.text]), [
    ["assistant", "Continuing implementation of Likes feature server action and UI components."],
    ["tool", "Completed Current Weather (free.weather.current)"],
  ]);
  assert.match(html, /Kestrel/u);
  assert.match(html, /Continuing implementation of Likes feature/u);
  assert.match(html, /Details/u);
  assert.match(html, /Tool action/u);
  assert.match(html, /Current Weather \(free\.weather\.current\)/u);
  assert.match(html, /free\.weather\.current input/u);
  assert.match(html, /Atlantic Ocean/u);
});

test("Desktop ignores repeated reasoning starts after an interrupted stream", () => {
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
  assert.equal(projected[0]?.label, "Provider reasoning");
  assert.equal(projected[0]?.text, "Inspecting the workspace.");
});

test("Desktop starts a new reasoning block after assistant and tool activity", () => {
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

test("Desktop completes an earlier reasoning block without moving it past later activity", () => {
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

test("Desktop preserves a live item's first-seen timestamp when later phases update it", () => {
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

test("Desktop starts each accepted run with an empty transient stream", () => {
  const current = projectDesktopRunStream([], event("run.agent_progress", {
    update: baseUpdate({ message: "Old progress", stepIndex: 1, stepAgent: "agent.loop" }),
  }));
  assert.deepEqual(projectDesktopRunStream(current, event("run.started", {
    sessionId: "session-1",
    eventType: "user.message",
  })), []);
});

test("Desktop retains runtime progress as operational timeline detail", () => {
  const projected = projectDesktopRunStream([], event("run.progress", {
    update: baseUpdate({
      kind: "stage",
      phase: "engine",
      code: "STEP_STARTED",
      message: "Run update that belongs in activity details.",
      persist: false,
    }),
  }));

  assert.deepEqual(projected.map((item) => [
    item.kind,
    item.label,
    item.text,
    item.status,
  ]), [[
    "status",
    "Runtime",
    "Run update that belongs in activity details.",
    "completed",
  ]]);
});

test("Desktop describes the current runtime progress message for transient feedback", () => {
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

test("Desktop interleaves live run items before the terminal assistant response", () => {
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

test("Desktop resolves equal event timestamps as user, live run, then terminal response", () => {
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

test("Desktop preserves durable transcript order when transcript timestamps are equal", () => {
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

test("Desktop renders a stopped transition when cancellation has no assistant response", () => {
  const items = projectDesktopConversationTimeline(
    [{
      role: "user",
      text: "Stop the work.",
      timestamp: "2026-07-20T12:00:00.000Z",
    }],
    [{
      id: "tool:tool-1",
      kind: "tool",
      label: "Tool",
      text: "Running exec_command",
      timestamp: "2026-07-20T12:00:01.000Z",
      status: "active",
    }],
  );

  const html = renderToStaticMarkup(React.createElement(ConversationTimeline, {
    items,
    active: false,
    activity: "Cancelled",
    endRef: { current: null },
  }));

  assert.match(html, /Run stopped/u);
  assert.match(html, /state-cancelled/u);
});

test("Desktop renders progress calmly while operational evidence stays collapsed", () => {
  const items = projectDesktopConversationTimeline([], [
    {
      id: "assistant:event-1",
      kind: "assistant",
      label: "Kestrel",
      text: "Inspecting the workspace.",
      timestamp: "2026-07-20T12:00:01.000Z",
      status: "active",
    },
    {
      id: "tool:tool-1",
      kind: "tool",
      label: "Tool",
      text: "Completed exec_command",
      timestamp: "2026-07-20T12:00:02.000Z",
      status: "completed",
    },
  ]);

  const html = renderToStaticMarkup(React.createElement(ConversationTimeline, {
    items,
    active: true,
    activity: "Inspecting the workspace.",
    endRef: { current: null },
  }));

  assert.match(html, /Kestrel/u);
  assert.match(html, /Inspecting the workspace\./u);
  assert.match(html, /Details/u);
  assert.match(html, /1 operational event/u);
  assert.doesNotMatch(html, /Agent progress/u);
  assert.doesNotMatch(html, /Activity details/u);
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
