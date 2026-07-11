import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToString } from "ink";

import { ChatView } from "../../cli/ink/views/ChatView.js";

test("ChatView renders transcript and compose shell", () => {
  const now = new Date().toISOString();
  const text = renderToString(
    React.createElement(ChatView, {
      session: {
        name: "design-thread",
        sessionId: "session-1",
        profileId: "reference",
        createdAt: now,
        updatedAt: now,
        started: true,
      },
      transcript: [
        {
          role: "assistant",
          text: "Drafting the new shell.",
          timestamp: now,
        },
        {
          role: "user",
          text: "Ship it.",
          timestamp: now,
        },
      ],
      runLogs: [
        {
          timestamp: now,
          level: "INFO",
          eventName: "run_started",
          metadata: {
            eventType: "user.message",
          },
        },
      ],
      scroll: {
        offset: 0,
        cursor: 1,
        tailLocked: true,
      },
      statusLine: "completed",
      draft: "",
      running: false,
      composerFocused: true,
      viewportColumns: 140,
      viewportRows: 40,
      unreadCount: 0,
      onDraftChange: () => {},
      onSubmit: () => {},
    }),
  );

  assert.match(text, /Drafting the new shell/);
  assert.match(text, /Ship it/);
  assert.match(text, /<< AGENT/);
  assert.match(text, />> YOU/);
  assert.doesNotMatch(text, /2\/2 msgs · 2\/2 rows · live tail · caught up/);
  assert.doesNotMatch(text, /completed/);
  assert.doesNotMatch(text, /\/ commands · Shift\+Enter newline/);
  assert.doesNotMatch(text, /\+-+\+/);
  assert.doesNotMatch(text, /[┌┐└┘─│]/u);
  assert.doesNotMatch(text, /provider=/);
  assert.doesNotMatch(text, /context=/);
});

test("ChatView renders assistant reasoning transcript rows as muted agent messages", () => {
  const now = new Date().toISOString();
  const text = renderToString(
    React.createElement(ChatView, {
      session: {
        name: "design-thread",
        sessionId: "session-1",
        profileId: "reference",
        createdAt: now,
        updatedAt: now,
        started: true,
      },
      transcript: [
        {
          role: "assistant",
          text: "Inspecting context pressure before continuing.",
          data: {
            reasoning: true,
            runId: "run-1",
          },
          timestamp: now,
        },
      ],
      runLogs: [],
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      statusLine: "running",
      draft: "",
      running: true,
      composerFocused: false,
      viewportColumns: 120,
      viewportRows: 40,
      unreadCount: 0,
      onDraftChange: () => {},
      onSubmit: () => {},
    }),
  );

  assert.match(text, /AGENT \(REASONING\)/);
  assert.match(text, /\.\. Inspecting context pressure before continuing\./);
});

test("ChatView keeps the composer interactive while waiting for user input", () => {
  const now = new Date().toISOString();
  const text = renderToString(
    React.createElement(ChatView, {
      session: {
        name: "waiting-thread",
        sessionId: "session-1",
        profileId: "reference",
        createdAt: now,
        updatedAt: now,
        started: true,
        pendingWaitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            prompt: "Reply to continue.",
          },
        },
      },
      transcript: [
        {
          role: "assistant",
          text: "Need your reply before I can continue.",
          timestamp: now,
        },
      ],
      runLogs: [],
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      statusLine: "running",
      draft: "",
      running: true,
      composerFocused: true,
      viewportColumns: 120,
      viewportRows: 40,
      unreadCount: 0,
      onDraftChange: () => {},
      onSubmit: () => {},
    }),
  );

  assert.match(text, /Waiting · Reply to continue\./);
  assert.doesNotMatch(text, /Type message or \//);
  assert.doesNotMatch(text, /Message Details/);
  assert.doesNotMatch(text, /Run in progress/);
});

test("ChatView keeps the composer interactive for operator steer drafts during a running turn", () => {
  const now = new Date().toISOString();
  const text = renderToString(
    React.createElement(ChatView, {
      session: {
        name: "running-thread",
        sessionId: "session-1",
        profileId: "reference",
        createdAt: now,
        updatedAt: now,
        started: true,
      },
      transcript: [
        {
          role: "assistant",
          text: "Working on the current task.",
          timestamp: now,
        },
      ],
      runLogs: [],
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      statusLine: "running",
      draft: "/steer stop after the current tool call",
      running: true,
      composerFocused: true,
      viewportColumns: 120,
      viewportRows: 40,
      unreadCount: 0,
      onDraftChange: () => {},
      onSubmit: () => {},
    }),
  );

  assert.match(text, /\/steer stop after the current tool call/);
  assert.match(text, /Run in progress/);
});

test("ChatView keeps the composer interactive for plain queued drafts during a running turn", () => {
  const now = new Date().toISOString();
  const text = renderToString(
    React.createElement(ChatView, {
      session: {
        name: "running-thread",
        sessionId: "session-1",
        profileId: "reference",
        createdAt: now,
        updatedAt: now,
        started: true,
      },
      transcript: [],
      runLogs: [],
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      statusLine: "running",
      draft: "also check the failing test output",
      running: true,
      composerFocused: true,
      viewportColumns: 120,
      viewportRows: 40,
      unreadCount: 0,
      onDraftChange: () => {},
      onSubmit: () => {},
    }),
  );

  assert.match(text, /also check the failing test output/);
  assert.match(text, /Run in progress/);
});

test("ChatView wraps long composer drafts without the old fixed row cap", () => {
  const now = new Date().toISOString();
  const transcript = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "assistant" as const : "user" as const,
    text: index === 11 ? "Final replay line remains visible." : `Replay line ${index + 1}.`,
    timestamp: now,
  }));
  const baseProps = {
    session: {
      name: "replay-thread",
      sessionId: "session-1",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    },
    transcript,
    runLogs: [],
    scroll: {
      offset: 0,
      cursor: transcript.length - 1,
      tailLocked: true,
    },
    statusLine: "completed",
    running: false,
    composerFocused: true,
    viewportColumns: 80,
    viewportRows: 18,
    unreadCount: 0,
    onDraftChange: () => {},
    onSubmit: () => {},
  };
  const emptyDraft = renderToString(React.createElement(ChatView, { ...baseProps, draft: "" }));
  const longDraft = renderToString(
    React.createElement(ChatView, {
      ...baseProps,
      draft: [
        "keep typing a very long composer draft that should wrap instead of clipping at the first row",
        "second paragraph remains visible",
        "third paragraph remains visible",
        "fourth paragraph remains visible",
        "fifth paragraph remains visible",
        "sixth paragraph keeps the inner composer viewport honest",
        "seventh paragraph distant-tail-token",
      ].join("\n"),
    }),
  );

  assert.equal(emptyDraft.includes("distant-tail-token"), false);
  assert.match(longDraft, /Final replay line remains visible\./);
  assert.match(longDraft, /keep typing a very long composer draft/);
  assert.match(longDraft, /second paragraph remains visible/);
  assert.match(longDraft, /distant-tail-token/);
});
