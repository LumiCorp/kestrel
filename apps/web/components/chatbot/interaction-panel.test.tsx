import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadInteractionView } from "@/lib/turns/client-contract";
import { InteractionPanel } from "./interaction-panel";

const interaction: ThreadInteractionView = {
  id: "interaction-1",
  requestId: "recommendation-1",
  source: "runtime",
  sourceCheckpointId: null,
  kind: "user_input",
  eventType: "user.input",
  prompt: "This action requires Build mode.",
  status: "pending",
  requestEnvelope: {
    metadata: { reason: "acter_mode_blocked", requiredToolClass: "sandboxed_only" },
  },
  responseEnvelope: null,
  responseMessageId: null,
  turnId: "turn-1",
  assistantMessageId: "assistant-1",
  createdAt: "2026-08-13T12:00:00.000Z",
  resolvedAt: null,
};

test("Kestrel One renders an explicit mode switch for the shared runtime contract", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      currentMode="chat"
      interactions={[interaction]}
      onModeSwitch={async () => undefined}
      onResolved={async () => undefined}
      onRuntimeResponse={async () => undefined}
      threadId="thread-1"
    />,
  );
  assert.match(html, /Continue in Build/u);
  assert.match(html, /Switch to Build and continue/u);
});

test("Kestrel One does not guess a mode switch without the explicit contract", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      currentMode="chat"
      interactions={[{
        ...interaction,
        requestEnvelope: { metadata: { reason: "ordinary_question" } },
      }]}
      onModeSwitch={async () => undefined}
      onResolved={async () => undefined}
      onRuntimeResponse={async () => undefined}
      threadId="thread-1"
    />,
  );
  assert.doesNotMatch(html, /Switch to Build/u);
});
