import assert from "node:assert/strict";
import test from "node:test";
import { writeKestrelRunnerEventsToUi } from "@/lib/agent/kestrel-ui-stream";
import type { KestrelStreamEventForUi } from "@/lib/agent/kestrel-stream-events";

test("writeKestrelRunnerEventsToUi keeps runner error in reasoning but completed terminal text wins", async () => {
  const writer = createChunkWriter();

  const result = await writeKestrelRunnerEventsToUi({
    writer,
    assistantMessageId: "msg_assistant",
    textPartId: "text_part",
    reasoningPartId: "reasoning_part",
    events: streamFromEvents([
      {
        type: "runner.error",
        payload: { message: "Runner boundary failed." },
      },
      {
        type: "run.completed",
        payload: { result: { assistantText: "Final answer", finalizedPayload: { message: "ignored" } } },
      },
    ]),
  });

  const output = JSON.stringify(writer.chunks);

  assert.equal(result.terminalStatus, "completed");
  assert.equal(result.finalText, "Final answer");
  assert.equal(result.errorMessage, null);
  assert.match(output, /Runner boundary failed/);
  assert.equal(countOccurrences(output, "Final answer"), 1);
});

test("writeKestrelRunnerEventsToUi keeps thrown runner errors out of assistant text", async () => {
  const writer = createChunkWriter();

  const result = await writeKestrelRunnerEventsToUi({
    writer,
    assistantMessageId: "msg_assistant",
    textPartId: "text_part",
    reasoningPartId: "reasoning_part",
    events: throwingStream(new Error("Subscription denied.")),
  });

  const output = JSON.stringify(writer.chunks);

  assert.equal(result.terminalStatus, "runner_error");
  assert.equal(result.finalText, "");
  assert.equal(result.errorMessage, "Subscription denied.");
  assert.equal(countOccurrences(output, "Subscription denied."), 1);
});

test("writeKestrelRunnerEventsToUi maps failed and cancelled terminal statuses", async () => {
  const failed = await writeKestrelRunnerEventsToUi({
    writer: createChunkWriter(),
    assistantMessageId: "msg_failed",
    textPartId: "text_failed",
    reasoningPartId: "reasoning_failed",
    events: streamFromEvents([
      {
        type: "run.failed",
        payload: { error: { message: "Runner failed." } },
      },
    ]),
  });
  const cancelled = await writeKestrelRunnerEventsToUi({
    writer: createChunkWriter(),
    assistantMessageId: "msg_cancelled",
    textPartId: "text_cancelled",
    reasoningPartId: "reasoning_cancelled",
    events: streamFromEvents([{ type: "run.cancelled" }]),
  });

  assert.deepEqual(
    {
      finalText: failed.finalText,
      terminalStatus: failed.terminalStatus,
      errorMessage: failed.errorMessage,
    },
    {
      finalText: "",
      terminalStatus: "failed",
      errorMessage: "Runner failed.",
    }
  );
  assert.deepEqual(
    {
      finalText: cancelled.finalText,
      terminalStatus: cancelled.terminalStatus,
      errorMessage: cancelled.errorMessage,
    },
    {
      finalText: "",
      terminalStatus: "cancelled",
      errorMessage: "The run was cancelled before it finished.",
    }
  );
});

test("writeKestrelRunnerEventsToUi suppresses duplicate and blank progress but preserves matching final text", async () => {
  const writer = createChunkWriter();

  const result = await writeKestrelRunnerEventsToUi({
    writer,
    assistantMessageId: "msg_assistant",
    textPartId: "text_part",
    reasoningPartId: "reasoning_part",
    events: streamFromEvents([
      { type: "run.progress", payload: { update: { message: "Working." } } },
      { type: "run.reasoning", payload: { update: { message: "Working." } } },
      { type: "run.progress", payload: { update: { message: "   " } } },
      {
        type: "run.completed",
        payload: { result: { assistantText: "Working.", finalizedPayload: { message: "ignored" } } },
      },
    ]),
  });

  const output = JSON.stringify(writer.chunks);

  assert.equal(result.finalText, "Working.");
  assert.equal(countOccurrences(output, "Working."), 2);
});

function createChunkWriter() {
  const chunks: Array<{ type: string; delta?: string; messageMetadata?: unknown }> =
    [];
  return {
    chunks,
    write(chunk: { type: string; delta?: string; messageMetadata?: unknown }) {
      chunks.push(chunk);
    },
  };
}

async function* streamFromEvents(events: KestrelStreamEventForUi[]) {
  for (const event of events) {
    yield event;
  }
}

async function* throwingStream(error: unknown): AsyncIterable<KestrelStreamEventForUi> {
  yield { type: "run.progress", payload: { update: { message: "Starting." } } };
  throw error;
}

function countOccurrences(input: string, needle: string) {
  return input.split(needle).length - 1;
}
