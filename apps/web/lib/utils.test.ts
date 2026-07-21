import assert from "node:assert/strict";
import {
  createAssistantFailureText,
  ensureAssistantFailureVisibility,
  isAssistantFailureText,
  isPersistableAssistantMessage,
  sanitizeMessagesForModelInput,
} from "./utils";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "assistant messages with approval-only tool state are persistable", () => {
  assert.equal(
    isPersistableAssistantMessage({
      id: "msg_approval",
      role: "assistant",
      parts: [
        {
          type: "tool-getWeather",
          toolCallId: "call_1",
          state: "approval-requested",
          approval: {
            id: "approval_1",
          },
          input: {
            city: "San Francisco",
          },
        },
      ],
    }),
    true
  );
});

contractTest("web.hermetic", "assistant messages with completed tool output are persistable", () => {
  assert.equal(
    isPersistableAssistantMessage({
      id: "msg_output",
      role: "assistant",
      parts: [
        {
          type: "tool-getWeather",
          toolCallId: "call_1",
          state: "output-available",
          input: {
            city: "San Francisco",
          },
          output: {
            current: {
              temperature_2m: 72,
            },
          },
        },
      ],
    }),
    true
  );
});

contractTest("web.hermetic", "assistant messages with in-progress tool state are persistable", () => {
  assert.equal(
    isPersistableAssistantMessage({
      id: "msg_pending",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "call_pending",
          state: "input-available",
          input: {
            command: "pwd",
          },
        },
      ],
    }),
    true
  );
});

contractTest("web.hermetic", "sanitizeMessagesForModelInput strips unresolved tool states", () => {
  const sanitized = sanitizeMessagesForModelInput([
    {
      id: "assistant_pending",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-getWeather",
          toolCallId: "call_pending",
          state: "approval-requested" as const,
          approval: { id: "approval_pending" },
          input: { city: "Boston" },
        },
      ],
    },
    {
      id: "assistant_dynamic_pending",
      role: "assistant" as const,
      parts: [
        {
          type: "dynamic-tool",
          toolName: "bash",
          toolCallId: "call_dynamic_pending",
          state: "input-available" as const,
          input: { command: "ls" },
        },
      ],
    },
    {
      id: "assistant_resolved",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-getWeather",
          toolCallId: "call_resolved",
          state: "approval-responded" as const,
          approval: { id: "approval_resolved", approved: true },
          input: { city: "Boston" },
        },
      ],
    },
  ]);

  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].id, "assistant_resolved");
});

contractTest("web.hermetic", "ensureAssistantFailureVisibility appends a persisted failure note", () => {
  const messages = ensureAssistantFailureVisibility(
    [
      {
        id: "assistant_partial",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-bash",
            toolCallId: "call_partial",
            state: "input-available" as const,
            input: { command: "pwd" },
          },
        ],
      },
    ],
    "Weather service timeout"
  );

  assert.equal(messages.length, 1);
  const assistant = messages[0] as {
    role: string;
    parts: Array<{ type: string; text?: string }>;
  };
  assert.equal(assistant.role, "assistant");
  assert.equal(
    assistant.parts.some(
      (part) =>
        part.type === "text" &&
        isAssistantFailureText((part as { text?: string }).text ?? "")
    ),
    true
  );
});

contractTest("web.hermetic", "sanitizeMessagesForModelInput strips persisted failure notes", () => {
  const sanitized = sanitizeMessagesForModelInput([
    {
      id: "assistant_failed",
      role: "assistant" as const,
      parts: [
        {
          type: "text",
          text: createAssistantFailureText("Temporary provider outage"),
        },
      ],
    },
  ]);

  assert.equal(sanitized.length, 0);
});

contractTest("web.hermetic", "ensureAssistantFailureVisibility creates an assistant failure message when needed", () => {
  const messages = ensureAssistantFailureVisibility(
    [
      {
        id: "user_1",
        role: "user" as const,
        parts: [{ type: "text", text: "hello" }],
      },
    ],
    "The selected model is temporarily unavailable."
  );

  assert.equal(messages.length, 2);
  const assistant = messages[1] as
    | {
        role: string;
        parts: Array<{ type: string; text?: string }>;
      }
    | undefined;
  assert.equal(assistant?.role, "assistant");
  assert.equal(
    assistant?.parts.some(
      (part) =>
        part.type === "text" &&
        isAssistantFailureText((part as { text?: string }).text ?? "")
    ),
    true
  );
});
