import test from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { buildThreadTurnRequestBody } from "./thread-turn-request";

test(
  "Thread turn submissions exclude oversized durable assistant history",
  () => {
    const historicalAssistant: UIMessage = {
      id: "assistant-history",
      role: "assistant",
      parts: Array.from({ length: 238 }, (_, index) => ({
        type: "data-kestrel-progress",
        id: `progress-${index}`,
        data: { message: `Step ${index}` },
      })),
    };
    const currentUserMessage: UIMessage = {
      id: "user-current",
      role: "user",
      parts: [{ type: "text", text: "What should we do next?" }],
    };

    const body = buildThreadTurnRequestBody({
      messages: [
        historicalAssistant,
        currentUserMessage,
      ],
      model: "test-model",
      interactionMode: "build",
    });

    assert.deepEqual(body, {
      message: currentUserMessage,
      model: "test-model",
      interactionMode: "build",
    });
  }
);

test(
  "Thread turn submissions encode approvals without assistant activity history",
  () => {
    const approvalResponse = {
      id: "assistant-approval",
      role: "assistant",
      parts: [
        ...Array.from({ length: 238 }, (_, index) => ({
          type: "data-kestrel-progress",
          id: `progress-${index}`,
          data: { message: `Step ${index}` },
        })),
        {
          type: "dynamic-tool",
          toolName: "deploy",
          toolCallId: "tool-1",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-1", approved: true },
        },
      ],
    } as UIMessage;

    const body = buildThreadTurnRequestBody({
      messages: [
        {
          id: "user-history",
          role: "user",
          parts: [{ type: "text", text: "Deploy it." }],
        },
        approvalResponse,
      ],
      model: "test-model",
      interactionMode: "build",
    });

    assert.deepEqual(body, {
      approvalResponse: {
        messageId: "assistant-approval",
        approvalId: "approval-1",
        approved: true,
      },
      model: "test-model",
      interactionMode: "build",
    });
    assert.equal(JSON.stringify(body).includes("progress-237"), false);
  }
);

test(
  "Thread turn request authority cannot be overridden by caller body fields",
  () => {
    const currentUserMessage: UIMessage = {
      id: "user-current",
      role: "user",
      parts: [{ type: "text", text: "Use the selected mode." }],
    };
    const body = buildThreadTurnRequestBody({
      messages: [currentUserMessage],
      model: "selected-model",
      interactionMode: "plan",
      body: {
        messages: [{ id: "forged-history" }],
        message: { id: "forged-message" },
        approvalResponse: { approvalId: "forged-approval" },
        model: "forged-model",
        interactionMode: "build",
        projectId: "project-1",
      },
    });

    assert.deepEqual(body, {
      message: currentUserMessage,
      model: "selected-model",
      interactionMode: "plan",
      projectId: "project-1",
    });
  }
);

test(
  "Runtime interaction responses exclude incidental UI messages",
  () => {
    const body = buildThreadTurnRequestBody({
      messages: [
        {
          id: "interaction-display-message",
          role: "user",
          parts: [{ type: "text", text: "Allow once" }],
        },
      ],
      model: "selected-model",
      interactionMode: "build",
      body: {
        interactionResponse: {
          requestId: "request-1",
          eventType: "user_input",
          turnId: "turn-1",
          message: "Allow once",
        },
      },
    });

    assert.deepEqual(body, {
      interactionResponse: {
        requestId: "request-1",
        eventType: "user_input",
        turnId: "turn-1",
        message: "Allow once",
      },
      model: "selected-model",
      interactionMode: "build",
    });
  }
);
