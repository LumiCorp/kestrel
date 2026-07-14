import test from "node:test";
import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  createModelGatewayForProfile,
  resolveManagedWorktreesEnabledForRuntime,
  resolveReasoningModelForProfile,
} from "../../cli/runtime/KestrelChatRuntime.js";
import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";

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

test("resolveReasoningModelForProfile treats an explicit environment as authoritative", () => {
  const original = process.env.KCHAT_REASONING_MODEL;
  process.env.KCHAT_REASONING_MODEL = "ambient-model";
  try {
    assert.equal(
      resolveReasoningModelForProfile({
        ...BASE_PROFILE,
        modelProvider: "openrouter",
        model: "profile-model",
      }, {}),
      "profile-model",
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

test("gateway-managed profiles use the credential broker path instead of provider environment defaults", () => {
  const brokeredGateway = { call: async <T>() => ({ ok: true }) as T } satisfies ModelGateway;
  let capturedProfile: TuiProfile | undefined;

  const resolved = createModelGatewayForProfile(
    {
      ...BASE_PROFILE,
      modelProvider: "openrouter",
      model: "openai/gpt-5.4",
      modelCredential: {
        source: "kestrel-one",
        organizationId: "org-acme",
        gatewayId: "gateway-openrouter",
        rawModelId: "openai/gpt-5.4",
      },
    },
    {
      createGatewayManaged(profile) {
        capturedProfile = profile;
        return brokeredGateway;
      },
    },
  );

  assert.equal(resolved, brokeredGateway);
  assert.equal(capturedProfile?.model, "openai/gpt-5.4");
  assert.equal(capturedProfile?.modelCredential?.gatewayId, "gateway-openrouter");
});

test("non-managed profiles retain their environment-backed provider behavior", () => {
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "runner-environment-key";
  try {
    assert.doesNotThrow(() =>
      createModelGatewayForProfile({
        ...BASE_PROFILE,
        modelProvider: "openrouter",
        model: "openai/gpt-5.4",
      })
    );
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = original;
    }
  }
});

test("non-model runtime surfaces initialize before environment provider credentials are present", async () => {
  const original = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const gateway = createModelGatewayForProfile({
      ...BASE_PROFILE,
      modelProvider: "openrouter",
      model: "openai/gpt-5.4",
    });
    await assert.rejects(
      gateway.call({ input: "model admission should resolve credentials now" }),
      /OPENROUTER_API_KEY is required/u
    );
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = original;
    }
  }
});

test("model gateway treats an explicit environment as authoritative", async () => {
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "ambient-key-must-not-leak";
  try {
    const gateway = createModelGatewayForProfile({
      ...BASE_PROFILE,
      modelProvider: "openrouter",
      model: "openai/gpt-5.4",
    }, { env: {} });
    await assert.rejects(
      gateway.call({ input: "explicit runtime environment only" }),
      /OPENROUTER_API_KEY is required/u,
    );
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = original;
    }
  }
});
