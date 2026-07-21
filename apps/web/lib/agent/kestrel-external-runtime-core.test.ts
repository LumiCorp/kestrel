import assert from "node:assert/strict";
import type {
  KestrelAgent,
  KestrelAgentTurnInput,
  KestrelRequestContext,
} from "@kestrel-agents/sdk";
import {
  createProfileBoundExternalReplyAgent,
  generateKestrelOneExternalReplyFromAgent,
} from "@/lib/agent/kestrel-external-runtime-core";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const context: KestrelRequestContext = {
  actor: {
    actorId: "kestrel-one:github:bot",
    actorType: "service",
    displayName: "Kestrel One Bot",
    tenantId: "org_123",
  },
  tenantId: "org_123",
};

contractTest("web.hermetic", "external replies use the hosted chat id and canonical SDK context", async () => {
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
            assistantText: "Canonical bot reply",
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
    runId: "run_123",
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
    runId: "run_123",
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

contractTest("web.hermetic", "external replies surface canonical runner failures", async () => {
  const agent: Pick<KestrelAgent, "run"> = {
    async run(turn) {
      return {
        id: "event_failed",
        type: "run.failed",
        ts: "2026-07-09T12:00:00.000Z",
        sessionId: turn.sessionId,
        runId: "run_failed",
        payload: {
          result: {
            assistantText: null,
            output: {
              status: "FAILED",
              sessionId: turn.sessionId,
              runId: "run_failed",
              errors: [{
                code: "MODEL_UNAVAILABLE",
                message: "The configured model is unavailable.",
              }],
            },
          },
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
      assert.equal((error as { code?: string }).code, "MODEL_UNAVAILABLE");
      return true;
    }
  );
});

contractTest("web.hermetic", "external bot replies submit the gateway-managed inline profile", async () => {
  let captured: unknown;
  const profile = {
    id: "kestrel-one:model:approved-model",
    label: "Kestrel One · approved-model",
    agent: "reference-react",
    sessionPrefix: "kestrel-one",
    modelProvider: "openrouter" as const,
    model: "openai/gpt-5.4",
    modelCredential: {
      source: "kestrel-one" as const,
      gatewayId: "gateway-openrouter",
      organizationId: "org-acme",
      environmentId: "env-production",
      rawModelId: "openai/gpt-5.4",
    },
  };
  const agent = createProfileBoundExternalReplyAgent({
    profile,
    async run(request) {
      captured = request;
      return {
        id: "event_123",
        type: "run.completed",
        ts: "2026-07-11T12:00:00.000Z",
        sessionId: request.turn.sessionId,
        runId: "run_123",
        payload: {
          result: {
            assistantText: "done",
            output: {
              status: "COMPLETED",
              sessionId: request.turn.sessionId,
              runId: "run_123",
              errors: [],
            },
            finalizedPayload: { message: "done" },
          },
        },
      };
    },
  });

  await agent.run({ sessionId: "chat_123", message: "Summarize" }, context);

  assert.deepEqual(captured, {
    profile,
    turn: {
      sessionId: "chat_123",
      message: "Summarize",
      eventType: "user.message",
    },
  });
  assert.equal(JSON.stringify(captured).includes("provider-secret"), false);
});
