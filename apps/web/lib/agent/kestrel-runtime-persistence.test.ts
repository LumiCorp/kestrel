import assert from "node:assert/strict";
import test from "node:test";
import { prepareKestrelRuntimeMessagesForPersistence } from "@/lib/agent/kestrel-runtime-persistence";

test("prepareKestrelRuntimeMessagesForPersistence keeps visible runtime failure text unchanged", () => {
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

  assert.deepEqual(messages, [
    {
      id: "assistant_failed",
      role: "assistant",
      parts: [{ type: "text", text: "Runner failed." }],
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

  assert.equal(assistant.parts.some((part) => part.type === "text"), true);
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

  assert.deepEqual(messages[0]?.parts, [{ type: "text", text: "Final answer." }]);
});
