import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadInteractionView } from "./client-contract";
import {
  executeKestrelOneComposerModeSelection,
  filterKestrelOneComposerControlMessages,
  resolveKestrelOneComposerModeSelection,
} from "./composer-mode-selection";

const modeSwitchInteraction: ThreadInteractionView = {
  id: "interaction-1",
  requestId: "request-1",
  source: "runtime",
  sourceCheckpointId: null,
  kind: "user_input",
  eventType: "user.reply",
  prompt: "Build mode is required to continue.",
  status: "pending",
  requestEnvelope: {
    metadata: {
      reason: "acter_mode_blocked",
      requiredToolClass: "sandboxed_only",
    },
  },
  responseEnvelope: null,
  responseMessageId: null,
  turnId: "turn-1",
  assistantMessageId: "assistant-1",
  createdAt: "2026-08-20T12:00:00.000Z",
  resolvedAt: null,
};

test("the requested composer mode resumes the typed waiting interaction", () => {
  assert.deepEqual(
    resolveKestrelOneComposerModeSelection({
      currentMode: "chat",
      interactions: [modeSwitchInteraction],
      selectedMode: "build",
    }),
    {
      kind: "resume_mode_switch",
      interaction: modeSwitchInteraction,
    },
  );
});

test("other composer selections remain ordinary mode changes", () => {
  assert.deepEqual(
    resolveKestrelOneComposerModeSelection({
      currentMode: "chat",
      interactions: [modeSwitchInteraction],
      selectedMode: "plan",
    }),
    { kind: "change_mode" },
  );
  assert.deepEqual(
    resolveKestrelOneComposerModeSelection({
      currentMode: "chat",
      interactions: [
        {
          ...modeSwitchInteraction,
          requestEnvelope: { metadata: { reason: "ordinary_question" } },
        },
      ],
      selectedMode: "build",
    }),
    { kind: "change_mode" },
  );
});

test("composer selection resumes a typed mode switch without a separate change event", async () => {
  const calls: string[] = [];
  await executeKestrelOneComposerModeSelection({
    currentMode: "chat",
    interactions: [modeSwitchInteraction],
    selectedMode: "build",
    changeMode: async (mode) => {
      calls.push(`change:${mode}`);
    },
    resumeModeSwitch: async (interaction, mode) => {
      calls.push(`resume:${interaction.requestId}:${mode}`);
    },
    onResumeFailure: () => {},
  });
  assert.deepEqual(calls, ["resume:request-1:build"]);
});

test("ordinary composer selection only saves the selected mode", async () => {
  const calls: string[] = [];
  await executeKestrelOneComposerModeSelection({
    currentMode: "chat",
    interactions: [],
    selectedMode: "plan",
    changeMode: async (mode) => {
      calls.push(`change:${mode}`);
    },
    resumeModeSwitch: async () => {
      calls.push("resume");
    },
    onResumeFailure: () => {},
  });
  assert.deepEqual(calls, ["change:plan"]);
});

test("mode selector control responses stay out of optimistic and durable presentation", () => {
  const messages = [
    {
      id: "ordinary-response",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Ordinary response" }],
    },
    {
      id: "mode-response",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "/mode build" }],
    },
  ];
  assert.deepEqual(
    filterKestrelOneComposerControlMessages({
      interactions: [modeSwitchInteraction],
      messages,
      optimisticControlMessageIds: new Set(["mode-response"]),
    }),
    [messages[0]],
  );
  assert.deepEqual(
    filterKestrelOneComposerControlMessages({
      interactions: [
        {
          ...modeSwitchInteraction,
          status: "resolved",
          responseEnvelope: { message: "/mode build" },
          responseMessageId: "mode-response",
          resolvedAt: "2026-08-20T12:01:00.000Z",
        },
      ],
      messages,
      optimisticControlMessageIds: new Set(),
    }),
    [messages[0]],
  );
});

test("ordinary interaction responses remain visible", () => {
  const message = {
    id: "ordinary-response",
    role: "user" as const,
    parts: [{ type: "text" as const, text: "Kestrel" }],
  };
  assert.deepEqual(
    filterKestrelOneComposerControlMessages({
      interactions: [
        {
          ...modeSwitchInteraction,
          requestEnvelope: { metadata: { reason: "ordinary_question" } },
          status: "resolved",
          responseEnvelope: { message: "Kestrel" },
          responseMessageId: message.id,
          resolvedAt: "2026-08-20T12:01:00.000Z",
        },
      ],
      messages: [message],
      optimisticControlMessageIds: new Set(),
    }),
    [message],
  );
});

test("selector resume failures are reported without rejecting into React", async () => {
  const failures: unknown[] = [];
  const result = await executeKestrelOneComposerModeSelection({
    currentMode: "chat",
    interactions: [modeSwitchInteraction],
    selectedMode: "build",
    changeMode: async () => {},
    resumeModeSwitch: async () => {
      throw new Error("resume failed");
    },
    onResumeFailure: (error) => {
      failures.push(error);
    },
  });
  assert.equal(result, false);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /resume failed/u);
});
