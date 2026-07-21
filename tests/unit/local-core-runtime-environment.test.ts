import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  LOCAL_CORE_CREDENTIAL_IDS,
  MemoryLocalCoreCredentialStore,
  type LocalCoreCredentialId,
} from "../../src/localCore/credentialStore.js";
import {
  LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS,
  LOCAL_CORE_MANAGED_RUNTIME_OPTION_ENV_KEYS,
  createLocalCoreRuntimeEnvironmentResolver,
  resolveLocalCoreRuntimeEnvironment,
} from "../../src/localCore/runtimeEnvironment.js";
import {
  createDefaultLocalCoreRuntimeConfiguration,
  type LocalCoreRuntimeConfigurationV1,
} from "../../src/localCore/runtimeConfiguration.js";

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

function configuredRuntime(): LocalCoreRuntimeConfigurationV1 {
  const defaults = createDefaultLocalCoreRuntimeConfiguration();
  return {
    ...defaults,
    generation: 1,
    environmentOptionsMode: "replace",
    providers: {
      ...defaults.providers,
      openrouter: {
        baseUrl: "https://openrouter.core.example/v1",
        siteUrl: "https://kestrel.example",
        appName: "Kestrel Core",
      },
      openai: {
        baseUrl: "https://openai.core.example/v1",
        organizationId: "org-core",
        projectId: "project-core",
      },
      anthropic: {
        baseUrl: "https://anthropic.core.example/v1",
        version: "2026-07-01",
      },
      ollama: {
        baseUrl: "http://ollama.core.example:11434",
      },
      lmstudio: {
        baseUrl: "http://lmstudio.core.example:1234/v1",
      },
    },
    tools: {
      ...defaults.tools,
      tavily: {
        baseUrl: "https://tavily.core.example",
        projectId: "tavily-project-core",
        httpProxyUrl: "http://proxy.core.example:8080",
        httpsProxyUrl: "https://proxy.core.example:8443",
      },
      visualCrossing: {
        baseUrl: "https://weather.visualcrossing.core.example",
      },
    },
  };
}

test("inherit mode preserves inherited non-secret options independent of generation", async () => {
  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv: {
      OPENROUTER_BASE_URL: "http://127.0.0.1:4242/v1",
      OPENROUTER_SITE_URL: "https://legacy.example",
      OPENAI_BASE_URL: "https://legacy-openai.example/v1",
      TAVILY_BASE_URL: "https://legacy-tavily.example",
      TAVILY_HTTP_PROXY: "http://legacy-proxy.example:8080",
    },
    runtimeConfiguration: {
      ...createDefaultLocalCoreRuntimeConfiguration(),
      generation: 4,
      environmentOptionsMode: "inherit",
    },
    resolvedProfile: {
      modelProvider: "openrouter",
      model: "z-ai/glm-5.2",
    },
  });

  assert.equal(snapshot.modelEnv.OPENROUTER_BASE_URL, "http://127.0.0.1:4242/v1");
  assert.equal(snapshot.modelEnv.OPENROUTER_SITE_URL, "https://legacy.example");
  assert.equal(snapshot.modelEnv.OPENAI_BASE_URL, "https://legacy-openai.example/v1");
  assert.equal(snapshot.internetEnv.TAVILY_BASE_URL, "https://legacy-tavily.example");
  assert.equal(snapshot.internetEnv.TAVILY_HTTP_PROXY, "http://legacy-proxy.example:8080");
  assert.equal(snapshot.runtimeEnv.OPENAI_BASE_URL, "https://legacy-openai.example/v1");
  assert.equal(snapshot.mcpEnv.TAVILY_BASE_URL, "https://legacy-tavily.example");
});

test("replace mode removes omitted inherited non-secret options independent of generation", async () => {
  const defaults = createDefaultLocalCoreRuntimeConfiguration();
  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv: {
      OPENROUTER_BASE_URL: "https://legacy-openrouter.example/v1",
      OPENAI_BASE_URL: "https://legacy-openai.example/v1",
      TAVILY_BASE_URL: "https://legacy-tavily.example",
    },
    runtimeConfiguration: {
      ...defaults,
      generation: 0,
      environmentOptionsMode: "replace",
    },
    resolvedProfile: {
      modelProvider: "openrouter",
      model: "z-ai/glm-5.2",
    },
  });

  assert.equal(snapshot.modelEnv.OPENROUTER_BASE_URL, undefined);
  assert.equal(snapshot.modelEnv.OPENAI_BASE_URL, undefined);
  assert.equal(snapshot.internetEnv.TAVILY_BASE_URL, undefined);
  assert.equal(snapshot.runtimeEnv.OPENAI_BASE_URL, undefined);
  assert.equal(snapshot.mcpEnv.TAVILY_BASE_URL, undefined);
});

test("Core credential values replace conflicting inherited provider and tool keys", async () => {
  const baseEnv: NodeJS.ProcessEnv = {
    HOME: "/tmp/kestrel-home",
    OPENROUTER_API_KEY: "inherited-openrouter",
    OPENAI_API_KEY: "inherited-openai",
    ANTHROPIC_API_KEY: "inherited-anthropic",
    TAVILY_API_KEY: "inherited-tavily",
    VISUAL_CROSSING_API_KEY: "inherited-visual-crossing",
  };

  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv,
    runtimeConfiguration: configuredRuntime(),
    resolvedProfile: {
      modelProvider: "openrouter",
      model: "z-ai/glm-5.2",
    },
    credentialStore: credentialReader({
      "provider.openrouter.default": "core-openrouter",
      "tool.tavily.default": "core-tavily",
      "tool.visual-crossing.default": "core-visual-crossing",
    }),
  });

  assert.equal(snapshot.modelEnv.HOME, "/tmp/kestrel-home");
  assert.equal(snapshot.modelEnv.OPENROUTER_API_KEY, "core-openrouter");
  assert.equal(snapshot.modelEnv.OPENAI_API_KEY, undefined);
  assert.equal(snapshot.modelEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(snapshot.modelEnv.TAVILY_API_KEY, undefined);
  assert.equal(snapshot.internetEnv.TAVILY_API_KEY, "core-tavily");
  assert.equal(
    snapshot.internetEnv.VISUAL_CROSSING_API_KEY,
    "core-visual-crossing",
  );
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
    VISUAL_CROSSING_API_KEY: "inherited-visual-crossing",
  });
});

test("ambient credentials remain available while canonical options replace inherited values", async () => {
  const inheritedOptions = Object.fromEntries(
    LOCAL_CORE_MANAGED_RUNTIME_OPTION_ENV_KEYS.map((key) => [
      key,
      `inherited-${key}`,
    ]),
  );
  const baseEnv: NodeJS.ProcessEnv = {
    HOME: "/tmp/ambient-home",
    OPENROUTER_API_KEY: "ambient-openrouter",
    OPENAI_API_KEY: "ambient-openai",
    ANTHROPIC_API_KEY: "ambient-anthropic",
    TAVILY_API_KEY: "ambient-tavily",
    ...inheritedOptions,
    OPENAI_BASE_URL_SUFFIX: "preserve-exact-non-match",
  };

  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv,
    runtimeConfiguration: configuredRuntime(),
    resolvedProfile: {
      modelProvider: "openai",
      model: "  gpt-core  ",
    },
  });

  for (const env of [
    snapshot.modelEnv,
    snapshot.internetEnv,
    snapshot.runtimeEnv,
    snapshot.mcpEnv,
  ]) {
    assert.equal(env.OPENROUTER_API_KEY, "ambient-openrouter");
    assert.equal(env.OPENAI_API_KEY, "ambient-openai");
    assert.equal(env.ANTHROPIC_API_KEY, "ambient-anthropic");
    assert.equal(env.TAVILY_API_KEY, "ambient-tavily");
    assert.equal(env.OPENAI_BASE_URL_SUFFIX, "preserve-exact-non-match");
  }

  assert.equal(snapshot.modelEnv.OPENAI_MODEL, "gpt-core");
  assert.equal(
    snapshot.modelEnv.OPENAI_BASE_URL,
    "https://openai.core.example/v1",
  );
  assert.equal(snapshot.modelEnv.OPENAI_ORG_ID, "org-core");
  assert.equal(snapshot.modelEnv.OPENAI_PROJECT_ID, "project-core");
  assert.equal(snapshot.modelEnv.OPENROUTER_MODEL, undefined);
  assert.equal(snapshot.modelEnv.OPENROUTER_BASE_URL, undefined);
  assert.equal(snapshot.modelEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(snapshot.modelEnv.OLLAMA_BASE_URL, undefined);
  assert.equal(snapshot.modelEnv.LMSTUDIO_BASE_URL, undefined);
  assert.equal(snapshot.modelEnv.TAVILY_BASE_URL, undefined);

  assert.equal(
    snapshot.internetEnv.TAVILY_BASE_URL,
    "https://tavily.core.example",
  );
  assert.equal(snapshot.internetEnv.TAVILY_PROJECT, "tavily-project-core");
  assert.equal(
    snapshot.internetEnv.TAVILY_HTTP_PROXY,
    "http://proxy.core.example:8080",
  );
  assert.equal(
    snapshot.internetEnv.TAVILY_HTTPS_PROXY,
    "https://proxy.core.example:8443",
  );
  assert.equal(snapshot.internetEnv.OPENAI_MODEL, undefined);
  assert.equal(snapshot.internetEnv.OPENAI_BASE_URL, undefined);

  for (const key of LOCAL_CORE_MANAGED_RUNTIME_OPTION_ENV_KEYS) {
    assert.equal(snapshot.runtimeEnv[key], undefined);
    assert.equal(snapshot.mcpEnv[key], undefined);
  }
  assert.equal(
    JSON.stringify(snapshot.runtimeEnv).includes("ambient-openai"),
    false,
  );
  assert.equal(
    JSON.stringify(snapshot.runtimeEnv).includes("[REDACTED]"),
    true,
  );
  assert.equal(inspect(snapshot.mcpEnv).includes("ambient-tavily"), false);
  assert.equal(inspect(snapshot.mcpEnv).includes("[REDACTED]"), true);
});

test("credential authority scrubs ambient secrets while retaining scoped canonical options", async () => {
  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv: {
      OPENROUTER_API_KEY: "ambient-openrouter",
      OPENAI_API_KEY: "ambient-openai",
      ANTHROPIC_API_KEY: "ambient-anthropic",
      TAVILY_API_KEY: "ambient-tavily",
      OPENROUTER_BASE_URL: "https://inherited-openrouter.example",
      OPENAI_BASE_URL: "https://inherited-openai.example",
      TAVILY_BASE_URL: "https://inherited-tavily.example",
    },
    runtimeConfiguration: configuredRuntime(),
    resolvedProfile: {
      modelProvider: "openrouter",
      model: "openrouter/core-model",
    },
    credentialStore: credentialReader({
      "provider.openrouter.default": "core-openrouter",
      "provider.openai.default": "core-openai",
      "provider.anthropic.default": "core-anthropic",
      "tool.tavily.default": "core-tavily",
      "tool.visual-crossing.default": "core-visual-crossing",
    }),
  });

  assert.equal(snapshot.modelEnv.OPENROUTER_API_KEY, "core-openrouter");
  assert.equal(snapshot.modelEnv.OPENAI_API_KEY, undefined);
  assert.equal(snapshot.modelEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(snapshot.modelEnv.TAVILY_API_KEY, undefined);
  assert.equal(snapshot.modelEnv.OPENROUTER_MODEL, "openrouter/core-model");
  assert.equal(
    snapshot.modelEnv.OPENROUTER_BASE_URL,
    "https://openrouter.core.example/v1",
  );
  assert.equal(snapshot.modelEnv.OPENAI_BASE_URL, undefined);
  assert.equal(snapshot.modelEnv.TAVILY_BASE_URL, undefined);

  assert.equal(snapshot.internetEnv.TAVILY_API_KEY, "core-tavily");
  assert.equal(
    snapshot.internetEnv.VISUAL_CROSSING_API_KEY,
    "core-visual-crossing",
  );
  assert.equal(snapshot.internetEnv.OPENROUTER_API_KEY, undefined);
  assert.equal(snapshot.internetEnv.OPENAI_API_KEY, undefined);
  assert.equal(
    snapshot.internetEnv.TAVILY_BASE_URL,
    "https://tavily.core.example",
  );
  assert.equal(
    snapshot.internetEnv.VISUAL_CROSSING_BASE_URL,
    "https://weather.visualcrossing.core.example",
  );
  assert.equal(snapshot.internetEnv.OPENROUTER_BASE_URL, undefined);

  for (const key of [
    ...LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS,
    ...LOCAL_CORE_MANAGED_RUNTIME_OPTION_ENV_KEYS,
  ]) {
    assert.equal(snapshot.runtimeEnv[key], undefined);
    assert.equal(snapshot.mcpEnv[key], undefined);
  }
});

test("selected provider model and URL options map to their exact environment contracts", async () => {
  const cases = [
    {
      provider: "openrouter",
      modelKey: "OPENROUTER_MODEL",
      baseUrlKey: "OPENROUTER_BASE_URL",
      baseUrl: "https://openrouter.core.example/v1",
      optionKey: "OPENROUTER_SITE_URL",
      option: "https://kestrel.example",
    },
    {
      provider: "openai",
      modelKey: "OPENAI_MODEL",
      baseUrlKey: "OPENAI_BASE_URL",
      baseUrl: "https://openai.core.example/v1",
      optionKey: "OPENAI_PROJECT_ID",
      option: "project-core",
    },
    {
      provider: "anthropic",
      modelKey: "ANTHROPIC_MODEL",
      baseUrlKey: "ANTHROPIC_BASE_URL",
      baseUrl: "https://anthropic.core.example/v1",
      optionKey: "ANTHROPIC_VERSION",
      option: "2026-07-01",
    },
    {
      provider: "ollama",
      modelKey: "OLLAMA_MODEL",
      baseUrlKey: "OLLAMA_BASE_URL",
      baseUrl: "http://ollama.core.example:11434",
    },
    {
      provider: "lmstudio",
      modelKey: "LMSTUDIO_MODEL",
      baseUrlKey: "LMSTUDIO_BASE_URL",
      baseUrl: "http://lmstudio.core.example:1234/v1",
    },
  ] as const;

  for (const entry of cases) {
    const snapshot = await resolveLocalCoreRuntimeEnvironment({
      baseEnv: {},
      runtimeConfiguration: configuredRuntime(),
      resolvedProfile: {
        modelProvider: entry.provider,
        model: `${entry.provider}-model`,
      },
    });

    assert.equal(snapshot.modelEnv[entry.modelKey], `${entry.provider}-model`);
    assert.equal(snapshot.modelEnv[entry.baseUrlKey], entry.baseUrl);
    if ("optionKey" in entry) {
      assert.equal(snapshot.modelEnv[entry.optionKey], entry.option);
    }
    for (const other of cases) {
      if (other.provider !== entry.provider) {
        assert.equal(snapshot.modelEnv[other.modelKey], undefined);
        assert.equal(snapshot.modelEnv[other.baseUrlKey], undefined);
      }
    }
  }
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
    runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
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
      runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
      resolvedProfile: {
        modelProvider,
        model: "local-model",
      },
      credentialStore: credentialReader(
        {
          "provider.openrouter.default": "core-openrouter",
          "provider.openai.default": "core-openai",
          "provider.anthropic.default": "core-anthropic",
          "tool.tavily.default": "core-tavily",
        },
        reads,
      ),
    });

    assert.deepEqual(reads, LOCAL_CORE_CREDENTIAL_IDS.filter((id) => id !== "data.database.external"));
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
    runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
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
  assert.deepEqual(reads, LOCAL_CORE_CREDENTIAL_IDS.filter((id) => id !== "data.database.external"));
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
    runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
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
    runtimeConfiguration: configuredRuntime(),
    resolvedProfile: {
      modelProvider: "openrouter",
      model: "  z-ai/glm-5.2  ",
    },
    credentialStore: credentialReader({
      "provider.openrouter.default": "core-openrouter",
      "tool.tavily.default": "core-tavily",
      "tool.visual-crossing.default": "core-visual-crossing",
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
    "OPENROUTER_MODEL",
    "OPENROUTER_BASE_URL",
    "OPENROUTER_SITE_URL",
    "OPENROUTER_APP_NAME",
    "OPENROUTER_API_KEY",
  ]);
  assert.deepEqual(Object.keys(snapshot.internetEnv), [
    "ALPHA",
    "ZED",
    "TAVILY_BASE_URL",
    "TAVILY_PROJECT",
    "TAVILY_HTTP_PROXY",
    "TAVILY_HTTPS_PROXY",
    "VISUAL_CROSSING_BASE_URL",
    "TAVILY_API_KEY",
    "VISUAL_CROSSING_API_KEY",
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
    Object.getOwnPropertyDescriptor(snapshot.modelEnv, "OPENROUTER_API_KEY")
      ?.enumerable,
    true,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(snapshot.internetEnv, "TAVILY_API_KEY")
      ?.enumerable,
    true,
  );
  assert.equal({ ...snapshot.modelEnv }.OPENROUTER_API_KEY, "core-openrouter");
  assert.equal({ ...snapshot.internetEnv }.TAVILY_API_KEY, "core-tavily");
  assert.equal(
    { ...snapshot.internetEnv }.VISUAL_CROSSING_API_KEY,
    "core-visual-crossing",
  );
  assert.equal(
    JSON.stringify(snapshot),
    '{"modelProvider":"openrouter","model":"z-ai/glm-5.2"}',
  );
  assert.equal(JSON.stringify(snapshot).includes("core-openrouter"), false);
  assert.equal(
    JSON.stringify(snapshot.modelEnv).includes("core-openrouter"),
    false,
  );
  assert.equal(JSON.stringify(snapshot.modelEnv).includes("[REDACTED]"), true);
  assert.equal(
    JSON.stringify(snapshot.internetEnv).includes("core-tavily"),
    false,
  );
  assert.equal(
    JSON.stringify(snapshot.internetEnv).includes("core-visual-crossing"),
    false,
  );
  assert.equal(
    JSON.stringify(snapshot.internetEnv).includes("[REDACTED]"),
    true,
  );
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
      runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
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
      runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
      resolvedProfile: {
        modelProvider: "openrouter",
        model: "   ",
      },
      credentialStore: credentialReader({}),
    }),
    /runtime model must be a non-empty string/u,
  );
});

test("Core materializes referenced MCP credentials without exposing them to other runtime views", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("mcp.docs.header.default", "mcp-secret");
  const snapshot = await resolveLocalCoreRuntimeEnvironment({
    baseEnv: { KESTREL_MCP_DOCS_HEADER: "ambient-secret", SAFE: "safe" },
    resolvedProfile: { modelProvider: "ollama", model: "qwen3:8b" },
    runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
    credentialStore: store,
    mcpCredentialBindings: [{ credentialId: "mcp.docs.header.default", envKey: "KESTREL_MCP_DOCS_HEADER" }],
  });
  assert.equal(snapshot.mcpEnv.KESTREL_MCP_DOCS_HEADER, "mcp-secret");
  assert.equal(snapshot.runtimeEnv.KESTREL_MCP_DOCS_HEADER, undefined);
  assert.equal(snapshot.mcpEnv.SAFE, "safe");
  assert.equal(JSON.stringify(snapshot).includes("mcp-secret"), false);
});
