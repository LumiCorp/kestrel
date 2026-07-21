import assert from "node:assert/strict";

import {
  DEFAULT_TOOL_TIMING_POLICY,
  deriveShellRunTimeoutDecision,
} from "../../src/io/ToolTimingPolicy.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "deriveShellRunTimeoutDecision preserves requested timeout without external deadline", () => {
  const decision = deriveShellRunTimeoutDecision({
    requestedTimeoutMs: 120_000,
    remainingMs: Number.MAX_SAFE_INTEGER,
  });

  assert.deepEqual(decision, {
    kind: "unchanged",
    timeoutMs: 120_000,
    requestedTimeoutMs: 120_000,
  });
});

contractTest("runtime.hermetic", "deriveShellRunTimeoutDecision returns default timeout when request omits timeout", () => {
  const decision = deriveShellRunTimeoutDecision({
    remainingMs: Number.MAX_SAFE_INTEGER,
  });

  assert.deepEqual(decision, {
    kind: "unchanged",
    timeoutMs: DEFAULT_TOOL_TIMING_POLICY.defaultShellRunTimeoutMs,
  });
});

contractTest("runtime.hermetic", "deriveShellRunTimeoutDecision clamps timeout to remaining budget minus closeout reserve", () => {
  const decision = deriveShellRunTimeoutDecision({
    requestedTimeoutMs: 240_000,
    remainingMs: 95_000,
  });

  assert.deepEqual(decision, {
    kind: "clamped",
    timeoutMs: 35_000,
    requestedTimeoutMs: 240_000,
    deadlineAdjustedTimeoutMs: 35_000,
    remainingMs: 95_000,
    closeoutReserveMs: 60_000,
  });
});

contractTest("runtime.hermetic", "deriveShellRunTimeoutDecision rejects dispatch when only closeout budget remains", () => {
  const decision = deriveShellRunTimeoutDecision({
    requestedTimeoutMs: 30_000,
    remainingMs: 61_000,
  });

  assert.equal(decision.kind, "deadline_exhausted");
  assert.equal(decision.remainingMs, 61_000);
  assert.equal(decision.closeoutReserveMs, 60_000);
  assert.equal(decision.minDispatchMs, 2500);
  assert.match(decision.failureReason, /Not enough external runtime budget/u);
});
