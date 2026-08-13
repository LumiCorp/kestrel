import test from "node:test";
import assert from "node:assert/strict";
import { threadTurnBodySchema } from "./thread-turn-request-contract";

const userMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Continue." }],
};

test(
  "Thread turn boundary accepts exactly one explicit action",
  () => {
    assert.equal(
      threadTurnBodySchema.safeParse({ message: userMessage }).success,
      true
    );
    assert.equal(
      threadTurnBodySchema.safeParse({
        approvalResponse: {
          messageId: "assistant-1",
          approvalId: "approval-1",
          approved: true,
        },
      }).success,
      true
    );
    assert.equal(
      threadTurnBodySchema.safeParse({
        interactionResponse: {
          requestId: "request-1",
          eventType: "user_input",
          turnId: "turn-1",
          message: "Continue",
        },
      }).success,
      true
    );
  }
);

test(
  "Thread turn boundary rejects history replay and ambiguous actions",
  () => {
    assert.equal(
      threadTurnBodySchema.safeParse({ messages: [userMessage] }).success,
      false
    );
    assert.equal(
      threadTurnBodySchema.safeParse({
        message: userMessage,
        approvalResponse: {
          messageId: "assistant-1",
          approvalId: "approval-1",
          approved: true,
        },
      }).success,
      false
    );
    assert.equal(
      threadTurnBodySchema.safeParse({
        message: { ...userMessage, role: "assistant" },
      }).success,
      false
    );
  }
);
