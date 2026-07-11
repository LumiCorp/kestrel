import test from "node:test";
import assert from "node:assert/strict";

import { resolveRunFailureSummaryForTests } from "../../cli/app/App.js";

test("resolveRunFailureSummaryForTests prefers normalized run error when available", () => {
  const summary = resolveRunFailureSummaryForTests({
    result: {
      output: {
        errors: [
          {
            code: "MODEL_TIMEOUT",
            message: "Model call timed out.",
          },
        ],
      },
    },
    error: {
      code: "RUNNER_RUNTIME_ERROR",
      message: "Runner failed.",
    },
  });

  assert.deepEqual(summary, {
    code: "MODEL_TIMEOUT",
    message: "Model call timed out.",
  });
});

test("resolveRunFailureSummaryForTests falls back to runner error code when result is missing", () => {
  const summary = resolveRunFailureSummaryForTests({
    result: undefined,
    error: {
      code: "EPERM",
      message: "",
    },
  });

  assert.deepEqual(summary, {
    code: "EPERM",
  });
});

test("resolveRunFailureSummaryForTests falls back to RUN_FAILED when no non-empty code exists", () => {
  const summary = resolveRunFailureSummaryForTests({
    result: undefined,
    error: {
      code: "   ",
      message: "   ",
    },
  });

  assert.deepEqual(summary, {
    code: "RUN_FAILED",
  });
});
