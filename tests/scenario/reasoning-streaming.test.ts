import assert from "node:assert/strict";
import test from "node:test";

import {
  Kestrel,
  RunReplayService,
  type ModelRequest,
  type ReasoningUpdateV1,
  RetryingModelGateway,
} from "../../src/index.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

test("Kestrel emits live reasoning updates and persists reasoning.update events", async () => {
  const store = new InMemorySessionStore();
  const updates: ReasoningUpdateV1[] = [];

  const kestrel = new Kestrel({
    store,
    toolGateway: {
      async call<T>(): Promise<T> {
        throw new Error("tools should not be called");
      },
    },
    modelGateway: new RetryingModelGateway(async <T>(request: ModelRequest) => {
      if (request.metadata?.stream === "reasoning_sidecar") {
        return {
          text: "I am converging on the final response. I'm ready to finalize.",
          toolIntents: [],
          provider: {
            name: "openai",
            model: "gpt-5-nano",
            endpoint: "chat",
          },
        } as T;
      }
      return { ok: true } as T;
    }),
    reasoningListener: (update) => {
      updates.push(update);
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "COMPLETED",
    statePatch: {
      agent: {
        observations: [],
        capabilityEvidence: {},
        exec: {},
        phase: "ACT",
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-reasoning-1",
    type: "user.message",
    sessionId: "session-reasoning-1",
    payload: {
      message: "run",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(updates.length > 0, true);
  assert.equal(updates[0]!.milestone, "run_terminal");
  assert.equal(updates[0]!.message.startsWith("I "), true);

  const replay = await new RunReplayService(store).replay({ runId: output.runId });
  const reasoningEvents = replay.events.filter((event) => event.type === "reasoning.update");
  assert.equal(reasoningEvents.length > 0, true);
  assert.equal(
    typeof reasoningEvents[0]?.metadata?.message === "string",
    true,
  );
});

test("reasoning sidecar failures do not fail runtime execution", async () => {
  const store = new InMemorySessionStore();
  const updates: ReasoningUpdateV1[] = [];

  const kestrel = new Kestrel({
    store,
    toolGateway: {
      async call<T>(): Promise<T> {
        throw new Error("tools should not be called");
      },
    },
    modelGateway: new RetryingModelGateway(async <T>(request: ModelRequest) => {
      if (request.metadata?.stream === "reasoning_sidecar") {
        throw new Error("reasoning sidecar model failure");
      }
      return { ok: true } as T;
    }),
    reasoningListener: (update) => {
      updates.push(update);
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "COMPLETED",
    statePatch: {
      agent: {
        observations: [],
        capabilityEvidence: {},
        exec: {},
        phase: "ACT",
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-reasoning-2",
    type: "user.message",
    sessionId: "session-reasoning-2",
    payload: {
      message: "run",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(updates.length, 0);

  const replay = await new RunReplayService(store).replay({ runId: output.runId });
  assert.equal(replay.events.some((event) => event.type === "reasoning.update"), false);
});
