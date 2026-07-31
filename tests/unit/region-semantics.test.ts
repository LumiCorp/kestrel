import test from "node:test";
import assert from "node:assert/strict";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { AllowlistedToolGateway } from "../../src/io/ToolGateway.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { readActiveWaitState } from "../../src/runtime/waitState.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";


test("region work item claiming is deterministic with round-robin cursor", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("region-round-robin");
  await store.spawnRegionWorkItems("region-round-robin", [
    { region: "beta", stepAgent: "step.beta" },
    { region: "alpha", stepAgent: "step.alpha" },
    { region: "gamma", stepAgent: "step.gamma" },
  ]);

  const first = await store.claimNextRegionWorkItem("region-round-robin");
  assert.equal(first?.region, "alpha");
  await store.completeRegionWorkItem(first!.id, "DONE");

  const second = await store.claimNextRegionWorkItem("region-round-robin", "alpha");
  assert.equal(second?.region, "beta");
  await store.completeRegionWorkItem(second!.id, "DONE");

  const third = await store.claimNextRegionWorkItem("region-round-robin", "beta");
  assert.equal(third?.region, "gamma");
});

test("engine preserves a durable region-merge wait across a fresh user turn", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });
  let regionWorkerVisits = 0;
  kestrel.registerStep("seed.wait", async () => ({
    status: "WAITING",
    nextStepAgent: "fallback",
    waitFor: {
      kind: "region_merge",
      eventType: "system.meta_reasoning",
      timeoutMs: 30_000,
      metadata: { regionId: "research" },
    },
  }));
  kestrel.registerStep("region.worker", async () => {
    regionWorkerVisits += 1;
    return { status: "COMPLETED" };
  });
  kestrel.registerStep("fallback", async () => ({ status: "COMPLETED" }));

  const suspended = await kestrel.run({
    id: "evt-region-merge-suspend",
    type: "test.seed_wait",
    sessionId: "region-merge-fresh-turn",
    payload: {},
    stepAgent: "seed.wait",
  });
  assert.equal(suspended.status, "WAITING");
  assert.equal(suspended.waitFor?.kind, "region_merge");
  assert.equal(suspended.waitFor?.timeoutMs, 30_000);
  const suspendedSession = await store.getSession("region-merge-fresh-turn");
  assert.equal(
    readActiveWaitState(
      suspendedSession?.state.agent as Record<string, unknown> | undefined,
    )?.kind,
    "region_merge",
  );

  await store.spawnRegionWorkItems("region-merge-fresh-turn", [
    { region: "research", stepAgent: "region.worker" },
  ]);
  const freshTurn = await kestrel.run({
    id: "evt-region-merge-fresh-user",
    type: "user.message",
    sessionId: "region-merge-fresh-turn",
    payload: { message: "Any update?" },
  });

  assert.equal(freshTurn.status, "WAITING");
  assert.equal(freshTurn.waitFor?.kind, "region_merge");
  assert.equal(regionWorkerVisits, 0);
  assert.equal(store.getRegionWorkItems()[0]?.status, "PENDING");
});

test("engine emits merge conflict checkpoint when sync patch violates namespaced merge contract", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("seed", async () => ({
    status: "RUNNING",
    nextStepAgent: "fallback",
    regionOps: {
      spawn: [{ region: "research", stepAgent: "worker" }],
    },
  }));

  kestrel.registerStep("worker", async () => ({
    status: "RUNNING",
    nextStepAgent: "final",
    regionOps: {
      syncNode: "join.research",
    },
    statePatch: {
      badRootWrite: true,
    },
  }));

  kestrel.registerStep("fallback", async () => ({
    status: "RUNNING",
    nextStepAgent: "final",
  }));

  kestrel.registerStep("final", async () => ({
    status: "COMPLETED",
  }));

  const output = await kestrel.run({
    id: "evt-region-conflict",
    type: "user.message",
    sessionId: "region-conflict-session",
    payload: {},
    stepAgent: "seed",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.errors.some((error) => error.code === "REGION_MERGE_CONFLICT"), true);
  assert.equal(output.waitFor?.eventType, "system.meta_reasoning");

  const events = store.getRunEvents().map((event) => event.type);
  assert.equal(events.includes("region.merge_conflict"), true);
  assert.equal(events.includes("policy.checkpoint"), true);
});

test("engine emits region.synced when sync node completes without pending region work", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("seed", async () => ({
    status: "RUNNING",
    nextStepAgent: "fallback",
    regionOps: {
      spawn: [{ region: "research", stepAgent: "worker" }],
    },
  }));

  kestrel.registerStep("worker", async () => ({
    status: "RUNNING",
    nextStepAgent: "final",
    regionOps: {
      syncNode: "join.research",
    },
    statePatch: {
      regions: {
        research: {
          score: 0.9,
        },
      },
    },
  }));

  kestrel.registerStep("fallback", async () => ({
    status: "RUNNING",
    nextStepAgent: "final",
  }));

  kestrel.registerStep("final", async () => ({
    status: "COMPLETED",
  }));

  const output = await kestrel.run({
    id: "evt-region-sync",
    type: "user.message",
    sessionId: "region-sync-session",
    payload: {},
    stepAgent: "seed",
  });

  assert.equal(output.status, "COMPLETED");
  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.equal(eventTypes.includes("region.synced"), true);
  assert.equal(eventTypes.includes("region.merge_conflict"), false);
});
