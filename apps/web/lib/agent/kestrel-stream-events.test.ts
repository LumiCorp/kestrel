import assert from "node:assert/strict";
import test from "node:test";
import {
  createKestrelStreamUiUpdateFilter,
  getKestrelStreamProgressText,
  getKestrelStreamTerminalText,
  getKestrelStreamUiUpdate,
} from "@/lib/agent/kestrel-stream-events";

test("getKestrelStreamTerminalText maps completed payloads", () => {
  assert.equal(
    getKestrelStreamTerminalText({
      type: "run.completed",
      payload: {
        result: {
          finalizedPayload: {
            message: "Runtime answer",
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
      payload: { result: { finalizedPayload: null } },
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

test("getKestrelStreamTerminalText maps failed and cancelled events", () => {
  assert.equal(
    getKestrelStreamTerminalText({
      type: "run.failed",
      payload: {
        error: {
          message: "Runner failed",
        },
      },
    }),
    "Runner failed"
  );
  assert.equal(
    getKestrelStreamTerminalText({ type: "run.cancelled" }),
    "The run was cancelled before it finished."
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
      text: "Run failed.",
      errorMessage: "Run failed.",
    }
  );
  assert.deepEqual(
    getKestrelStreamUiUpdate({ type: "run.cancelled" }),
    {
      kind: "terminal",
      severity: "cancelled",
      terminalStatus: "cancelled",
      text: "The run was cancelled before it finished.",
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
      payload: { result: { finalizedPayload: { message: "Checking sources." } } },
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
