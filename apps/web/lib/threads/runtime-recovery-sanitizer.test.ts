import assert from "node:assert/strict";
import test from "node:test";

import {
  readLostRuntimeInteractionPresentation,
  stripLostRuntimeInteractionParts,
} from "./runtime-recovery-sanitizer";

test("recovery strips only the lost interaction part and its answer", () => {
  const lost = readLostRuntimeInteractionPresentation([
    {
      requestId: "lost-request",
      assistantMessageId: "assistant-2",
      responseEnvelope: { messageId: "answer-2" },
    },
  ]);
  assert.deepEqual([...lost.responseMessageIds], ["answer-2"]);
  assert.deepEqual(
    stripLostRuntimeInteractionParts(
      [
        { type: "text", text: "ordinary assistant context" },
        {
          type: "data-kestrel-interaction",
          data: { requestId: "earlier-request" },
        },
        {
          type: "data-kestrel-interaction",
          data: { requestId: "lost-request" },
        },
      ],
      lost.requestsByAssistantMessage.get("assistant-2")!,
    ),
    [
      { type: "text", text: "ordinary assistant context" },
      {
        type: "data-kestrel-interaction",
        data: { requestId: "earlier-request" },
      },
    ],
  );
});
