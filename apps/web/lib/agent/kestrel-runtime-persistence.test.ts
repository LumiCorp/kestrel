import test from "node:test";
import assert from "node:assert/strict";
import {
  appendKestrelUiChunkIfDurable,
  buildKestrelFailureReplayChunks,
  isLiveOnlyKestrelUiChunk,
  prepareKestrelRuntimeMessagesForPersistence,
  readKestrelReplayScaffoldChunk,
  readTerminalKestrelUiChunk,
} from "@/lib/agent/kestrel-runtime-persistence";


test("live failure visibility cannot waive canonical durable failure text", () => {
  const messages = prepareKestrelRuntimeMessagesForPersistence(
    [
      {
        id: "assistant_failed",
        role: "assistant" as const,
        parts: [{ type: "text", text: "Runner failed." }],
      },
    ],
    {
      errorMessage: "Runner failed.",
      failureVisible: true,
    }
  );

  assert.deepEqual(messages[0]?.parts, [
    { type: "text", text: "Runner failed." },
    {
      type: "text",
      text: "The previous response failed before completion. Reason: Runner failed. Send a new message to continue.",
    },
  ]);
});

test("prepareKestrelRuntimeMessagesForPersistence keeps legacy failure fallback when failure is not visible", () => {
  const messages = prepareKestrelRuntimeMessagesForPersistence(
    [
      {
        id: "assistant_partial",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-bash",
            toolCallId: "call_1",
            state: "input-available" as const,
            input: { command: "pwd" },
          },
        ],
      },
    ],
    {
      errorMessage: "Runner failed.",
      failureVisible: false,
    }
  );

  const assistant = messages[0] as {
    parts: Array<{ type: string; text?: string }>;
  };

  assert.equal(
    assistant.parts.some((part) => part.type === "text"),
    true
  );
});

test("prepareKestrelRuntimeMessagesForPersistence never retains provider reasoning parts", () => {
  const messages = prepareKestrelRuntimeMessagesForPersistence(
    [
      {
        id: "assistant_reasoning",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "Final answer." },
          {
            type: "data-kestrel-provider-reasoning",
            data: {
              label: "Provider-visible thinking",
              delta: "This must remain live-only.",
            },
          },
        ],
      },
    ] as Parameters<typeof prepareKestrelRuntimeMessagesForPersistence>[0],
    {
      errorMessage: null,
      failureVisible: false,
    }
  );

  assert.deepEqual(messages[0]?.parts, [
    { type: "text", text: "Final answer." },
  ]);
});

test("live-only runtime chunks are rejected at the durable turn boundary", () => {
  assert.equal(
    isLiveOnlyKestrelUiChunk({
      type: "data-kestrel-provider-reasoning",
      data: { delta: "private" },
    }),
    true,
  );
  assert.equal(
    isLiveOnlyKestrelUiChunk({
      type: "data-kestrel-progress",
      data: { persist: false, code: "RUN_STILL_ACTIVE" },
    }),
    true,
  );
  assert.equal(
    isLiveOnlyKestrelUiChunk({
      type: "data-kestrel-progress",
      data: { persist: true, code: "MODEL_ATTEMPT_RETRYING" },
    }),
    false,
  );
});

test(
  "durable turn event writes exclude reasoning and live progress",
  async () => {
    const written: unknown[] = [];
    const append = async (chunk: unknown) => {
      written.push(chunk);
    };

    assert.equal(
      await appendKestrelUiChunkIfDurable(
        {
          type: "data-kestrel-provider-reasoning",
          data: { delta: "private reasoning" },
        },
        append,
      ),
      false,
    );
    assert.equal(
      await appendKestrelUiChunkIfDurable(
        {
          type: "data-kestrel-progress",
          data: { persist: false, code: "RUN_STILL_ACTIVE" },
        },
        append,
      ),
      false,
    );
    const retry = {
      type: "data-kestrel-progress",
      data: { persist: true, code: "MODEL_ATTEMPT_RETRYING" },
    };
    assert.equal(
      await appendKestrelUiChunkIfDurable(retry, append),
      true,
    );
    assert.deepEqual(written, [retry]);
  },
);

test(
  "terminal response chunks are staged while nonterminal progress remains durable",
  () => {
    const terminalChunks = [
      {
        type: "data-kestrel-status",
        data: { status: "completed" },
      },
      { type: "text-delta", id: "text-1", delta: "Final answer." },
      { type: "text-end", id: "text-1" },
      {
        type: "message-metadata",
        messageMetadata: { kestrelTerminalStatus: "completed" },
      },
      { type: "data-chat-title", data: { title: "Final title" } },
      { type: "data-interaction-mode", data: { mode: "build" } },
      { type: "finish", finishReason: "stop" },
    ];
    for (const chunk of terminalChunks) {
      assert.deepEqual(readTerminalKestrelUiChunk(chunk), chunk);
    }
    assert.equal(
      readTerminalKestrelUiChunk({
        type: "data-kestrel-progress",
        data: { persist: true },
      }),
      null,
    );
    assert.equal(
      readTerminalKestrelUiChunk({ type: "start", messageId: "assistant-1" }),
      null,
    );
    assert.throws(
      () => readTerminalKestrelUiChunk({ type: "finish" }),
      /finish reason is invalid/u,
    );
  },
);

test(
  "failure replay replaces terminal output on the existing stream scaffold",
  () => {
    assert.deepEqual(
      readKestrelReplayScaffoldChunk({
        type: "start",
        messageId: "assistant-1",
      }),
      { assistantMessageId: "assistant-1" },
    );
    assert.deepEqual(
      readKestrelReplayScaffoldChunk({ type: "text-start", id: "text-1" }),
      { textPartId: "text-1" },
    );
    const chunks = buildKestrelFailureReplayChunks({
      assistantMessageId: "assistant-1",
      textPartId: "text-1",
      turnId: "turn-1",
      status: "failed",
      text: "The turn was interrupted.",
      errorMessage: "Worker lost.",
      includeStart: false,
      includeTextStart: false,
    });
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      [
        "data-kestrel-status",
        "text-delta",
        "text-end",
        "message-metadata",
        "finish",
      ],
    );
    assert.equal(
      chunks.some(
        (chunk) =>
          chunk.type === "text-delta" && chunk.delta === "Final answer.",
      ),
      false,
    );
    assert.deepEqual(chunks.at(-1), {
      type: "finish",
      finishReason: "stop",
    });
  },
);

test("final message persistence removes live-only progress defense in depth", () => {
  const messages = prepareKestrelRuntimeMessagesForPersistence(
    [
      {
        id: "assistant_live_progress",
        role: "assistant" as const,
        parts: [
          {
            type: "data-kestrel-progress",
            data: {
              persist: false,
              code: "RUN_STILL_ACTIVE",
              text: "Still working.",
            },
          },
          { type: "text", text: "Final answer." },
        ],
      },
    ] as Parameters<typeof prepareKestrelRuntimeMessagesForPersistence>[0],
    {
      errorMessage: null,
      failureVisible: false,
    },
  );

  assert.deepEqual(messages[0]?.parts, [
    { type: "text", text: "Final answer." },
  ]);
});
