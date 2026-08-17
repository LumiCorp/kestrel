import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { threadTurnBodySchema } from "./thread-turn-request-contract";

const webRoot = path.resolve(import.meta.dirname, "../..");

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

test("Approval turns use one server-owned idempotency key", () => {
  const route = fs.readFileSync(
    path.join(webRoot, "app/api/threads/[id]/route.ts"),
    "utf8"
  );

  assert.match(
    route,
    /const idempotencyKey = approvalResponse\s+\? `approval:\$\{approvalResponse\.approvalId\}`\s+: request\.headers\.get\("idempotency-key"\)/u
  );
});
