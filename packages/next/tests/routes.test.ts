import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { KestrelAgent, KestrelAgentTurnInput, KestrelRequestContext, RunnerRunTerminalEvent, RunnerStream, RunnerStreamEvent } from "@kestrel-agents/sdk";
import {
  createJsonRunRouteHandler,
  createStreamRunRouteHandler,
  createWebhookRunRouteHandler,
  readRequestCorrelation,
} from "../src/index.js";

test("createJsonRunRouteHandler runs the agent and propagates correlation headers", async () => {
  const seen: Array<{ input: KestrelAgentTurnInput; context: KestrelRequestContext }> = [];
  const handler = createJsonRunRouteHandler({
    agent: createFakeAgent(seen),
    async resolveContext() {
      return {
        actor: {
          actorId: "user-1",
          actorType: "end_user",
        },
      };
    },
  });

  const response = await handler(new Request("http://localhost/api/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "req-1",
    },
    body: JSON.stringify({
      sessionId: "session-1",
      message: "hello",
    }),
  }));

  const body = await response.json() as RunnerRunTerminalEvent;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-kestrel-request-id"), "req-1");
  assert.equal(body.type, "run.completed");
  assert.equal(seen[0]?.input.sessionId, "session-1");
});

test("createStreamRunRouteHandler emits SSE events", async () => {
  const seen: Array<{ input: KestrelAgentTurnInput; context: KestrelRequestContext }> = [];
  const handler = createStreamRunRouteHandler({
    agent: createFakeAgent(seen),
    async resolveContext() {
      return {
        actor: {
          actorId: "user-1",
          actorType: "end_user",
        },
      };
    },
  });

  const response = await handler(new Request("http://localhost/api/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "session-2",
      message: "stream me",
    }),
  }));

  const text = await response.text();
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.match(text, /event: run.started/);
  assert.match(text, /event: run.completed/);
});

test("createWebhookRunRouteHandler maps webhook payloads into agent inputs", async () => {
  const seen: Array<{ input: KestrelAgentTurnInput; context: KestrelRequestContext }> = [];
  const handler = createWebhookRunRouteHandler<{ session: string; prompt: string }>({
    agent: createFakeAgent(seen),
    async resolveContext() {
      return {
        actor: {
          actorId: "webhook-1",
          actorType: "service",
        },
      };
    },
    mapPayload(payload) {
      return {
        sessionId: payload.session,
        message: payload.prompt,
      };
    },
  });

  const response = await handler(new Request("http://localhost/api/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": "corr-1",
    },
    body: JSON.stringify({
      session: "session-3",
      prompt: "process webhook",
    }),
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-kestrel-correlation-id"), "corr-1");
  assert.equal(seen[0]?.input.sessionId, "session-3");
});

test("createStreamRunRouteHandler tolerates client cancellation before the first event arrives", async () => {
  let cancelCalled = false;
  let releaseCancelled: (() => void) | undefined;
  const cancelled = new Promise<void>((resolve) => {
    releaseCancelled = resolve;
  });

  const handler = createStreamRunRouteHandler({
    agent: {
      ...createFakeAgent([]),
      stream(input): RunnerStream<RunnerStreamEvent, RunnerRunTerminalEvent> {
        const terminal: RunnerRunTerminalEvent = {
          id: "evt-run-cancelled",
          type: "run.cancelled",
          ts: new Date().toISOString(),
          sessionId: input.sessionId,
          runId: "run-cancelled",
          payload: {
            sessionId: input.sessionId,
            runId: "run-cancelled",
          },
        };
        return {
          result: cancelled.then(() => terminal),
          async cancel() {
            cancelCalled = true;
            releaseCancelled?.();
          },
          async *[Symbol.asyncIterator]() {
            await delay(25);
            yield {
              id: "evt-run-started-delayed",
              type: "run.started",
              ts: new Date().toISOString(),
              sessionId: input.sessionId,
              payload: {
                sessionId: input.sessionId,
                eventType: input.eventType ?? "user.message",
              },
            };
            yield terminal;
          },
        };
      },
    },
    async resolveContext() {
      return {
        actor: {
          actorId: "user-1",
          actorType: "end_user",
        },
      };
    },
  });

  const response = await handler(new Request("http://localhost/api/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "session-cancel-early",
      message: "cancel me",
    }),
  }));

  await response.body?.cancel();
  await delay(50);
  assert.equal(cancelCalled, true);
});

test("readRequestCorrelation falls back to a generated request id", () => {
  const correlation = readRequestCorrelation(new Request("http://localhost"));
  assert.ok(correlation.requestId.length > 0);
  assert.equal(correlation.correlationId, correlation.requestId);
});

function createFakeAgent(seen: Array<{ input: KestrelAgentTurnInput; context: KestrelRequestContext }>): KestrelAgent {
  return {
    id: "support-agent",
    profileId: "support",
    async run(input, context) {
      seen.push({ input, context });
      return {
        id: "evt-run-completed",
        type: "run.completed",
        ts: new Date().toISOString(),
        sessionId: input.sessionId,
        runId: `run-${seen.length}`,
        payload: {
          result: {
            assistantText: null,
            output: {
              status: "COMPLETED",
              sessionId: input.sessionId,
              runId: `run-${seen.length}`,
              errors: [],
            },
          },
        },
      };
    },
    stream(input, context): RunnerStream<RunnerStreamEvent, RunnerRunTerminalEvent> {
      seen.push({ input, context });
      const terminal: RunnerRunTerminalEvent = {
        id: "evt-run-completed",
        type: "run.completed",
        ts: new Date().toISOString(),
        sessionId: input.sessionId,
        runId: `run-${seen.length}`,
        payload: {
          result: {
            assistantText: null,
            output: {
              status: "COMPLETED",
              sessionId: input.sessionId,
              runId: `run-${seen.length}`,
              errors: [],
            },
          },
        },
      };
      return {
        result: Promise.resolve(terminal),
        async cancel() {},
        async *[Symbol.asyncIterator]() {
          yield {
            id: "evt-run-started",
            type: "run.started",
            ts: new Date().toISOString(),
            sessionId: input.sessionId,
            payload: {
              sessionId: input.sessionId,
              eventType: input.eventType ?? "user.message",
            },
          };
          yield terminal;
        },
      };
    },
    async resume(input, context) {
      return this.run(input, context);
    },
    subscribe() {
      return {
        result: Promise.resolve(),
        async cancel() {},
        async *[Symbol.asyncIterator]() {},
      };
    },
    session() {
      return {
        async get() {
          return {
            sessionId: "session-1",
            version: 1,
            memory: {
              goal: "",
              currentPlan: "",
              findings: "",
              decisions: "",
              openQuestions: "",
              nextAction: "",
              linkedArtifacts: [],
            },
            memoryRevision: 1,
          };
        },
        memory: {
          async get() {
            return {
              revision: 1,
              value: {
                goal: "",
                currentPlan: "",
                findings: "",
                decisions: "",
                openQuestions: "",
                nextAction: "",
                linkedArtifacts: [],
              },
            };
          },
          async update() {
            return {
              revision: 2,
              value: {
                goal: "",
                currentPlan: "",
                findings: "",
                decisions: "",
                openQuestions: "",
                nextAction: "",
                linkedArtifacts: [],
              },
            };
          },
        },
      };
    },
    async close() {},
  };
}
