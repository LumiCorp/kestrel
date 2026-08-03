import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CODE_MODE_SANDBOX,
  DEFAULT_CODE_MODE_ENABLED_CONFIG,
  type CodeExecutionRequest,
} from "../../src/code/contracts.js";
import {
  evaluateExecutionPolicy,
  mergeCodeModeConfig,
} from "../../src/code/PolicyEngine.js";


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
        timeoutMs: 5000,
        allowDependencyInstall: true,
      },
    },
    request,
  );

  if (decision.ok === false) {
    throw new Error("Expected allowed policy decision");
  }
  assert.equal(decision.ok, true);
  assert.equal(decision.policy.timeoutMs, 5000);
  assert.equal(decision.request.timeoutMs, 5000);
  assert.deepEqual(decision.request.dependencies, ["left-pad"]);
});

test("code sandbox policy defaults and bounds omitted legacy PID limits", () => {
  const legacy = mergeCodeModeConfig({
    ...DEFAULT_CODE_MODE_ENABLED_CONFIG,
    sandbox: {
      ...DEFAULT_CODE_MODE_ENABLED_CONFIG.sandbox,
      pidsLimit: undefined,
    },
  });
  const oversized = mergeCodeModeConfig({
    ...DEFAULT_CODE_MODE_ENABLED_CONFIG,
    sandbox: {
      ...DEFAULT_CODE_MODE_ENABLED_CONFIG.sandbox,
      pidsLimit: 10_000,
    },
  });

  assert.equal(legacy.sandbox.pidsLimit, DEFAULT_CODE_MODE_SANDBOX.pidsLimit);
  assert.equal(oversized.sandbox.pidsLimit, 1024);
});

test("code sandbox policy applies bounded workspace and tmpfs quotas", () => {
  const defaults = mergeCodeModeConfig(DEFAULT_CODE_MODE_ENABLED_CONFIG);
  assert.equal(defaults.sandbox.workspaceSizeMb, 64);
  assert.equal(defaults.sandbox.workspaceInodes, 8_192);
  assert.equal(defaults.sandbox.tmpSizeMb, 32);
  assert.equal(defaults.sandbox.tmpInodes, 2_048);

  const overridden = mergeCodeModeConfig({
    ...DEFAULT_CODE_MODE_ENABLED_CONFIG,
    sandbox: {
      ...DEFAULT_CODE_MODE_ENABLED_CONFIG.sandbox,
      memoryMb: 48,
      workspaceSizeMb: 96,
      workspaceInodes: 12_000,
      tmpSizeMb: 64,
      tmpInodes: 4_000,
    },
  });
  assert.equal(overridden.sandbox.workspaceSizeMb, 48);
  assert.equal(overridden.sandbox.workspaceInodes, 12_000);
  assert.equal(overridden.sandbox.tmpSizeMb, 48);
  assert.equal(overridden.sandbox.tmpInodes, 4_000);
});
