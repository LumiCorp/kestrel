import assert from "node:assert/strict";
import test from "node:test";
import type {
  KestrelAgent,
  KestrelAgentTurnInput,
  KestrelRequestContext,
} from "@kestrel-agents/sdk";
import { generateKestrelOneExternalReplyFromAgent } from "@/lib/agent/kestrel-external-runtime-core";

const context: KestrelRequestContext = {
  actor: {
    actorId: "kestrel-one:github:bot",
    actorType: "service",
    displayName: "Kestrel One Bot",
    tenantId: "org_123",
  },
  tenantId: "org_123",
};

test("external replies use the hosted chat id and canonical SDK context", async () => {
  let capturedTurn: KestrelAgentTurnInput | undefined;
  let capturedContext: KestrelRequestContext | undefined;
  const agent: Pick<KestrelAgent, "run"> = {
    async run(turn, requestContext) {
      capturedTurn = turn;
      capturedContext = requestContext;
      return {
        id: "event_123",
        type: "run.completed",
        ts: "2026-07-09T12:00:00.000Z",
        sessionId: turn.sessionId,
        runId: "run_123",
        payload: {
          result: {
            output: {
              status: "COMPLETED",
              sessionId: turn.sessionId,
              runId: "run_123",
              errors: [],
              telemetry: {
                inputTokens: 21,
                outputTokens: 8,
                totalTokens: 29,
              },
            },
            finalizedPayload: { message: "Canonical bot reply" },
          },
        },
      };
    },
  };

  const result = await generateKestrelOneExternalReplyFromAgent({
    agent,
    sessionId: "chat_123",
    prompt: "Summarize the thread",
    context,
    clientCapabilities: {
      kestrelOne: {
        tenantId: "org_123",
        capabilities: [{ name: "kestrel_one.search_knowledge_documents" }],
      },
    },
  });

  assert.deepEqual(capturedTurn, {
    sessionId: "chat_123",
    message: "Summarize the thread",
    clientCapabilities: {
      kestrelOne: {
        tenantId: "org_123",
        capabilities: [{ name: "kestrel_one.search_knowledge_documents" }],
      },
    },
  });
  assert.deepEqual(capturedContext, context);
  assert.equal(result.userMessage.role, "user");
  assert.deepEqual(result.userMessage.parts, [
    { type: "text", text: "Summarize the thread" },
  ]);
  assert.equal(result.text, "Canonical bot reply");
  assert.deepEqual(result.usage, {
    inputTokens: 21,
    outputTokens: 8,
    totalTokens: 29,
  });
});

test("external replies surface canonical runner failures", async () => {
  const agent: Pick<KestrelAgent, "run"> = {
    async run(turn) {
      return {
        id: "event_failed",
        type: "run.failed",
        ts: "2026-07-09T12:00:00.000Z",
        sessionId: turn.sessionId,
        runId: "run_failed",
        payload: {
          error: {
            code: "MODEL_UNAVAILABLE",
            message: "The configured model is unavailable.",
          },
        },
      };
    },
  };

  await assert.rejects(
    generateKestrelOneExternalReplyFromAgent({
      agent,
      sessionId: "chat_123",
      prompt: "Try again",
      context,
      clientCapabilities: {},
    }),
    (error: unknown) => {
      assert.equal(
        (error as { message?: string }).message,
        "The configured model is unavailable."
      );
      assert.equal(
        (error as { code?: string }).code,
        "MODEL_UNAVAILABLE"
      );
      return true;
    }
  );
});
