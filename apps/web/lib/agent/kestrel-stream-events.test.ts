import assert from "node:assert/strict";
import test from "node:test";
import {
  createKestrelStreamUiUpdateFilter,
  getKestrelStreamProgressText,
  getKestrelStreamTerminalText,
  getKestrelStreamUiUpdate,
  getKestrelUserReplyWaitingText,
} from "@/lib/agent/kestrel-stream-events";

test("getKestrelStreamTerminalText maps completed payloads", () => {
  assert.equal(
    getKestrelStreamTerminalText({
      type: "run.completed",
      payload: {
        result: {
          assistantText: "Runtime answer",
          finalizedPayload: {
            message: "Structured data is not display text",
          },
        },
      },
    }),
    "Runtime answer"
  );
});

test("getKestrelStreamUiUpdate maps empty completed output to empty terminal status", () => {
  assert.deepEqual(
    getKestrelStreamUiUpdate({
      type: "run.completed",
      payload: { result: { assistantText: null, finalizedPayload: { message: "ignored" } } },
    }),
    {
      kind: "terminal",
      severity: "info",
      terminalStatus: "empty",
      text: "",
      errorMessage: null,
    }
  );
});

test("getKestrelStreamUiUpdate maps a user reply wait to a waiting terminal status", () => {
  const event = {
    type: "run.waiting",
    payload: {
      waitFor: {
        eventType: "user.reply",
        metadata: { prompt: "Which repository should I use?" },
      },
    },
  };

  assert.equal(
    getKestrelUserReplyWaitingText(event),
    "Which repository should I use?"
  );
  assert.deepEqual(getKestrelStreamUiUpdate(event), {
    kind: "terminal",
    severity: "info",
    terminalStatus: "waiting",
    text: "Which repository should I use?",
    errorMessage: null,
  });
});

test("getKestrelUserReplyWaitingText uses a stable fallback only for user reply waits", () => {
  assert.equal(
    getKestrelUserReplyWaitingText({
      type: "run.waiting",
      payload: { waitFor: { eventType: "user.reply", metadata: {} } },
    }),
    "I need your reply to continue."
  );
  assert.equal(
    getKestrelUserReplyWaitingText({
      type: "run.waiting",
      payload: { waitFor: { eventType: "user.approval", metadata: {} } },
    }),
    ""
  );
});

test("getKestrelStreamTerminalText keeps failed and cancelled events non-responsive", () => {
  assert.equal(
    getKestrelStreamTerminalText({
      type: "run.failed",
      payload: {
        error: {
          message: "Runner failed",
        },
      },
    }),
    ""
  );
  assert.equal(
    getKestrelStreamTerminalText({ type: "run.cancelled" }),
    ""
  );
});

test("getKestrelStreamTerminalText ignores non-terminal events", () => {
  assert.equal(
    getKestrelStreamTerminalText({
      type: "run.progress",
      payload: { message: "Working" },
    }),
    ""
  );
});

test("getKestrelStreamProgressText maps started progress reasoning and runner errors", () => {
  assert.equal(
    getKestrelStreamProgressText({ type: "run.started" }),
    "Started the Kestrel run."
  );
  assert.equal(
    getKestrelStreamProgressText({
      type: "run.progress",
      payload: {
        update: {
          kind: "tool",
          message: "Calling tool.",
          tool: { name: "kestrel_one.search_knowledge_documents", status: "STARTED" },
        },
      },
    }),
    "Searching organization knowledge."
  );
  assert.equal(
    getKestrelStreamProgressText({
      type: "run.reasoning",
      payload: { update: { message: "Checking organization knowledge." } },
    }),
    "Checking organization knowledge."
  );
  assert.equal(
    getKestrelStreamProgressText({
      type: "runner.error",
      payload: { message: "Runner boundary failed." },
    }),
    "Runner boundary failed."
  );
});

test("getKestrelStreamProgressText ignores empty and malformed progress payloads", () => {
  assert.equal(
    getKestrelStreamProgressText({
      type: "run.progress",
      payload: { update: { message: "   " } },
    }),
    ""
  );
  assert.equal(
    getKestrelStreamProgressText({
      type: "run.reasoning",
      payload: { update: { detail: "not a display message" } },
    }),
    ""
  );
});

test("getKestrelStreamUiUpdate ignores unknown event types", () => {
  assert.equal(
    getKestrelStreamUiUpdate({
      type: "task.updated",
      payload: { update: { message: "Hidden task progress." } },
    }),
    null
  );
});

test("getKestrelStreamUiUpdate separates progress from terminal text with severity", () => {
  assert.deepEqual(
    getKestrelStreamUiUpdate({
      type: "run.progress",
      payload: { update: { message: "Working." } },
    }),
    { kind: "progress", severity: "info", text: "Working.", errorMessage: null }
  );
  assert.deepEqual(
    getKestrelStreamUiUpdate({
      type: "runner.error",
      payload: { message: "Runner boundary failed." },
    }),
    {
      kind: "progress",
      severity: "error",
      text: "Runner boundary failed.",
      errorMessage: "Runner boundary failed.",
    }
  );
  assert.deepEqual(
    getKestrelStreamUiUpdate({
      type: "run.failed",
      payload: { error: { message: "Run failed." } },
    }),
    {
      kind: "terminal",
      severity: "error",
      terminalStatus: "failed",
      text: "",
      errorMessage: "Run failed.",
    }
  );
  assert.deepEqual(
    getKestrelStreamUiUpdate({ type: "run.cancelled" }),
    {
      kind: "terminal",
      severity: "cancelled",
      terminalStatus: "cancelled",
      text: "",
      errorMessage: "The run was cancelled before it finished.",
    }
  );
});

test("createKestrelStreamUiUpdateFilter suppresses only consecutive duplicate progress", () => {
  const filter = createKestrelStreamUiUpdateFilter();

  assert.deepEqual(
    filter.read({
      type: "run.progress",
      payload: { update: { message: "Working." } },
    }),
    { kind: "progress", severity: "info", text: "Working.", errorMessage: null }
  );
  assert.equal(
    filter.read({
      type: "run.reasoning",
      payload: { update: { message: "Working." } },
    }),
    null
  );
  assert.deepEqual(
    filter.read({
      type: "run.progress",
      payload: { update: { message: "Checking sources." } },
    }),
    {
      kind: "progress",
      severity: "info",
      text: "Checking sources.",
      errorMessage: null,
    }
  );
  assert.deepEqual(
    filter.read({
      type: "run.completed",
      payload: { result: { assistantText: "Checking sources.", finalizedPayload: { message: "ignored" } } },
    }),
    {
      kind: "terminal",
      severity: "info",
      terminalStatus: "completed",
      text: "Checking sources.",
      errorMessage: null,
    }
  );
});
