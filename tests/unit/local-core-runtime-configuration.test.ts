import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultModelPolicy } from "../../src/profile/modelPolicy.js";
import {
  createDefaultLocalCoreRuntimeConfiguration,
  LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME,
  LOCAL_CORE_RUNTIME_CONFIGURATION_VERSION,
  LocalCoreRuntimeConfigurationError,
  LocalCoreRuntimeConfigurationStore,
  parseLocalCoreRuntimeConfiguration,
} from "../../src/localCore/runtimeConfiguration.js";

test("runtime configuration defaults expose the exact immutable v1 shape", () => {
  const configuration = createDefaultLocalCoreRuntimeConfiguration();

  assert.deepEqual(configuration, {
    version: LOCAL_CORE_RUNTIME_CONFIGURATION_VERSION,
    generation: 0,
    environmentOptionsMode: "inherit",
    modelPolicy: createDefaultModelPolicy(),
    providers: {
      openrouter: {},
      openai: {},
      anthropic: {},
      ollama: {},
      lmstudio: {},
    },
    tools: {
      tavily: {},
    },
  });
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.modelPolicy), true);
  assert.equal(Object.isFrozen(configuration.modelPolicy.modelCapabilities), true);
  assert.equal(Object.isFrozen(configuration.providers), true);
  assert.equal(Object.isFrozen(configuration.providers.openrouter), true);
  assert.equal(Object.isFrozen(configuration.tools.tavily), true);
});

test("runtime configuration parser trims strings and canonicalizes HTTP URLs", () => {
  const configuration = parseLocalCoreRuntimeConfiguration({
    ...createDefaultLocalCoreRuntimeConfiguration(),
    generation: 3,
    providers: {
      openrouter: {
        baseUrl: " HTTPS://EXAMPLE.COM:443/v1 ",
        siteUrl: "https://kestrel.example/team",
        appName: " Kestrel Desktop ",
      },
      openai: {
        baseUrl: "https://api.openai.example",
        organizationId: " org-1 ",
        projectId: " project-1 ",
      },
      anthropic: {
        baseUrl: "https://anthropic.example/v1/",
        version: " 2023-06-01 ",
      },
      ollama: {
        baseUrl: "http://localhost:11434",
      },
      lmstudio: {},
    },
    tools: {
      tavily: {
        baseUrl: "https://tavily.example",
        projectId: " search-project ",
        httpProxyUrl: "http://proxy.example:8080",
        httpsProxyUrl: "https://proxy.example:8443/path",
      },
    },
  });

  assert.equal(configuration.providers.openrouter.baseUrl, "https://example.com/v1");
  assert.equal(configuration.providers.openrouter.appName, "Kestrel Desktop");
  assert.equal(configuration.providers.openai.baseUrl, "https://api.openai.example/");
  assert.equal(configuration.providers.openai.organizationId, "org-1");
  assert.equal(configuration.providers.anthropic.version, "2023-06-01");
  assert.equal(configuration.providers.ollama.baseUrl, "http://localhost:11434/");
  assert.equal(configuration.tools.tavily.projectId, "search-project");
  assert.equal(configuration.tools.tavily.httpsProxyUrl, "https://proxy.example:8443/path");
});

test("runtime configuration rejects unknown and credential-shaped fields", () => {
  const defaults = createDefaultLocalCoreRuntimeConfiguration();
  assert.throws(
    () => parseLocalCoreRuntimeConfiguration({ ...defaults, extra: true }),
    LocalCoreRuntimeConfigurationError,
  );
  assert.throws(
    () => parseLocalCoreRuntimeConfiguration({
      ...defaults,
      providers: {
        ...defaults.providers,
        openai: { apiKey: "must-not-be-configured-here" },
      },
    }),
    /must not contain credential fields/u,
  );
  assert.throws(
    () => parseLocalCoreRuntimeConfiguration({
      ...defaults,
      modelPolicy: {
        ...defaults.modelPolicy,
        apiToken: "must-not-be-configured-here",
      },
    }),
    /modelPolicy is invalid/u,
  );
  assert.throws(
    () => parseLocalCoreRuntimeConfiguration({
      ...defaults,
      tools: {
        tavily: { unknown: "value" },
      },
    }),
    /unsupported field/u,
  );
});

test("runtime configuration rejects credential-bearing and non-HTTP URLs", () => {
  const defaults = createDefaultLocalCoreRuntimeConfiguration();
  for (const baseUrl of [
    "https://user:password@example.com/v1",
    "https://example.com/v1?api_key=secret",
    "https://example.com/v1#credential",
    "file:///tmp/provider",
    "not-a-url",
  ]) {
    assert.throws(
      () => parseLocalCoreRuntimeConfiguration({
        ...defaults,
        providers: {
          ...defaults.providers,
          openai: { baseUrl },
        },
      }),
      LocalCoreRuntimeConfigurationError,
    );
  }
});

test("runtime configuration rejects wrong versions, generations, option modes, and model policies", () => {
  const defaults = createDefaultLocalCoreRuntimeConfiguration();
  for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => parseLocalCoreRuntimeConfiguration({ ...defaults, generation }),
      /generation/u,
    );
  }
  assert.throws(
    () => parseLocalCoreRuntimeConfiguration({ ...defaults, version: 2 }),
    /version/u,
  );
  for (const environmentOptionsMode of [undefined, "ambient", true]) {
    assert.throws(
      () => parseLocalCoreRuntimeConfiguration({
        ...defaults,
        environmentOptionsMode,
      }),
      /environmentOptionsMode/u,
    );
  }
  assert.throws(
    () => parseLocalCoreRuntimeConfiguration({
      ...defaults,
      modelPolicy: { ...defaults.modelPolicy, version: 2 },
    }),
    /modelPolicy is invalid/u,
  );
  assert.throws(
    () => parseLocalCoreRuntimeConfiguration({
      ...defaults,
      modelPolicy: {
        ...defaults.modelPolicy,
        modelCapabilities: {
          ...defaults.modelPolicy.modelCapabilities,
          futureCapability: true,
        },
      },
    }),
    /modelPolicy is invalid/u,
  );
});

test("runtime configuration store durably captures frozen bootstrap defaults once", async () => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-config-"));
  try {
    let fallbackCalls = 0;
    const syncedDirectories: string[] = [];
    const store = new LocalCoreRuntimeConfigurationStore(homePath, {
      async fallbackModelPolicy() {
        fallbackCalls += 1;
        return {
          ...createDefaultModelPolicy(),
          provider: "ollama",
          model: "llama3.2:3b",
        };
      },
      async syncDirectory(directoryPath) {
        syncedDirectories.push(directoryPath);
      },
    });

    const [configuration, concurrentConfiguration] = await Promise.all([
      store.read(),
      store.read(),
    ]);

    assert.equal(configuration.generation, 0);
    assert.equal(configuration.modelPolicy.provider, "ollama");
    assert.equal(configuration.modelPolicy.model, "llama3.2:3b");
    assert.equal(Object.isFrozen(configuration), true);
    assert.equal(fallbackCalls, 1);
    assert.deepEqual(concurrentConfiguration, configuration);

    const filePath = path.join(
      homePath,
      "settings",
      LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME,
    );
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), configuration);
    assert.deepEqual(syncedDirectories, [path.dirname(filePath)]);

    await store.read();
    assert.equal(fallbackCalls, 1);
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});

test("runtime configuration store atomically persists private files and increments generation", async () => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-config-"));
  try {
    const store = new LocalCoreRuntimeConfigurationStore(homePath);
    const first = await store.write(createDefaultLocalCoreRuntimeConfiguration());
    const second = await store.update((current) => ({
      ...current,
      providers: {
        ...current.providers,
        openai: {
          baseUrl: " https://openai.example/v1 ",
          organizationId: " org-2 ",
        },
      },
    }));

    assert.equal(first.generation, 0);
    assert.equal(second.generation, 1);
    assert.equal(second.providers.openai.baseUrl, "https://openai.example/v1");
    assert.equal(Object.isFrozen(second), true);
    assert.deepEqual(await store.read(), second);

    const settingsPath = path.join(homePath, "settings");
    const filePath = path.join(settingsPath, LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME);
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o700);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(settingsPath), [LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME]);
    assert.equal((JSON.parse(await readFile(filePath, "utf8")) as { generation: number }).generation, 1);
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});

test("runtime configuration store rejects invalid persisted files without repairing them", async () => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-config-"));
  const settingsPath = path.join(homePath, "settings");
  const filePath = path.join(settingsPath, LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME);
  try {
    await mkdir(settingsPath, { recursive: true });
    await writeFile(filePath, "{not-json}\n", "utf8");
    const store = new LocalCoreRuntimeConfigurationStore(homePath);

    await assert.rejects(
      store.read(),
      (error: unknown) => error instanceof LocalCoreRuntimeConfigurationError
        && error.code === "LOCAL_CORE_RUNTIME_CONFIGURATION_INVALID",
    );
    assert.equal(await readFile(filePath, "utf8"), "{not-json}\n");
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});

test("runtime configuration store repairs only an invalid persisted snapshot", async () => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-config-"));
  const settingsPath = path.join(homePath, "settings");
  const filePath = path.join(settingsPath, LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME);
  try {
    await mkdir(settingsPath, { recursive: true });
    await writeFile(filePath, "{not-json}\n", "utf8");
    const store = new LocalCoreRuntimeConfigurationStore(homePath);
    const replacement = {
      ...createDefaultLocalCoreRuntimeConfiguration(),
      generation: 9,
      environmentOptionsMode: "replace" as const,
    };
    const repaired = {
      ...replacement,
      generation: 5,
    };

    assert.deepEqual(
      await store.repairInvalid(replacement, { lastKnownGeneration: 4 }),
      repaired,
    );
    assert.deepEqual(await store.read(), repaired);
    await assert.rejects(
      store.repairInvalid(createDefaultLocalCoreRuntimeConfiguration()),
      (error: unknown) => error instanceof LocalCoreRuntimeConfigurationError
        && error.code === "LOCAL_CORE_RUNTIME_CONFIGURATION_REPAIR_NOT_REQUIRED",
    );
    assert.deepEqual(await store.read(), repaired);
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});

test("invalid writes and updates preserve the last valid configuration and clean temporary files", async () => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-config-"));
  try {
    const store = new LocalCoreRuntimeConfigurationStore(homePath);
    await store.write(createDefaultLocalCoreRuntimeConfiguration());
    const filePath = path.join(homePath, "settings", LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME);
    const original = await readFile(filePath, "utf8");

    await assert.rejects(store.write({ version: 1 }), LocalCoreRuntimeConfigurationError);
    await assert.rejects(
      store.update((current) => ({ ...current, accessToken: "not-allowed" })),
      LocalCoreRuntimeConfigurationError,
    );

    assert.equal(await readFile(filePath, "utf8"), original);
    assert.deepEqual(await readdir(path.dirname(filePath)), [
      LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME,
    ]);
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});
