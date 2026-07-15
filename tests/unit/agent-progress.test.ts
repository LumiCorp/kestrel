import assert from "node:assert/strict";
import test from "node:test";

import { Kestrel, RetryingModelGateway, RunReplayService } from "../../src/index.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

test("agent progress is durable only after the action transition commits", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
    toolGateway: { async call<T>() { return {} as T; } },
  });
  kestrel.registerStep("choose", async () => ({
    status: "RUNNING",
    nextStepAgent: "finish",
    agentProgress: "I accepted the next action.",
    statePatch: { accepted: true },
  }));
  kestrel.registerStep("finish", async () => ({ status: "COMPLETED" }));

  const output = await kestrel.run({
    id: "event-agent-progress",
    type: "user.message",
    sessionId: "session-agent-progress",
    payload: { message: "go" },
    stepAgent: "choose",
  });
  const replay = await new RunReplayService(store).replay({ runId: output.runId });
  const committedIndex = replay.events.findIndex((event) => event.type === "step.committed");
  const progressIndex = replay.events.findIndex((event) => event.type === "agent.progress");
  assert.ok(committedIndex >= 0);
  assert.ok(progressIndex > committedIndex);
  assert.equal(replay.events[progressIndex]?.metadata?.message, "I accepted the next action.");
  assert.equal(replay.events.filter((event) => event.type === "agent.progress").length, 1);
});

test("rejected step output never emits agent progress", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
    toolGateway: { async call<T>() { return {} as T; } },
  });
  kestrel.registerStep("reject", async () => {
    throw new Error("transition rejected before commit");
  });
  const output = await kestrel.run({
    id: "event-agent-progress-rejected",
    type: "user.message",
    sessionId: "session-agent-progress-rejected",
    payload: { message: "go" },
    stepAgent: "reject",
  });
  const replay = await new RunReplayService(store).replay({ runId: output.runId });
  assert.equal(replay.events.some((event) => event.type === "agent.progress"), false);
});

test("terminal finalization emits no agent progress and makes no extra model call", async () => {
  const store = new InMemorySessionStore();
  let modelCalls = 0;
  const kestrel = new Kestrel({
    store,
    modelGateway: new RetryingModelGateway(async <T>() => {
      modelCalls += 1;
      return { accepted: true } as T;
    }),
    toolGateway: { async call<T>() { return {} as T; } },
  });
  kestrel.registerStep("finalize", async (_context, io) => {
    await io.useModel({ input: "Produce the authoritative terminal decision." });
    return {
      status: "COMPLETED",
      agentProgress: "This terminal narration must not be emitted.",
    };
  });

  const output = await kestrel.run({
    id: "event-agent-progress-terminal",
    type: "user.message",
    sessionId: "session-agent-progress-terminal",
    payload: { message: "finish" },
    stepAgent: "finalize",
  });
  const replay = await new RunReplayService(store).replay({ runId: output.runId });
  assert.equal(modelCalls, 1);
  assert.equal(replay.events.some((event) => event.type === "agent.progress"), false);
});
