import assert from "node:assert/strict";
import { prepareKestrelRuntimeMessagesForPersistence } from "@/lib/agent/kestrel-runtime-persistence";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "live failure visibility cannot waive canonical durable failure text", () => {
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
      text: "The previous response failed before completion. Reason: Runner failed. You can retry the request.",
    },
  ]);
});

contractTest("web.hermetic", "prepareKestrelRuntimeMessagesForPersistence keeps legacy failure fallback when failure is not visible", () => {
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

contractTest("web.hermetic", "prepareKestrelRuntimeMessagesForPersistence never retains provider reasoning parts", () => {
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
