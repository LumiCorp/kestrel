import assert from "node:assert/strict";
import test from "node:test";
import { KESTREL_PRESENTATION_DATA_PART_KEYS } from "@kestrel-agents/ai-sdk";
import type { UIMessage } from "ai";
import { CompatibleChatTransport } from "@/lib/chat/compatible-chat-transport";
import type { ChatStreamChunk } from "@/lib/chat/stream-protocol";

async function readAllChunks<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader();
  const chunks: T[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return chunks;
    }

    chunks.push(value);
  }
}

function createEventStreamBody(events: string[]) {
  return events.map((event) => `data: ${event}\n\n`).join("");
}

test("CompatibleChatTransport preserves Kestrel presentation events without a warning", async () => {
  const mockFetch = (async () =>
    new Response(
      createEventStreamBody([
        JSON.stringify({ type: "start", messageId: "assistant-1" }),
        ...KESTREL_PRESENTATION_DATA_PART_KEYS.map((key) =>
          JSON.stringify({
            type: `data-${key}`,
            id: `part-${key}`,
            data: { contractKey: key },
          })
        ),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ]),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    )) as unknown as typeof fetch;

  const transport = new CompatibleChatTransport<UIMessage>({
    api: "/api/threads",
    fetch: mockFetch,
  });
  const chunks = (await readAllChunks(
    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "thread-1",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    })
  )) as ChatStreamChunk[];

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    [
      "start",
      ...KESTREL_PRESENTATION_DATA_PART_KEYS.map((key) => `data-${key}`),
      "finish",
    ]
  );
});

test("CompatibleChatTransport continues text and reports safe diagnostics for rejected events", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  const mockFetch = (async () =>
    new Response(
      createEventStreamBody([
        JSON.stringify({ type: "start", messageId: "assistant-1" }),
        JSON.stringify({ unexpected: true }),
        JSON.stringify({
          type: "response.apply_patch_call_operation_diff.delta",
          delta: "--- bad ---",
        }),
        JSON.stringify({ type: "text-start", id: "text-1" }),
        JSON.stringify({ type: "text-delta", id: "text-1", delta: "Hello" }),
        JSON.stringify({ type: "text-end", id: "text-1" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ]),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    )) as unknown as typeof fetch;

  const transport = new CompatibleChatTransport<UIMessage>({
    api: "/api/threads",
    fetch: mockFetch,
  });

  let chunks: ChatStreamChunk[];
  try {
    chunks = (await readAllChunks(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "thread-1",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    )) as ChatStreamChunk[];
  } finally {
    console.warn = originalWarn;
  }

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
    data: { droppedChunkCount: 2 },
    transient: true,
  });
  assert.deepEqual(warnings, [
    [
      "Chat stream dropped incompatible chunks.",
      {
        droppedChunkCount: 2,
        droppedChunks: [
          {
            count: 1,
            reason: "event_parse_failed",
            type: "unknown",
          },
          {
            count: 1,
            reason: "chunk_rejected",
            type: "response.apply_patch_call_operation_diff.delta",
          },
        ],
      },
    ],
  ]);
  assert.equal(JSON.stringify(warnings).includes("--- bad ---"), false);
});

test("CompatibleChatTransport reconnectToStream returns null for 204 responses", async () => {
  const mockFetch = (async () =>
    new Response(null, {
      status: 204,
      headers: { "Content-Type": "text/event-stream" },
    })) as unknown as typeof fetch;

  const transport = new CompatibleChatTransport<UIMessage>({
    api: "/api/threads",
    fetch: mockFetch,
  });

  const stream = await transport.reconnectToStream({
    chatId: "thread-1",
  });

  assert.equal(stream, null);
});

test("CompatibleChatTransport reconnectToStream prepends a resumed chunk", async () => {
  const mockFetch = (async () =>
    new Response(
      createEventStreamBody([
        JSON.stringify({ type: "start", messageId: "assistant-1" }),
        JSON.stringify({ type: "text-start", id: "text-1" }),
        JSON.stringify({ type: "text-delta", id: "text-1", delta: "Hello" }),
        JSON.stringify({ type: "text-end", id: "text-1" }),
      ]),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    )) as unknown as typeof fetch;

  const transport = new CompatibleChatTransport<UIMessage>({
    api: "/api/threads",
    fetch: mockFetch,
  });

  const chunks = (await readAllChunks(
    (await transport.reconnectToStream({
      chatId: "thread-1",
    })) as ReadableStream<ChatStreamChunk>
  )) as ChatStreamChunk[];

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ["data-stream-resumed", "start", "text-start", "text-delta", "text-end"]
  );
});

test("CompatibleChatTransport reconnectToStream degrades to a warning stream on fetch errors", async () => {
  const mockFetch = (async () => {
    throw new Error("redis unavailable");
  }) as unknown as typeof fetch;

  const transport = new CompatibleChatTransport<UIMessage>({
    api: "/api/threads",
    fetch: mockFetch,
  });

  const chunks = (await readAllChunks(
    (await transport.reconnectToStream({
      chatId: "thread-1",
    })) as ReadableStream<ChatStreamChunk>
  )) as ChatStreamChunk[];

  assert.deepEqual(chunks, [
    {
      type: "data-resume-warning",
      data: {
        message: "Response recovery is temporarily unavailable.",
      },
      transient: true,
    },
  ]);
});

test("CompatibleChatTransport reconnectToStream degrades to a warning chunk on reader errors", async () => {
  const encoder = new TextEncoder();
  let sentFirstChunk = false;
  const mockFetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sentFirstChunk) {
            controller.error(new Error("redis stream lost"));
            return;
          }
          sentFirstChunk = true;
          controller.enqueue(
            encoder.encode(
              createEventStreamBody([
                JSON.stringify({ type: "start", messageId: "assistant-1" }),
              ])
            )
          );
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    )) as unknown as typeof fetch;

  const transport = new CompatibleChatTransport<UIMessage>({
    api: "/api/threads",
    fetch: mockFetch,
  });

  const chunks = (await readAllChunks(
    (await transport.reconnectToStream({
      chatId: "thread-1",
    })) as ReadableStream<ChatStreamChunk>
  )) as ChatStreamChunk[];

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ["data-stream-resumed", "start", "data-resume-warning"]
  );
  assert.deepEqual(chunks.at(-1), {
    type: "data-resume-warning",
    data: {
      message: "Response recovery stopped before the response finished.",
    },
    transient: true,
  });
});
