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


test("Desktop projects agent progress and tool activity into the conversation stream", () => {
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
    ["agent_progress", "I am starting the development server.", "active"],
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
    ["agent_progress", "Continuing implementation of Likes feature server action and UI components."],
    ["tool", "Completed Current Weather (free.weather.current)"],
  ]);
  assert.match(html, /Agent progress/u);
  assert.match(html, /Continuing implementation of Likes feature/u);
  assert.match(html, /Details/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.doesNotMatch(html, /Tool action/u);
  assert.doesNotMatch(html, /free\.weather\.current input/u);
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

test("Desktop keeps interleaved reasoning in one coherent streaming block", () => {
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
    ["reasoning", "First thought.Second thought."],
    ["agent_progress", "I’m continuing the requested work."],
    ["tool", "Completed fs.search_text"],
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
    ["agent_progress", "active"],
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

test("Desktop starts each accepted run without clearing earlier run groups", () => {
  const current = projectDesktopRunStream([], event("run.agent_progress", {
    update: baseUpdate({ runId: "run-old", message: "Old progress", stepIndex: 1, stepAgent: "agent.loop" }),
  }));
  const next = projectDesktopRunStream(current, event("run.started", {
    sessionId: "session-1",
    eventType: "user.message",
  }));
  assert.deepEqual(
    next.filter((item) => item.visible !== false).map((item) => [item.runId, item.text]),
    [["run-old", "Old progress"]],
  );
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

test("Desktop retires terminal run activity without clearing another live run", () => {
  const active = [
    event("run.agent_progress", { update: baseUpdate({ runId: "run-1", message: "First run." }) }),
    { ...event("run.agent_progress", { update: baseUpdate({ runId: "run-2", message: "Second run." }) }), runId: "run-2" },
  ].reduce(projectDesktopRunStream, []);
  const completed = projectDesktopRunStream(active, event("run.completed", {
    result: { output: { runId: "run-1" } },
  }));
  assert.deepEqual(completed.map((item) => [item.runId, item.text]), [["run-2", "Second run."]]);
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

test("Desktop restores authoritative turn order from a scrambled persisted transcript", () => {
  const timestamp = "2026-08-13T12:00:00.000Z";
  const transcript = [
    { role: "assistant" as const, text: "Second response.", timestamp, terminal: { runId: "run-2", turnId: "turn-2" } },
    { role: "user" as const, text: "Second request.", timestamp, data: { kind: "desktop.user-message.v1", messageId: "message-2" } },
    { role: "assistant" as const, text: "First response.", timestamp, terminal: { runId: "run-1", turnId: "turn-1" } },
    { role: "user" as const, text: "First request.", timestamp, data: { kind: "desktop.user-message.v1", messageId: "message-1" } },
  ];
  const turns = [
    {
      turnId: "turn-2", threadId: "thread-1", sessionId: "session-1", sequence: 2,
      status: "COMPLETED" as const, sourceMessageId: "message-2", rootRunId: "run-2",
      terminalRunId: "run-2", startedAt: timestamp, updatedAt: timestamp, completedAt: timestamp,
    },
    {
      turnId: "turn-1", threadId: "thread-1", sessionId: "session-1", sequence: 1,
      status: "COMPLETED" as const, sourceMessageId: "message-1", rootRunId: "run-1",
      terminalRunId: "run-1", startedAt: timestamp, updatedAt: timestamp, completedAt: timestamp,
    },
  ];

  const timeline = projectDesktopConversationTimeline(transcript, [], turns);
  assert.deepEqual(
    timeline.map((item) => item.type === "transcript" ? item.line.text : item.item.text),
    ["First request.", "First response.", "Second request.", "Second response."],
  );
});

test("Desktop weaves run activity around repeated interaction messages without regrouping their roles", () => {
  const transcript = [
    {
      role: "user" as const,
      text: "What happened?",
      timestamp: "2026-08-24T12:00:00.000Z",
      data: { kind: "desktop.user-message.v1", messageId: "message-input" },
    },
    {
      role: "assistant" as const,
      text: "What would you like me to explain?",
      timestamp: "2026-08-24T12:00:01.000Z",
      data: { kestrelMessageId: "message-request-1" },
    },
    {
      role: "user" as const,
      text: "The attached files.",
      timestamp: "2026-08-24T12:00:02.000Z",
      data: { kind: "desktop.user-message.v1", messageId: "message-response-1" },
    },
    {
      role: "assistant" as const,
      text: "Which attached file?",
      timestamp: "2026-08-24T12:00:03.000Z",
      data: { kestrelMessageId: "message-request-2" },
    },
    {
      role: "user" as const,
      text: "The PDF.",
      timestamp: "2026-08-24T12:00:04.000Z",
      data: { kind: "desktop.user-message.v1", messageId: "message-response-2" },
    },
    {
      role: "assistant" as const,
      text: "I cannot access the PDF.",
      timestamp: "2026-08-24T12:00:05.000Z",
      data: { kestrelMessageId: "message-continuation" },
    },
  ];
  const turns = [{
    turnId: "turn-1",
    threadId: "thread-1",
    sessionId: "session-1",
    sequence: 1,
    status: "COMPLETED" as const,
    sourceMessageId: "message-input",
    rootRunId: "run-1",
    terminalRunId: "run-1",
    startedAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:05.000Z",
    completedAt: "2026-08-24T12:00:05.000Z",
  }];
  const routes = transcript.map((line, index) => ({
    messageId: index === 0
      ? "message-input"
      : index === 1
        ? "message-request-1"
        : index === 2
          ? "message-response-1"
          : index === 3
            ? "message-request-2"
            : index === 4
              ? "message-response-2"
              : "message-continuation",
    disposition: "replied" as const,
    createdAt: line.timestamp,
    runId: "run-1",
    turnId: "turn-1",
  }));
  const runStream = [
    {
      id: "activity:explain",
      runId: "run-1",
      kind: "agent_progress" as const,
      label: "Agent progress",
      text: "Checking the attachments.",
      timestamp: "2026-08-24T12:00:01.500Z",
      status: "completed" as const,
    },
    {
      id: "activity:pdf",
      runId: "run-1",
      kind: "tool" as const,
      label: "Tool action",
      text: "Read PDF metadata.",
      timestamp: "2026-08-24T12:00:04.500Z",
      status: "completed" as const,
    },
  ];

  const timeline = projectDesktopConversationTimeline(transcript, runStream, turns, routes);

  assert.deepEqual(
    timeline.map((item) => item.type === "transcript" ? item.line.text : item.item.text),
    [
      "What happened?",
      "What would you like me to explain?",
      "Checking the attachments.",
      "The attached files.",
      "Which attached file?",
      "The PDF.",
      "Read PDF metadata.",
      "I cannot access the PDF.",
    ],
  );
});

test("Desktop preserves ordered unsegmented messages and leaves legacy activity unowned", () => {
  const transcript = [
    {
      role: "user" as const,
      text: "Continue.",
      timestamp: "2026-08-24T13:00:00.000Z",
      data: { kind: "desktop.user-message.v1", messageId: "message-input" },
    },
    {
      role: "assistant" as const,
      text: "Which file should I use?",
      timestamp: "2026-08-24T13:00:01.000Z",
      data: { kestrelMessageId: "message-request" },
    },
    {
      role: "user" as const,
      text: "The PDF.",
      timestamp: "2026-08-24T13:00:02.000Z",
      data: { kind: "desktop.user-message.v1", messageId: "message-response" },
    },
    {
      role: "assistant" as const,
      text: "I will continue without it.",
      timestamp: "2026-08-24T13:00:03.000Z",
      data: { kestrelMessageId: "message-continuation" },
    },
  ];
  const turns = [{
    turnId: "turn-1",
    threadId: "thread-1",
    sessionId: "session-1",
    sequence: 1,
    status: "COMPLETED" as const,
    sourceMessageId: "message-input",
    startedAt: "2026-08-24T13:00:00.000Z",
    updatedAt: "2026-08-24T13:00:03.000Z",
    completedAt: "2026-08-24T13:00:03.000Z",
  }];
  const routes = ["message-input", "message-request", "message-response", "message-continuation"].map(
    (messageId, index) => ({
      messageId,
      disposition: "replied" as const,
      createdAt: transcript[index]!.timestamp,
      turnId: "turn-1",
    }),
  );
  const timeline = projectDesktopConversationTimeline(transcript, [{
    id: "activity:legacy",
    kind: "status",
    label: "Runtime",
    text: "Legacy runtime detail.",
    timestamp: "2026-08-24T13:00:04.000Z",
    status: "completed",
  }], turns, routes);

  assert.deepEqual(
    timeline.map((item) => item.type === "transcript" ? item.line.text : item.item.text),
    [
      "Continue.",
      "Which file should I use?",
      "The PDF.",
      "I will continue without it.",
      "Legacy runtime detail.",
    ],
  );
});

test("Desktop keeps unowned legacy messages and activity in chronological display slots", () => {
  const firstTimestamp = "2026-08-13T12:00:00.000Z";
  const legacyTimestamp = "2026-08-13T12:01:00.000Z";
  const activityTimestamp = "2026-08-13T12:01:30.000Z";
  const secondTimestamp = "2026-08-13T12:02:00.000Z";
  const transcript = [
    {
      role: "user" as const,
      text: "First request.",
      timestamp: firstTimestamp,
      data: { kind: "desktop.user-message.v1", messageId: "message-1" },
    },
    {
      role: "assistant" as const,
      text: "First response.",
      timestamp: firstTimestamp,
      terminal: { runId: "run-1", turnId: "turn-1" },
    },
    {
      role: "assistant" as const,
      text: "Legacy collaborator note.",
      timestamp: legacyTimestamp,
    },
    {
      role: "user" as const,
      text: "Second request.",
      timestamp: secondTimestamp,
      data: { kind: "desktop.user-message.v1", messageId: "message-2" },
    },
    {
      role: "assistant" as const,
      text: "Second response.",
      timestamp: secondTimestamp,
      terminal: { runId: "run-2", turnId: "turn-2" },
    },
  ];
  const turns = [
    {
      turnId: "turn-1", threadId: "thread-1", sessionId: "session-1", sequence: 1,
      status: "COMPLETED" as const, sourceMessageId: "message-1", rootRunId: "run-1",
      terminalRunId: "run-1", startedAt: firstTimestamp, updatedAt: firstTimestamp,
      completedAt: firstTimestamp,
    },
    {
      turnId: "turn-2", threadId: "thread-1", sessionId: "session-1", sequence: 2,
      status: "COMPLETED" as const, sourceMessageId: "message-2", rootRunId: "run-2",
      terminalRunId: "run-2", startedAt: secondTimestamp, updatedAt: secondTimestamp,
      completedAt: secondTimestamp,
    },
  ];
  const timeline = projectDesktopConversationTimeline(transcript, [{
    id: "status:legacy",
    kind: "status",
    label: "Runtime",
    text: "Legacy runtime detail.",
    timestamp: activityTimestamp,
    status: "completed",
  }], turns);

  assert.deepEqual(
    timeline.map((item) => item.type === "transcript" ? item.line.text : item.item.text),
    [
      "First request.",
      "First response.",
      "Legacy collaborator note.",
      "Legacy runtime detail.",
      "Second request.",
      "Second response.",
    ],
  );
});

test("Desktop keeps a later collaborator message in its owning durable turn", () => {
  const firstTimestamp = "2026-08-13T12:00:00.000Z";
  const secondTimestamp = "2026-08-13T12:01:00.000Z";
  const transcript = [
    {
      role: "user" as const,
      text: "First request.",
      timestamp: firstTimestamp,
      data: { kind: "desktop.user-message.v1", messageId: "message-1" },
    },
    {
      role: "assistant" as const,
      text: "First response.",
      timestamp: firstTimestamp,
      terminal: { runId: "run-1", turnId: "turn-1" },
    },
    {
      role: "user" as const,
      text: "Ask Peregrine.",
      timestamp: secondTimestamp,
      data: { kind: "desktop.user-message.v1", messageId: "message-2" },
    },
    {
      role: "assistant" as const,
      text: "Peregrine replied later.",
      timestamp: secondTimestamp,
      dialog: {
        messageId: "dialog-message-1",
        dialogId: "dialog-1",
        parentRunId: "run-2",
        name: "Peregrine",
        childSessionId: "dialog-child-1",
        sender: "collaborator" as const,
      },
    },
  ];
  const turns = [
    {
      turnId: "turn-1", threadId: "thread-1", sessionId: "session-1", sequence: 1,
      status: "COMPLETED" as const, sourceMessageId: "message-1", rootRunId: "run-1",
      terminalRunId: "run-1", startedAt: firstTimestamp, updatedAt: firstTimestamp,
      completedAt: firstTimestamp,
    },
    {
      turnId: "turn-2", threadId: "thread-1", sessionId: "session-1", sequence: 2,
      status: "WAITING" as const, sourceMessageId: "message-2", rootRunId: "run-2",
      activeRunId: "run-2", startedAt: secondTimestamp, updatedAt: secondTimestamp,
    },
  ];

  const timeline = projectDesktopConversationTimeline(transcript, [], turns);

  assert.deepEqual(
    timeline.map((item) => item.type === "transcript" ? item.line.text : item.item.text),
    ["First request.", "First response.", "Ask Peregrine.", "Peregrine replied later."],
  );
});

test("Desktop keeps a submitting user message at the tail before its durable turn arrives", () => {
  const transcript = [
    {
      role: "user" as const,
      text: "How is it going?",
      timestamp: "2026-08-13T23:31:00.000Z",
      data: { kind: "desktop.user-message.v1", messageId: "message-old" },
    },
    {
      role: "assistant" as const,
      text: "Current verified progress so far.",
      timestamp: "2026-08-13T23:31:30.000Z",
      terminal: { runId: "run-old", turnId: "turn-old" },
    },
    {
      role: "user" as const,
      text: "Let's keep going",
      timestamp: "2026-08-13T23:32:00.000Z",
      data: {
        kind: "desktop.user-message.v1",
        messageId: "message-new",
        deliveryState: "submitting",
      },
    },
  ];
  const runStream = [{
    id: "agent-progress:new-run",
    runId: "run-new",
    kind: "agent_progress" as const,
    label: "Agent progress",
    text: "Continuing the implementation.",
    timestamp: "2026-08-13T23:32:01.000Z",
    status: "active" as const,
  }];
  const turns = [{
    threadId: "thread-1",
    turnId: "turn-old",
    sequence: 1,
    status: "COMPLETED" as const,
    inputMessageId: "message-old",
    assistantMessageId: "terminal:run-old",
    rootRunId: "run-old",
    activeRunId: undefined,
    terminalRunId: "run-old",
    startedAt: "2026-08-13T23:31:00.000Z",
    updatedAt: "2026-08-13T23:31:30.000Z",
    completedAt: "2026-08-13T23:31:30.000Z",
  }];

  const items = projectDesktopConversationTimeline(transcript, runStream, turns, []);

  assert.deepEqual(
    items.map((item) => item.type === "transcript" ? item.line.text : item.item.text),
    [
      "How is it going?",
      "Current verified progress so far.",
      "Let's keep going",
      "Continuing the implementation.",
    ],
  );
});

test("Desktop keeps resumed-run details with their chronological message group", () => {
  const transcript = [
    {
      role: "user" as const,
      text: "Start the app.",
      timestamp: "2026-08-13T18:39:56.000Z",
      data: { kind: "desktop.user-message.v1", messageId: "message-start" },
    },
    {
      role: "system" as const,
      text: "Switch to Build and resume?",
      timestamp: "2026-08-13T18:40:03.000Z",
      terminal: { runId: "run-wait" },
    },
    {
      role: "user" as const,
      text: "you're now in build",
      timestamp: "2026-08-13T18:40:23.000Z",
      data: { kind: "desktop.user-message.v1", messageId: "message-resume" },
    },
    {
      role: "assistant" as const,
      text: "The app is running.",
      timestamp: "2026-08-13T18:40:41.000Z",
      terminal: { runId: "run-resume" },
    },
    {
      role: "user" as const,
      text: "Build notifications.",
      timestamp: "2026-08-13T21:04:58.000Z",
      data: { kind: "desktop.user-message.v1", messageId: "message-later" },
    },
    {
      role: "assistant" as const,
      text: "Notifications are complete.",
      timestamp: "2026-08-13T21:06:55.000Z",
      terminal: { runId: "run-later" },
    },
  ];
  const turns = [
    {
      turnId: "turn-start",
      threadId: "thread-1",
      sessionId: "session-1",
      sequence: 1,
      status: "COMPLETED" as const,
      sourceMessageId: "message-start",
      rootRunId: "run-wait",
      terminalRunId: "run-resume",
      startedAt: "2026-08-13T18:39:56.000Z",
      updatedAt: "2026-08-13T18:40:41.000Z",
      completedAt: "2026-08-13T18:40:41.000Z",
    },
    {
      turnId: "turn-later",
      threadId: "thread-1",
      sessionId: "session-1",
      sequence: 2,
      status: "COMPLETED" as const,
      sourceMessageId: "message-later",
      rootRunId: "run-later",
      terminalRunId: "run-later",
      startedAt: "2026-08-13T21:04:58.000Z",
      updatedAt: "2026-08-13T21:06:55.000Z",
      completedAt: "2026-08-13T21:06:55.000Z",
    },
  ];
  const runStream = [
    {
      id: "agent-progress:resume",
      runId: "run-resume",
      kind: "agent_progress" as const,
      label: "Agent progress",
      text: "Starting the app.",
      timestamp: "2026-08-13T18:40:30.000Z",
      status: "completed" as const,
    },
    {
      id: "agent-progress:later",
      runId: "run-later",
      kind: "agent_progress" as const,
      label: "Agent progress",
      text: "Building notifications.",
      timestamp: "2026-08-13T21:05:30.000Z",
      status: "completed" as const,
    },
  ];
  const routes = [
    { messageId: "message-start", runId: "run-wait", disposition: "started" as const, createdAt: "2026-08-13T18:39:56.000Z" },
    { messageId: "message-resume", runId: "run-resume", disposition: "replied" as const, createdAt: "2026-08-13T18:40:23.000Z" },
    { messageId: "message-later", runId: "run-later", disposition: "started" as const, createdAt: "2026-08-13T21:04:58.000Z" },
  ];

  const items = projectDesktopConversationTimeline(transcript, runStream, turns, routes);
  assert.deepEqual(items.map((item) => item.type === "transcript" ? item.line.text : item.item.text), [
    "Start the app.",
    "Switch to Build and resume?",
    "you're now in build",
    "Starting the app.",
    "The app is running.",
    "Build notifications.",
    "Building notifications.",
    "Notifications are complete.",
  ]);

  const html = renderToStaticMarkup(React.createElement(ConversationTimeline, {
    items,
    active: false,
    activity: "Ready",
    endRef: { current: null },
  }));
  assert.equal(html.match(/Agent progress · 1 update/g)?.length, 2);
  assert.ok(html.indexOf("Starting the app.") < html.indexOf("The app is running."));
  assert.ok(html.indexOf("Building notifications.") < html.indexOf("Notifications are complete."));
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

test("Desktop distinguishes collaborator history from human input and shows terminal status", () => {
  const items = projectDesktopConversationTimeline([{
    role: "assistant",
    text: "The check failed.",
    timestamp: "2026-08-20T12:00:00.000Z",
    dialog: {
      messageId: "dialog-message-status",
      dialogId: "dialog-status",
      name: "Reviewer",
      childSessionId: "child-status",
      sender: "collaborator",
      dialogStatus: "closed",
      dialogActivity: "idle",
      status: "failed",
    },
  }], []);
  const html = renderToStaticMarkup(React.createElement(ConversationTimeline, {
    items,
    active: false,
    activity: "Ready",
    endRef: { current: null },
  }));
  assert.match(html, /Collaborator: Reviewer/u);
  assert.match(html, /Closed/u);
  assert.match(html, /Needs attention/u);
});

test("Desktop does not render Completed before the agent finalizes an answer", () => {
  const items = projectDesktopConversationTimeline(
    [{
      role: "user",
      text: "Inspect the workspace.",
      timestamp: "2026-07-20T12:00:00.000Z",
    }],
    [{
      id: "tool:tool-1",
      kind: "tool",
      label: "Tool",
      text: "Completed fs.read_text",
      timestamp: "2026-07-20T12:00:01.000Z",
      status: "completed",
    }],
  );

  const html = renderToStaticMarkup(React.createElement(ConversationTimeline, {
    items,
    active: false,
    activity: "Ready",
    endRef: { current: null },
  }));

  assert.doesNotMatch(html, />Completed</u);
});

test("Desktop renders Completed only with the finalized assistant answer", () => {
  const items = projectDesktopConversationTimeline(
    [
      {
        role: "user",
        text: "Inspect the workspace.",
        timestamp: "2026-07-20T12:00:00.000Z",
      },
      {
        role: "assistant",
        text: "The workspace inspection is complete.",
        timestamp: "2026-07-20T12:00:02.000Z",
      },
    ],
    [{
      id: "tool:tool-1",
      kind: "tool",
      label: "Tool",
      text: "Completed fs.read_text",
      timestamp: "2026-07-20T12:00:01.000Z",
      status: "completed",
    }],
  );

  const html = renderToStaticMarkup(React.createElement(ConversationTimeline, {
    items,
    active: false,
    activity: "Ready",
    endRef: { current: null },
  }));

  assert.match(html, /The workspace inspection is complete\./u);
  assert.match(
    html,
    /timeline-entry-transition state-completed[\s\S]*<strong>Completed<\/strong>/u,
  );
  assert.ok(
    html.indexOf("The workspace inspection is complete.") <
      html.indexOf("timeline-entry-transition state-completed"),
  );
});

test("Desktop renders progress calmly while operational evidence stays collapsed", () => {
  const items = projectDesktopConversationTimeline([], [
    {
      id: "agent-progress:event-1",
      kind: "agent_progress",
      label: "Agent progress",
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

  assert.match(html, /Agent progress/u);
  assert.match(html, /Inspecting the workspace\./u);
  assert.match(html, /open=""/u);
  assert.match(html, /Agent is working/u);
  assert.match(html, /Details/u);
  assert.match(html, /1 operational event/u);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>/u);
  assert.doesNotMatch(html, /Completed exec_command/u);
  assert.doesNotMatch(html, /Activity details/u);
});

test("Desktop summarizes and collapses agent progress after the run completes", () => {
  const runStream = [
    event("run.agent_progress", {
      update: baseUpdate({ message: "Inspecting the workspace.", seq: 1 }),
    }),
    event("run.agent_progress", {
      update: baseUpdate({ message: "Starting the development server.", seq: 2 }),
    }),
  ].reduce(projectDesktopRunStream, []);
  const html = renderToStaticMarkup(React.createElement(ConversationTimeline, {
    items: projectDesktopConversationTimeline([], runStream),
    active: false,
    activity: "Ready",
    endRef: { current: null },
  }));

  assert.match(html, /Agent progress · 2 updates/u);
  assert.doesNotMatch(html, /open=""/u);
  assert.doesNotMatch(html, /Agent is working/u);
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
