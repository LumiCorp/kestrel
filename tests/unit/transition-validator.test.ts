import test from "node:test";
import assert from "node:assert/strict";

import type { Transition } from "../../src/kestrel/contracts/execution.js";

import { validateTransition } from "../../src/engine/TransitionValidator.js";

test("WAITING requires waitFor", () => {
  assert.throws(
    () => {
      validateTransition({
        status: "WAITING",
      });
    },
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RUN_TRANSITION_INVALID");
      assert.equal(
        (error as { details?: { contractPath?: string } }).details?.contractPath,
        "transition.waitFor",
      );
      return true;
    },
  );
});

test("RUNNING requires nextStepAgent", () => {
  assert.throws(() => {
    validateTransition({
      status: "RUNNING",
    });
  });
});

test("accepts valid transition", () => {
  assert.doesNotThrow(() => {
    validateTransition({
      status: "RUNNING",
      nextStepAgent: "next",
      effects: [
        {
          type: "test_noop",
          payload: {},
          failurePolicy: "STOP",
        },
      ],
    });
  });
});

test("rejects invalid region ops payloads", () => {
  assert.throws(() => {
    validateTransition({
      status: "RUNNING",
      nextStepAgent: "next",
      regionOps: {
        spawn: [{ region: "", stepAgent: "worker" }],
      },
    });
  });
});

test("rejects malformed transition boundary fields without trim TypeErrors", () => {
  const cases: Array<{ transition: unknown; contractPath: string }> = [
    {
      transition: {
        status: "RUNNING",
        nextStepAgent: { name: "next" },
      },
      contractPath: "transition.nextStepAgent",
    },
    {
      transition: {
        status: "RUNNING",
        nextStepAgent: "next",
        stateNode: { parent: { name: "root" }, child: "child" },
      },
      contractPath: "transition.stateNode",
    },
    {
      transition: {
        status: "RUNNING",
        nextStepAgent: "next",
        regionOps: { spawn: [{ region: { name: "research" }, stepAgent: "worker" }] },
      },
      contractPath: "transition.regionOps.spawn[].region",
    },
    {
      transition: {
        status: "RUNNING",
        nextStepAgent: "next",
        regionOps: { complete: [12] },
      },
      contractPath: "transition.regionOps.complete[]",
    },
    {
      transition: {
        status: "RUNNING",
        nextStepAgent: "next",
        claims: [{ text: { value: "claim" }, evidenceIds: ["evidence-1"], status: "proposed" }],
      },
      contractPath: "transition.claims[].text",
    },
    {
      transition: {
        status: "RUNNING",
        nextStepAgent: "next",
        effects: [{ type: { name: "effect" }, payload: {} }],
      },
      contractPath: "transition.effects[].type",
    },
    {
      transition: {
        status: "RUNNING",
        nextStepAgent: "next",
        effects: [{ type: "effect", failurePolicy: { mode: "STOP" }, payload: {} }],
      },
      contractPath: "transition.effects[].failurePolicy",
    },
  ];

  for (const testCase of cases) {
    assert.throws(
      () => validateTransition(testCase.transition as Transition),
      (error: unknown) => {
        assert.equal((error as Error).message.includes("value.trim"), false);
        assert.equal((error as { code?: string }).code, "RUN_TRANSITION_INVALID");
        assert.equal(
          (error as { details?: { contractPath?: string } }).details?.contractPath,
          testCase.contractPath,
        );
        return true;
      },
    );
  }
});

test("accepts valid region ops", () => {
  assert.doesNotThrow(() => {
    validateTransition({
      status: "RUNNING",
      nextStepAgent: "next",
      regionOps: {
        spawn: [{ region: "research", stepAgent: "worker" }],
        complete: ["research"],
        syncNode: "join.research",
      },
    });
  });
});
