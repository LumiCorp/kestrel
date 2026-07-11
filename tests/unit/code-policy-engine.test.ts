import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CODE_MODE_ENABLED_CONFIG,
  type CodeExecutionRequest,
} from "../../src/code/contracts.js";
import { evaluateExecutionPolicy } from "../../src/code/PolicyEngine.js";

test("evaluateExecutionPolicy blocks when code-mode is disabled", () => {
  const request: CodeExecutionRequest = {
    language: "javascript",
    code: "console.log('hi')",
  };

  const decision = evaluateExecutionPolicy(
    {
      ...DEFAULT_CODE_MODE_ENABLED_CONFIG,
      enabled: false,
    },
    request,
  );

  assert.equal(decision.ok, false);
  if (decision.ok) {
    throw new Error("Expected blocked policy decision");
  }
  assert.equal(decision.result.status, "blocked");
  assert.match(decision.result.summary, /disabled/);
});

test("evaluateExecutionPolicy enforces network tightening only", () => {
  const request: CodeExecutionRequest = {
    language: "python",
    code: "print('x')",
    network: "on",
  };

  const decision = evaluateExecutionPolicy(
    {
      ...DEFAULT_CODE_MODE_ENABLED_CONFIG,
      sandbox: {
        ...DEFAULT_CODE_MODE_ENABLED_CONFIG.sandbox,
        networkDefault: "off",
      },
    },
    request,
  );

  assert.equal(decision.ok, false);
  if (decision.ok) {
    throw new Error("Expected blocked policy decision");
  }
  assert.equal(decision.result.status, "blocked");
  assert.match(decision.result.summary, /network access/);
});

test("evaluateExecutionPolicy allows configured languages and clamps timeout", () => {
  const request: CodeExecutionRequest = {
    language: "javascript",
    code: "console.log('ok')",
    timeoutMs: 999_999,
    dependencies: ["left-pad"],
  };

  const decision = evaluateExecutionPolicy(
    {
      ...DEFAULT_CODE_MODE_ENABLED_CONFIG,
      sandbox: {
        ...DEFAULT_CODE_MODE_ENABLED_CONFIG.sandbox,
        timeoutMs: 5_000,
        allowDependencyInstall: true,
      },
    },
    request,
  );

  if (decision.ok === false) {
    throw new Error("Expected allowed policy decision");
  }
  assert.equal(decision.ok, true);
  assert.equal(decision.policy.timeoutMs, 5_000);
  assert.equal(decision.request.timeoutMs, 5_000);
  assert.deepEqual(decision.request.dependencies, ["left-pad"]);
});
