import test from "node:test";
import assert from "node:assert/strict";

import { Kestrel, RetryingModelGateway, RunReplayService } from "../../src/index.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { adaptLegacyTestToolGateway } from "../helpers/createTestToolGateway.js";


test("agent progress is durable only after the action transition commits", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
    toolGateway: adaptLegacyTestToolGateway({ async call<T>() { return {} as T; } }),
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
    toolGateway: adaptLegacyTestToolGateway({ async call<T>() { return {} as T; } }),
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
    toolGateway: adaptLegacyTestToolGateway({ async call<T>() { return {} as T; } }),
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

test("completed transitions await inline outbox dispatch by default", async () => {
  const store = new InMemorySessionStore();
  const dispatchStarted = deferred<void>();
  const releaseDispatch = deferred<void>();
  const kestrel = new Kestrel({
    store,
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
    toolGateway: adaptLegacyTestToolGateway({ async call<T>() { return {} as T; } }),
    dispatcher: {
      dispatch: async () => {
        dispatchStarted.resolve();
        await releaseDispatch.promise;
      },
    },
  });
  kestrel.registerStep("finish", async () => ({
    status: "COMPLETED",
    statePatch: {
      agent: {
        assistantText: "Done.",
        finalOutput: { message: "Done." },
      },
    },
    emitEvents: [{
      type: "assistant.respond",
      payload: {
        recipient: "operator",
        message: "This outbox dispatch remains inline.",
      },
    }],
  }));

  let settled = false;
  const run = kestrel.run({
    id: "event-terminal-inline-outbox",
    type: "user.message",
    sessionId: "session-terminal-inline-outbox",
    payload: { message: "finish" },
    stepAgent: "finish",
  }).then((output) => {
    settled = true;
    return output;
  });

  await dispatchStarted.promise;
  await delay(0);
  assert.equal(settled, false);

  releaseDispatch.resolve();
  const output = await run;

  assert.equal(output.status, "COMPLETED");
});

test("waiting prompts retain inline outbox ordering", async () => {
  const store = new InMemorySessionStore();
  const dispatchStarted = deferred<void>();
  const releaseDispatch = deferred<void>();
  const kestrel = new Kestrel({
    store,
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
    toolGateway: adaptLegacyTestToolGateway({ async call<T>() { return {} as T; } }),
    dispatcher: {
      dispatch: async () => {
        dispatchStarted.resolve();
        await releaseDispatch.promise;
      },
    },
  });
  kestrel.registerStep("wait", async () => ({
    status: "WAITING",
    nextStepAgent: "wait",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: { prompt: "Approve?" },
    },
    emitEvents: [{ type: "ui.prompt", payload: { text: "Approve?" } }],
  }));

  let settled = false;
  const run = kestrel.run({
    id: "event-waiting-inline-outbox",
    type: "user.message",
    sessionId: "session-waiting-inline-outbox",
    payload: { message: "wait" },
    stepAgent: "wait",
  }).then((output) => {
    settled = true;
    return output;
  });

  await dispatchStarted.promise;
  await delay(0);
  assert.equal(settled, false);

  releaseDispatch.resolve();
  assert.equal((await run).status, "WAITING");
});

test("after-terminal outbox dispatch does not block completed finalization", async () => {
  const store = new InMemorySessionStore();
  const dispatchStarted = deferred<void>();
  const releaseDispatch = deferred<void>();
  const kestrel = new Kestrel({
    store,
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
    toolGateway: adaptLegacyTestToolGateway({ async call<T>() { return {} as T; } }),
    dispatcher: {
      dispatch: async () => {
        dispatchStarted.resolve();
        await releaseDispatch.promise;
      },
    },
  });
  kestrel.registerStep("finish", async () => ({
    status: "COMPLETED",
    outboxDelivery: "after_terminal",
    statePatch: {
      agent: {
        assistantText: "Preview: https://example.test/preview",
        finalOutput: { message: "Preview: https://example.test/preview" },
      },
    },
    emitEvents: [{
      type: "agent.completed",
      payload: { message: "Preview: https://example.test/preview" },
    }],
  }));

  const output = await Promise.race([
    kestrel.run({
      id: "event-terminal-after-outbox",
      type: "user.message",
      sessionId: "session-terminal-after-outbox",
      payload: { message: "finish" },
      stepAgent: "finish",
    }),
    delay(100).then(() => {
      throw new Error("completed finalization waited on deferred outbox dispatch");
    }),
  ]);

  assert.equal(output.status, "COMPLETED");
  await dispatchStarted.promise;
  const pending = await store.listUndeliveredOutbox(10, output.runId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.status, "PENDING");

  releaseDispatch.resolve();
  await waitForCondition(async () =>
    (await store.listUndeliveredOutbox(10, output.runId)).length === 0
  );
});

test("failed after-terminal dispatch remains replayable without changing completion", async () => {
  const store = new InMemorySessionStore();
  let attempts = 0;
  const kestrel = new Kestrel({
    store,
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
    toolGateway: adaptLegacyTestToolGateway({ async call<T>() { return {} as T; } }),
    dispatcher: {
      dispatch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary dispatch failure");
      },
    },
  });
  kestrel.registerStep("finish", async () => ({
    status: "COMPLETED",
    outboxDelivery: "after_terminal",
    statePatch: {
      agent: {
        assistantText: "Done.",
        finalOutput: { message: "Done." },
      },
    },
    emitEvents: [{ type: "agent.completed", payload: { message: "Done." } }],
  }));

  const output = await kestrel.run({
    id: "event-terminal-replay-outbox",
    type: "user.message",
    sessionId: "session-terminal-replay-outbox",
    payload: { message: "finish" },
    stepAgent: "finish",
  });
  assert.equal(output.status, "COMPLETED");

  await waitForCondition(async () => {
    const pending = await store.listUndeliveredOutbox(10, output.runId);
    return pending[0]?.status === "FAILED" && pending[0]?.attemptCount === 1;
  });
  const failedReplay = await new RunReplayService(store).replay({
    runId: output.runId,
  });
  assert.equal(
    failedReplay.events.some((event) => event.type === "outbox.dispatched"),
    false,
  );

  assert.equal(await kestrel.replayUndeliveredOutbox(), 1);
  assert.equal(attempts, 2);
  assert.equal((await store.listUndeliveredOutbox(10, output.runId)).length, 0);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitForCondition(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for condition.");
}
