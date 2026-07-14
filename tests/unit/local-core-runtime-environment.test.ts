import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  LOCAL_CORE_CREDENTIAL_IDS,
  type LocalCoreCredentialId,
} from "../../src/localCore/credentialStore.js";
import {
  LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS,
  createLocalCoreRuntimeEnvironmentResolver,
  resolveLocalCoreRuntimeEnvironment,
} from "../../src/localCore/runtimeEnvironment.js";

function credentialReader(
  values: Partial<Record<LocalCoreCredentialId, string>>,
  reads: LocalCoreCredentialId[] = [],
) {
  return {
    async get(id: LocalCoreCredentialId): Promise<string | undefined> {
      reads.push(id);
      return values[id];
    },
  };
}

test("Core credential values replace conflicting inherited provider and tool keys", async () => {
  const baseEnv: NodeJS.ProcessEnv = {
    HOME: "/tmp/kestrel-home",
    OPENROUTER_API_KEY: "inherited-openrouter",
    OPENAI_API_KEY: "inherited-openai",
    ANTHROPIC_API_KEY: "inherited-anthropic",
    TAVILY_API_KEY: "inherited-tavily",
  };

  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv,
    resolvedProfile: {
      modelProvider: "openrouter",
      model: "z-ai/glm-5.2",
    },
    credentialStore: credentialReader({
      "provider.openrouter.default": "core-openrouter",
      "tool.tavily.default": "core-tavily",
    }),
  });

  assert.equal(snapshot.modelEnv.HOME, "/tmp/kestrel-home");
  assert.equal(snapshot.modelEnv.OPENROUTER_API_KEY, "core-openrouter");
  assert.equal(snapshot.modelEnv.OPENAI_API_KEY, undefined);
  assert.equal(snapshot.modelEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(snapshot.modelEnv.TAVILY_API_KEY, undefined);
  assert.equal(snapshot.internetEnv.TAVILY_API_KEY, "core-tavily");
  assert.equal(snapshot.internetEnv.OPENROUTER_API_KEY, undefined);
  for (const key of LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS) {
    assert.equal(snapshot.runtimeEnv[key], undefined);
    assert.equal(snapshot.mcpEnv[key], undefined);
  }
  assert.deepEqual(baseEnv, {
    HOME: "/tmp/kestrel-home",
    OPENROUTER_API_KEY: "inherited-openrouter",
    OPENAI_API_KEY: "inherited-openai",
    ANTHROPIC_API_KEY: "inherited-anthropic",
    TAVILY_API_KEY: "inherited-tavily",
  });
});

test("Core injects only the selected hosted provider credential", async () => {
  const credentials = {
    "provider.openrouter.default": "core-openrouter",
    "provider.openai.default": "core-openai",
    "provider.anthropic.default": "core-anthropic",
    "tool.tavily.default": "core-tavily",
  } as const;

  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv: {},
    resolvedProfile: {
      modelProvider: "openai",
      model: "gpt-5.4-2026-03-05",
    },
    credentialStore: credentialReader(credentials),
  });

  assert.equal(snapshot.modelEnv.OPENAI_API_KEY, "core-openai");
  assert.equal(snapshot.modelEnv.OPENROUTER_API_KEY, undefined);
  assert.equal(snapshot.modelEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(snapshot.modelEnv.TAVILY_API_KEY, undefined);
  assert.equal(snapshot.internetEnv.TAVILY_API_KEY, "core-tavily");
  assert.equal(snapshot.internetEnv.OPENAI_API_KEY, undefined);
});

test("Core does not request or inject hosted-provider credentials for local providers", async () => {
  for (const modelProvider of ["ollama", "lmstudio"] as const) {
    const reads: LocalCoreCredentialId[] = [];
    const snapshot = await resolveLocalCoreRuntimeEnvironment({
      baseEnv: {
        OPENROUTER_API_KEY: "inherited-openrouter",
        OPENAI_API_KEY: "inherited-openai",
        ANTHROPIC_API_KEY: "inherited-anthropic",
      },
      resolvedProfile: {
        modelProvider,
        model: "local-model",
      },
      credentialStore: credentialReader({
        "provider.openrouter.default": "core-openrouter",
        "provider.openai.default": "core-openai",
        "provider.anthropic.default": "core-anthropic",
        "tool.tavily.default": "core-tavily",
      }, reads),
    });

    assert.deepEqual(reads, LOCAL_CORE_CREDENTIAL_IDS);
    assert.equal(snapshot.modelEnv.OPENROUTER_API_KEY, undefined);
    assert.equal(snapshot.modelEnv.OPENAI_API_KEY, undefined);
    assert.equal(snapshot.modelEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(snapshot.modelEnv.TAVILY_API_KEY, undefined);
    assert.equal(snapshot.internetEnv.TAVILY_API_KEY, "core-tavily");
  }
});

test("Core captures base environment and credentials once for synchronous profile resolution", async () => {
  const reads: LocalCoreCredentialId[] = [];
  const baseEnv: NodeJS.ProcessEnv = {
    HOME: "/captured/home",
    OPENAI_API_KEY: "inherited-openai",
  };
  const credentials: Partial<Record<LocalCoreCredentialId, string>> = {
    "provider.openrouter.default": "captured-openrouter",
    "provider.openai.default": "captured-openai",
    "tool.tavily.default": "captured-tavily",
  };
  const resolver = await createLocalCoreRuntimeEnvironmentResolver({
    baseEnv,
    credentialStore: credentialReader(credentials, reads),
  });

  baseEnv.HOME = "/mutated/home";
  credentials["provider.openrouter.default"] = "mutated-openrouter";
  credentials["provider.openai.default"] = "mutated-openai";
  credentials["tool.tavily.default"] = "mutated-tavily";

  const openRouter = resolver.resolve({
    modelProvider: "openrouter",
    model: "z-ai/glm-5.2",
  });
  const openAi = resolver.resolve({
    modelProvider: "openai",
    model: "gpt-5.4-2026-03-05",
  });

  assert.equal(Object.isFrozen(resolver), true);
  assert.equal(Object.isFrozen(resolver.resolve), true);
  assert.deepEqual(reads, LOCAL_CORE_CREDENTIAL_IDS);
  assert.equal(openRouter.modelEnv.HOME, "/captured/home");
  assert.equal(openRouter.modelEnv.OPENROUTER_API_KEY, "captured-openrouter");
  assert.equal(openRouter.internetEnv.TAVILY_API_KEY, "captured-tavily");
  assert.equal(openAi.modelEnv.OPENAI_API_KEY, "captured-openai");
  assert.equal(openAi.modelEnv.OPENROUTER_API_KEY, undefined);
  assert.equal(openAi.internetEnv.TAVILY_API_KEY, "captured-tavily");
  assert.equal("then" in openRouter, false);
});

test("Missing Core credentials remain absent after inherited keys are scrubbed", async () => {
  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv: {
      OPENROUTER_API_KEY: "inherited-openrouter",
      TAVILY_API_KEY: "inherited-tavily",
    },
    resolvedProfile: {
      modelProvider: "openrouter",
      model: "z-ai/glm-5.2",
    },
    credentialStore: credentialReader({}),
  });

  for (const key of LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS) {
    for (const env of [
      snapshot.modelEnv,
      snapshot.internetEnv,
      snapshot.runtimeEnv,
      snapshot.mcpEnv,
    ]) {
      assert.equal(env[key], undefined);
      assert.equal(Object.hasOwn(env, key), false);
    }
  }
});

test("Core runtime snapshots are canonical, frozen, and redaction-aware", async () => {
  const baseEnv: NodeJS.ProcessEnv = {
    ZED: "last",
    OPENROUTER_API_KEY: "inherited-openrouter",
    ALPHA: "first",
    OMITTED: undefined,
  };
  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv,
    resolvedProfile: {
      modelProvider: "openrouter",
      model: "  z-ai/glm-5.2  ",
    },
    credentialStore: credentialReader({
      "provider.openrouter.default": "core-openrouter",
      "tool.tavily.default": "core-tavily",
    }),
  });

  assert.equal(snapshot.modelProvider, "openrouter");
  assert.equal(snapshot.model, "z-ai/glm-5.2");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.modelEnv), true);
  assert.equal(Object.isFrozen(snapshot.internetEnv), true);
  assert.equal(Object.isFrozen(snapshot.runtimeEnv), true);
  assert.equal(Object.isFrozen(snapshot.mcpEnv), true);
  assert.deepEqual(Object.keys(snapshot), ["modelProvider", "model"]);
  assert.deepEqual(Object.keys(snapshot.modelEnv), [
    "ALPHA",
    "ZED",
    "OPENROUTER_API_KEY",
  ]);
  assert.deepEqual(Object.keys(snapshot.internetEnv), [
    "ALPHA",
    "ZED",
    "TAVILY_API_KEY",
  ]);
  assert.deepEqual(Object.keys(snapshot.runtimeEnv), ["ALPHA", "ZED"]);
  assert.deepEqual(Object.keys(snapshot.mcpEnv), ["ALPHA", "ZED"]);
  assert.equal(
    Object.getOwnPropertyDescriptor(snapshot, "modelEnv")?.enumerable,
    false,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(snapshot, "internetEnv")?.enumerable,
    false,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(snapshot.modelEnv, "OPENROUTER_API_KEY")?.enumerable,
    true,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(snapshot.internetEnv, "TAVILY_API_KEY")?.enumerable,
    true,
  );
  assert.equal(
    ({ ...snapshot.modelEnv }).OPENROUTER_API_KEY,
    "core-openrouter",
  );
  assert.equal(
    ({ ...snapshot.internetEnv }).TAVILY_API_KEY,
    "core-tavily",
  );
  assert.equal(
    JSON.stringify(snapshot),
    '{"modelProvider":"openrouter","model":"z-ai/glm-5.2"}',
  );
  assert.equal(JSON.stringify(snapshot).includes("core-openrouter"), false);
  assert.equal(JSON.stringify(snapshot.modelEnv).includes("core-openrouter"), false);
  assert.equal(JSON.stringify(snapshot.modelEnv).includes("[REDACTED]"), true);
  assert.equal(JSON.stringify(snapshot.internetEnv).includes("core-tavily"), false);
  assert.equal(JSON.stringify(snapshot.internetEnv).includes("[REDACTED]"), true);
  assert.equal(inspect(snapshot.modelEnv).includes("core-openrouter"), false);
  assert.equal(inspect(snapshot.modelEnv).includes("[REDACTED]"), true);
  assert.equal(inspect(snapshot.internetEnv).includes("core-tavily"), false);
  assert.equal(inspect(snapshot.internetEnv).includes("[REDACTED]"), true);

  assert.throws(() => {
    (snapshot.modelEnv as NodeJS.ProcessEnv).ALPHA = "changed";
  }, TypeError);
  assert.throws(() => {
    (snapshot as { model: string }).model = "changed";
  }, TypeError);
  assert.deepEqual(baseEnv, {
    ZED: "last",
    OPENROUTER_API_KEY: "inherited-openrouter",
    ALPHA: "first",
    OMITTED: undefined,
  });
});

test("Core runtime snapshots reject unresolved provider and model values", async () => {
  await assert.rejects(
    resolveLocalCoreRuntimeEnvironment({
      baseEnv: {},
      resolvedProfile: {
        modelProvider: "unsupported" as "openrouter",
        model: "valid-model",
      },
      credentialStore: credentialReader({}),
    }),
    /modelProvider must be one of/u,
  );
  await assert.rejects(
    resolveLocalCoreRuntimeEnvironment({
      baseEnv: {},
      resolvedProfile: {
        modelProvider: "openrouter",
        model: "   ",
      },
      credentialStore: credentialReader({}),
    }),
    /runtime model must be a non-empty string/u,
  );
});
