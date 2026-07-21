import assert from "node:assert/strict";
import { KESTREL_PRESENTATION_DATA_PART_KEYS } from "@kestrel-agents/ai-sdk";
import {
  type ChatStreamChunk,
  reorderToolInvocationChunks,
  sanitizeChatStream,
} from "@/lib/chat/stream-protocol";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


function streamFromChunks(chunks: unknown[]) {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function readAllChunks(stream: ReadableStream<ChatStreamChunk>) {
  const reader = stream.getReader();
  const chunks: ChatStreamChunk[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return chunks;
    }

    chunks.push(value);
  }
}

contractTest("web.hermetic", "sanitizeChatStream drops malformed provider chunks and emits one warning", async () => {
  const chunks = await readAllChunks(
    sanitizeChatStream(
      streamFromChunks([
        { type: "start", messageId: "assistant-1" },
        {
          type: "response.reasoning_summary_part.done",
        },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Hello" },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: "stop" },
      ])
    )
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    [
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
      "data-stream-warning",
    ]
  );
  assert.deepEqual(chunks.at(-1), {
    type: "data-stream-warning",
    data: { droppedChunkCount: 1 },
    transient: true,
  });
});

contractTest("web.hermetic", "sanitizeChatStream preserves every shared Kestrel presentation data part", async () => {
  const presentationChunks = KESTREL_PRESENTATION_DATA_PART_KEYS.map((key) => ({
    type: `data-${key}`,
    id: `part-${key}`,
    data: { contractKey: key },
  }));
  const chunks = await readAllChunks(
    sanitizeChatStream(streamFromChunks(presentationChunks))
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    presentationChunks.map((chunk) => chunk.type)
  );
  assert.equal(
    chunks.some((chunk) => chunk.type === "data-stream-warning"),
    false
  );
});

contractTest("web.hermetic", "sanitizeChatStream preserves resumable status data chunks", async () => {
  const chunks = await readAllChunks(
    sanitizeChatStream(
      streamFromChunks([
        {
          type: "data-resume-warning",
          data: {
            message:
              "Response recovery across reloads is temporarily unavailable.",
          },
          transient: true,
        },
        {
          type: "data-stream-resumed",
          data: null,
          transient: true,
        },
      ]),
      { emitWarnings: false }
    )
  );

  assert.deepEqual(chunks, [
    {
      type: "data-resume-warning",
      data: {
        message: "Response recovery across reloads is temporarily unavailable.",
      },
      transient: true,
    },
    {
      type: "data-stream-resumed",
      data: null,
      transient: true,
    },
  ]);
});

contractTest("web.hermetic", "reorderToolInvocationChunks preserves supported tool chunks after sanitization", async () => {
  const chunks = await readAllChunks(
    reorderToolInvocationChunks(
      sanitizeChatStream(
        streamFromChunks([
          {
            type: "tool-input-delta",
            toolCallId: "tool-1",
            inputTextDelta: "{",
          },
          {
            type: "tool-output-available",
            toolCallId: "tool-1",
            output: { ok: true },
          },
          {
            type: "tool-input-start",
            toolCallId: "tool-1",
            toolName: "getWeather",
          },
          {
            type: "tool-input-available",
            toolCallId: "tool-1",
            toolName: "getWeather",
            input: { city: "Boston" },
          },
        ]),
        { emitWarnings: false }
      )
    )
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    [
      "tool-input-start",
      "tool-input-delta",
      "tool-output-available",
      "tool-input-available",
    ]
  );
});
