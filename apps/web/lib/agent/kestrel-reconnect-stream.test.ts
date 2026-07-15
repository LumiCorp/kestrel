import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerRunStreamEvent } from "@kestrel-agents/sdk";
import { writeKestrelReconnectStreamToUi } from "@/lib/agent/kestrel-reconnect-stream";

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
