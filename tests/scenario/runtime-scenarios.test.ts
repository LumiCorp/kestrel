import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { AllowlistedToolGateway } from "../../src/io/ToolGateway.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import type { OutboxEventRecord } from "../../src/kestrel/contracts/store.js";

import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

class CollectingDispatcher {
  readonly delivered: OutboxEventRecord[] = [];

  async dispatch(event: OutboxEventRecord): Promise<void> {
    this.delivered.push({ ...event });
  }
}

class CountingInMemorySessionStore extends InMemorySessionStore {
  appendRunEventsBatchCalls = 0;
  appendRunLogsBatchCalls = 0;
  committedStepFrames: Array<{ runLogs: number; runEvents: number }> = [];

  override async appendRunEventsBatch(events: Parameters<InMemorySessionStore["appendRunEventsBatch"]>[0]): Promise<void> {
    this.appendRunEventsBatchCalls += 1;
    await super.appendRunEventsBatch(events);
  }

  override async appendRunLogsBatch(entries: Parameters<InMemorySessionStore["appendRunLogsBatch"]>[0]): Promise<void> {
    this.appendRunLogsBatchCalls += 1;
    await super.appendRunLogsBatch(entries);
  }

  override async commitStep(input: Parameters<InMemorySessionStore["commitStep"]>[0]) {
    this.committedStepFrames.push({
      runLogs: input.runLogs?.length ?? 0,
      runEvents: input.runEvents?.length ?? 0,
    });
    return super.commitStep(input);
  }
}

test("Kestrel executes multi-step run with effect barrier", async () => {
  const store = new InMemorySessionStore();
  const dispatcher = new CollectingDispatcher();

  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({
      lookup: async () => ({ found: true }),
    }),
    modelGateway: new RetryingModelGateway(async <T>() => ({ summary: "ok" } as T)),
    dispatcher,
  });

  kestrel.registerStep("stepA", async (_ctx, io) => {
    await io.useTool!("lookup", {});
    await io.useModel({ model: "mock", input: "hello" });

    return {
      status: "RUNNING",
      nextStepAgent: "stepB",
      statePatch: { phase: "A" },
      effects: [
        {
          type: "test_noop",
          payload: { v: 1 },
          failurePolicy: "STOP",
        },
      ],
      emitEvents: [
        {
          type: "kestrel.runtime.notice",
          payload: { level: "info" },
        },
      ],
    };
  });

  kestrel.registerStep("stepB", async () => ({
    status: "COMPLETED",
    statePatch: { phase: "B", done: true },
  }));

  const output = await kestrel.run({
    id: "evt-1",
    type: "INGRESS",
    sessionId: "s-1",
    payload: {},
    stepAgent: "stepA",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.telemetry.stepsExecuted, 2);
  assert.equal(output.telemetry.toolCalls, 1);
  assert.equal(output.telemetry.modelCalls, 1);
  assert.equal(dispatcher.delivered.length, 1);

  const commit0 = store.operationLog.indexOf("commitStep:0");
  const result0 = store.operationLog.findIndex((op) =>
    op.startsWith("saveEffectResult:") && op.includes(":DONE"),
  );
  const commit1 = store.operationLog.indexOf("commitStep:1");

  assert.equal(commit0 >= 0, true);
  assert.equal(result0 > commit0, true);
  assert.equal(commit1 > result0, true);
});

test("Kestrel does not auto-sync session-scoped notes from persisted progress state", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-plan-doc-runtime-"));
  const store = new InMemorySessionStore();

  try {
    const kestrel = new Kestrel({
      store,
      toolGateway: new AllowlistedToolGateway({}),
      modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    });

    kestrel.registerStep("planStep", async () => ({
      status: "COMPLETED",
      statePatch: {
        agent: {
          progress: {
            objective: "Ship the session-note sync",
            items: [
              { label: "Create the workspace note file", status: "done" },
              { label: "Keep it updated in build mode", status: "active" },
            ],
          },
          decisionVerification: {
            verificationSteps: ["check:pnpm run test"],
          },
        },
      },
    }));

    const output = await kestrel.run({
      id: "evt-plan-doc-1",
      type: "INGRESS",
      sessionId: "plan-doc-session-1",
      payload: {
        workspace: {
          workspaceId: "workspace-1",
          workspaceRoot,
        },
      },
      stepAgent: "planStep",
    });

    assert.equal(output.status, "COMPLETED");
    assert.equal(store.getEffects().some((effect) => effect.type === "plan_document.sync"), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Kestrel skips plan document sync when workspace disables it", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-plan-doc-disabled-"));
  const store = new InMemorySessionStore();

  try {
    const kestrel = new Kestrel({
      store,
      toolGateway: new AllowlistedToolGateway({}),
      modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    });

    kestrel.registerStep("planStep", async () => ({
      status: "COMPLETED",
      statePatch: {
        agent: {
          progress: {
            objective: "Skip host session-note sync",
            items: [
              { label: "Do not write session notes", status: "active" },
            ],
          },
        },
      },
    }));

    const output = await kestrel.run({
      id: "evt-plan-doc-disabled-1",
      type: "INGRESS",
      sessionId: "plan-doc-disabled-session-1",
      payload: {
        workspace: {
          workspaceId: "workspace-1",
          workspaceRoot,
          planDocumentSync: false,
        },
      },
      stepAgent: "planStep",
    });

    assert.equal(output.status, "COMPLETED");
    assert.equal(store.getEffects().some((effect) => effect.type === "plan_document.sync"), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Kestrel effect policy WAIT returns waiting status", async () => {
  const store = new InMemorySessionStore();

  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("waitStep", async () => ({
    status: "COMPLETED",
    effects: [
      {
        type: "send_message",
        payload: { invalid: true },
        failurePolicy: "WAIT",
      },
    ],
  }));

  const output = await kestrel.run({
    id: "evt-2",
    type: "INGRESS",
    sessionId: "s-2",
    payload: {},
    stepAgent: "waitStep",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.errors.length, 1);
});

test("Kestrel accepts assistant.respond as a message-effect compatibility alias", async () => {
  const store = new InMemorySessionStore();

  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("respondStep", async () => ({
    status: "COMPLETED",
    effects: [
      {
        type: "assistant.respond",
        payload: {
          message: "Here is the final response.",
        },
        failurePolicy: "STOP",
      },
    ],
  }));

  const output = await kestrel.run({
    id: "evt-respond-1",
    type: "INGRESS",
    sessionId: "s-respond-1",
    payload: {},
    stepAgent: "respondStep",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);
});

test("Kestrel terminal WAITING output includes waitFor matcher", async () => {
  const store = new InMemorySessionStore();

  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("waitForUser", async () => ({
    status: "WAITING",
    nextStepAgent: "waitForUser",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        promptId: "p-1",
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-waiting-with-matcher",
    type: "INGRESS",
    sessionId: "s-waiting-1",
    payload: {},
    stepAgent: "waitForUser",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.waitFor?.eventType, "user.reply");
  assert.equal(output.waitFor?.metadata?.promptId, "p-1");
});

test("Kestrel resumes pending effects before new step execution", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("s-3", "finalStep");
  await store.startRun("old-run", {
    id: "old-evt",
    type: "INGRESS",
    sessionId: "s-3",
    payload: {},
  });

  await store.commitStep({
    runId: "old-run",
    event: {
      id: "old-evt",
      type: "INGRESS",
      sessionId: "s-3",
      payload: {},
    },
    sessionId: "s-3",
    expectedVersion: 0,
    nextStepAgent: "finalStep",
    statePatch: {},
    effects: [
      {
        type: "test_noop",
        payload: {},
        idempotencyKey: "resume-key",
        failurePolicy: "STOP",
      },
    ],
    emitEvents: [],
    stepIndex: 0,
  });
  await store.completeRun("old-run", "WAITING");

  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("finalStep", async () => ({
    status: "COMPLETED",
    statePatch: { resumed: true },
  }));

  const output = await kestrel.run({
    id: "evt-3",
    type: "INGRESS",
    sessionId: "s-3",
    payload: {},
  });

  assert.equal(output.status, "COMPLETED");

  const resultSaved = store.operationLog.some((entry) =>
    entry.startsWith("saveEffectResult:resume-key:DONE"),
  );
  assert.equal(resultSaved, true);
});

test("Kestrel emits run logs to optional listener during execution", async () => {
  const store = new InMemorySessionStore();
  const seenEventNames: string[] = [];

  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    runLogListener: (entry) => {
      seenEventNames.push(entry.eventName);
    },
  });

  kestrel.registerStep("logStep", async () => ({
    status: "COMPLETED",
    statePatch: { done: true },
  }));

  const output = await kestrel.run({
    id: "evt-log-listener-1",
    type: "INGRESS",
    sessionId: "s-log-listener-1",
    payload: {},
    stepAgent: "logStep",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(seenEventNames.includes("run_started"), true);
  assert.equal(seenEventNames.includes("step_started"), true);
  assert.equal(seenEventNames.includes("run_terminal"), true);
});

test("step-frame buffering reduces hot-path run-event write calls", async () => {
  const runScenario = async (bufferEnabled: boolean): Promise<CountingInMemorySessionStore> => {
    const previous = process.env.KESTREL_STEP_FRAME_BUFFER;
    process.env.KESTREL_STEP_FRAME_BUFFER = bufferEnabled ? "1" : "0";
    const store = new CountingInMemorySessionStore();
    try {
      const kestrel = new Kestrel({
        store,
        toolGateway: new AllowlistedToolGateway({
          lookup: async () => ({ ok: true }),
        }),
        modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
      });

      kestrel.registerStep("stepA", async (_ctx, io) => {
        await io.useModel({ model: "mock", input: { phase: "a" } });
        await io.useTool!("lookup", { id: "x" });
        return {
          status: "RUNNING",
          nextStepAgent: "stepB",
          statePatch: { phase: "A" },
        };
      });

      kestrel.registerStep("stepB", async (_ctx, io) => {
        await io.useModel({ model: "mock", input: { phase: "b" } });
        return {
          status: "COMPLETED",
          statePatch: { done: true },
        };
      });

      const output = await kestrel.run({
        id: `evt-step-frame-${bufferEnabled ? "on" : "off"}`,
        type: "INGRESS",
        sessionId: `s-step-frame-${bufferEnabled ? "on" : "off"}`,
        payload: {},
        stepAgent: "stepA",
      });
      assert.equal(output.status, "COMPLETED");
      return store;
    } finally {
      if (previous === undefined) {
        delete process.env.KESTREL_STEP_FRAME_BUFFER;
      } else {
        process.env.KESTREL_STEP_FRAME_BUFFER = previous;
      }
    }
  };

  const baseline = await runScenario(false);
  const optimized = await runScenario(true);
  assert.equal(optimized.appendRunEventsBatchCalls < baseline.appendRunEventsBatchCalls, true);
  assert.equal(
    optimized.appendRunEventsBatchCalls <= Math.floor(baseline.appendRunEventsBatchCalls * 0.6),
    true,
  );
  assert.equal(
    optimized.committedStepFrames.some((frame) => frame.runEvents > 0 && frame.runLogs > 0),
    true,
  );
});

test("Kestrel failure output preserves last executed step without explicit event stepAgent", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("s-final-step-failure", "explodeStep");

  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("explodeStep", async () => {
    throw new Error("boom");
  });

  const output = await kestrel.run({
    id: "evt-final-step-failure",
    type: "INGRESS",
    sessionId: "s-final-step-failure",
    payload: {},
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.finalStep, "explodeStep");
});
