import assert from "node:assert/strict";
import test from "node:test";
import { writeKestrelReconnectStreamToUi } from "@/lib/agent/kestrel-reconnect-stream";
import type { KestrelStreamEventForUi } from "@/lib/agent/kestrel-stream-events";

test("writeKestrelReconnectStreamToUi keeps runner error as fallback until terminal text arrives", async () => {
  const writer = createChunkWriter();

  await writeKestrelReconnectStreamToUi({
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
        payload: { result: { finalizedPayload: { message: "Final answer" } } },
      },
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
        type: "runner.error",
        payload: { message: "Runner boundary failed." },
      },
    ]),
  });

  const output = JSON.stringify(writer.chunks);

  assert.equal(countOccurrences(output, "Runner boundary failed."), 2);
  assert.ok(
    output.indexOf("reasoning-end") <
      output.lastIndexOf("Runner boundary failed."),
    "reasoning should close before the fallback assistant text"
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

async function* streamFromEvents(events: KestrelStreamEventForUi[]) {
  for (const event of events) {
    yield event;
  }
}

function countOccurrences(input: string, needle: string) {
  return input.split(needle).length - 1;
}
