import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODEL_TIMING_POLICY,
  deriveModelTimeoutMs,
} from "../../src/io/ModelTimingPolicy.js";

test("deriveModelTimeoutMs uses phase cap when budget metadata is missing", () => {
  const timeout = deriveModelTimeoutMs(
    {
      input: "hello",
      metadata: {},
    },
    DEFAULT_MODEL_TIMING_POLICY,
  );

  assert.equal(timeout, DEFAULT_MODEL_TIMING_POLICY.phaseCapMs);
});

test("deriveModelTimeoutMs clamps timeout to remaining budget minus reserve", () => {
  const timeout = deriveModelTimeoutMs(
    {
      input: "hello",
      metadata: {
        runtimeBudgetRemainingMs: 5000,
      },
    },
    DEFAULT_MODEL_TIMING_POLICY,
  );

  assert.equal(timeout, 4000);
});

test("deriveModelTimeoutMs never exceeds remaining budget reserve", () => {
  const timeout = deriveModelTimeoutMs(
    {
      input: "hello",
      metadata: {
        runtimeBudgetRemainingMs: 1000,
      },
    },
    DEFAULT_MODEL_TIMING_POLICY,
  );

  assert.equal(timeout, 0);
});
