import test from "node:test";
import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  createLazyModelGateway,
  resolveManagedWorktreesEnabledForRuntime,
  resolveReasoningModelForProfile,
} from "../../cli/runtime/KestrelChatRuntime.js";

const BASE_PROFILE: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

test("resolveReasoningModelForProfile falls back to the selected run model before weaker provider defaults", () => {
  const original = process.env.KCHAT_REASONING_MODEL;
  delete process.env.KCHAT_REASONING_MODEL;
  try {
    assert.equal(
      resolveReasoningModelForProfile({
        ...BASE_PROFILE,
        modelProvider: "openrouter",
        model: "z-ai/glm-5.2",
      }),
      "z-ai/glm-5.2",
    );
    assert.equal(
      resolveReasoningModelForProfile({
        ...BASE_PROFILE,
        modelProvider: "openrouter",
      }),
      "openai/gpt-4.1-nano",
    );
  } finally {
    if (original === undefined) {
      delete process.env.KCHAT_REASONING_MODEL;
    } else {
      process.env.KCHAT_REASONING_MODEL = original;
    }
  }
});

test("resolveReasoningModelForProfile honors explicit reasoning model overrides", () => {
  const original = process.env.KCHAT_REASONING_MODEL;
  process.env.KCHAT_REASONING_MODEL = "openai/gpt-4.1";
  try {
    assert.equal(
      resolveReasoningModelForProfile({
        ...BASE_PROFILE,
        modelProvider: "openrouter",
        model: "z-ai/glm-5.2",
      }),
      "openai/gpt-4.1",
    );
  } finally {
    if (original === undefined) {
      delete process.env.KCHAT_REASONING_MODEL;
    } else {
      process.env.KCHAT_REASONING_MODEL = original;
    }
  }
});

test("resolveManagedWorktreesEnabledForRuntime defaults off and honors explicit opt-in", () => {
  assert.equal(resolveManagedWorktreesEnabledForRuntime({}), false);
  assert.equal(resolveManagedWorktreesEnabledForRuntime({ KESTREL_ENABLE_MANAGED_WORKTREES: "true" }), true);
  assert.equal(resolveManagedWorktreesEnabledForRuntime({ KESTREL_ENABLE_MANAGED_WORKTREES: "false" }), false);
});

test("lazy model gateway defers provider validation until a model call and retries failed initialization", async () => {
  let configured = false;
  let factoryCalls = 0;
  const gateway = createLazyModelGateway(() => {
    factoryCalls += 1;
    if (configured === false) {
      throw new Error("provider credential required");
    }
    return {
      async call<T>(): Promise<T> {
        return "configured" as T;
      },
    };
  });

  assert.equal(factoryCalls, 0);
  await assert.rejects(gateway.call({ input: {} }), /provider credential required/u);
  assert.equal(factoryCalls, 1);

  configured = true;
  assert.equal(await gateway.call<string>({ input: {} }), "configured");
  assert.equal(await gateway.call<string>({ input: {} }), "configured");
  assert.equal(factoryCalls, 2);
});
