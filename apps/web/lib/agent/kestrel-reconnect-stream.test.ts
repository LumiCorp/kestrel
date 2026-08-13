import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerRunStreamEvent } from "@kestrel-agents/sdk";
import {
  createRecoveredKestrelOneCompletion,
  writeKestrelReconnectStreamToUi,
} from "@/lib/agent/kestrel-reconnect-stream";
import { readRequestedInteractionMode } from "@/lib/agent/kestrel-runtime-core";


test("writeKestrelReconnectStreamToUi keeps runner error as fallback until terminal text arrives", async () => {
  const writer = createChunkWriter();

  await writeKestrelReconnectStreamToUi({
    writer,
    assistantMessageId: "msg_assistant",
    textPartId: "text_part",
    reasoningPartId: "reasoning_part",
    events: streamFromEvents([
      {
        id: "runner-error-1",
        type: "runner.error",
        ts: "2026-05-06T00:00:00.000Z",
        payload: { code: "RUNNER_ERROR", message: "Runner boundary failed." },
      },
      completedEvent("Final answer"),
    ]),
  });

  const output = JSON.stringify(writer.chunks);

  assert.match(output, /Runner boundary failed/);
  assert.match(output, /Final answer/);
  assert.equal(countOccurrences(output, "Final answer"), 1);
  assert.equal(
    writer.chunks.find(
      (chunk) => chunk.type === "text-delta" && chunk.delta === "Final answer"
    )?.delta,
    "Final answer"
  );
});

test("writeKestrelReconnectStreamToUi emits runner error fallback when no terminal text arrives", async () => {
  const writer = createChunkWriter();

  await writeKestrelReconnectStreamToUi({
    writer,
    assistantMessageId: "msg_assistant",
    textPartId: "text_part",
    reasoningPartId: "reasoning_part",
    events: streamFromEvents([
      {
        id: "runner-error-2",
        type: "runner.error",
        ts: "2026-05-06T00:00:00.000Z",
        payload: { code: "RUNNER_ERROR", message: "Runner boundary failed." },
      },
    ]),
  });

  const output = JSON.stringify(writer.chunks);

  assert.equal(countOccurrences(output, "Runner boundary failed."), 1);
});

test("completed conversation recovery preserves the exact run's preview answer", () => {
  const previewAnswer = "Preview: https://example.test/preview/recovered";
  const terminal = createRecoveredKestrelOneCompletion({
    runtimeRunId: "run-recovered",
    sessionId: "session-recovered",
    terminalEventId: "event-recovered-completed",
    completedAt: "2026-05-06T00:00:01.000Z",
    messages: [
      {
        messageId: "terminal:run-other",
        turnId: "turn-other",
        threadId: "session-recovered",
        sessionId: "session-recovered",
        runId: "run-other",
        completedAt: "2026-05-06T00:00:00.000Z",
        result: {
          assistantText: "Wrong answer",
          output: {
            status: "COMPLETED",
            sessionId: "session-recovered",
            runId: "run-other",
            errors: [],
          },
        },
      },
      {
        messageId: "terminal:run-recovered",
        turnId: "turn-recovered",
        threadId: "session-recovered",
        sessionId: "session-recovered",
        runId: "run-recovered",
        completedAt: "2026-05-06T00:00:01.000Z",
        result: {
          assistantText: previewAnswer,
          finalizedPayload: {
            payload: { data: { modeSwitch: { mode: "build" } } },
          },
          output: {
            status: "COMPLETED",
            sessionId: "session-recovered",
            runId: "run-recovered",
            errors: [],
          },
        },
      },
    ],
  });

  assert.equal(terminal.type, "run.completed");
  assert.equal(terminal.payload.result.assistantText, previewAnswer);
  assert.equal(terminal.payload.result.output.runId, "run-recovered");
  assert.equal(
    readRequestedInteractionMode(terminal.payload.result.finalizedPayload),
    "build",
  );
});

function createChunkWriter() {
  const chunks: Array<{ type: string; delta?: string }> = [];
  return {
    chunks,
    write(chunk: { type: string; delta?: string }) {
      chunks.push(chunk);
    },
  };
}

async function* streamFromEvents(events: RunnerRunStreamEvent[]) {
  for (const event of events) {
    yield event;
  }
}

function completedEvent(assistantText: string): RunnerRunStreamEvent {
  return {
    id: "run-completed",
    type: "run.completed",
    ts: "2026-05-06T00:00:01.000Z",
    runId: "run-1",
    sessionId: "session-1",
    payload: {
      result: {
        assistantText,
        finalizedPayload: { message: "ignored" },
        output: {
          status: "COMPLETED",
          sessionId: "session-1",
          runId: "run-1",
          errors: [],
        },
      },
    },
  };
}

function countOccurrences(input: string, needle: string) {
  return input.split(needle).length - 1;
}
