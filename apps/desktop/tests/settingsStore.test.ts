import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultModelPolicy } from "../../../src/profile/modelPolicy.js";

import {
  buildDesktopRunnerEnvironment,
  buildDesktopRunnerProfile,
  buildDesktopModelEnvironment,
  createDefaultDesktopSettings,
  describeDesktopProviderCredentialRequirement,
  hasConfiguredDesktopProviderCredential,
  readDesktopSettings,
  normalizeDesktopSettings,
  writeDesktopSettings,
} from "../src/settingsStore.js";

test("legacy desktop settings seed the Default model configuration from Local Core policy", () => {
  const settings = normalizeDesktopSettings({ selectedProvider: "openrouter" }, {
    fallbackModelPolicy: {
      version: 1,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      modelByStage: {},
      modelCapabilities: { visionInputEnabled: true },
    },
  });

  assert.equal(settings.modelConfigurations[0]?.name, "Default");
  assert.equal(settings.modelConfigurations[0]?.revisions[0]?.policy.provider, "anthropic");
  assert.equal(settings.modelConfigurations[0]?.revisions[0]?.policy.model, "claude-sonnet-4-5");
});

test("readDesktopSettings returns default settings when the file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-settings-"));
  const settings = await readDesktopSettings(path.join(tempDir, "desktop-settings.json"));

  assert.deepEqual(settings, createDefaultDesktopSettings());
  assert.equal(settings.providerSelectionCompletedAt, undefined);
});

test("readDesktopSettings normalizes legacy OpenRouter-only settings", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-settings-"));
  const settingsPath = path.join(tempDir, "desktop-settings.json");

  await writeFile(settingsPath, `${JSON.stringify({
    version: 1,
    openrouterApiKey: " legacy-key ",
  }, null, 2)}\n`, "utf8");

  const restored = await readDesktopSettings(settingsPath);

  assert.equal(restored.selectedProvider, "openrouter");
  assert.equal(restored.presetId, "desktop_dev_local");
  assert.equal(restored.capabilityPacks.includes("filesystem"), true);
  assert.deepEqual(restored.projects, []);
  assert.equal(restored.openrouterApiKey, "legacy-key");
  assert.equal(restored.advancedWorkspaceEnabled, true);
  assert.equal(typeof restored.providerSelectionCompletedAt, "string");
  assert.equal(typeof restored.setupCompletedAt, "string");
});

test("readDesktopSettings keeps provider selection unset for pristine legacy OpenRouter defaults", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-settings-"));
  const settingsPath = path.join(tempDir, "desktop-settings.json");

  await writeFile(settingsPath, `${JSON.stringify({
    version: 8,
    selectedProvider: "openrouter",
    databaseMode: "default",
    presetId: "desktop_dev_local",
    capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
    projects: [],
    advancedWorkspaceEnabled: false,
  }, null, 2)}\n`, "utf8");

  const restored = await readDesktopSettings(settingsPath);

  assert.equal(restored.providerSelectionCompletedAt, undefined);
  assert.equal(restored.selectedProvider, "openrouter");
});

test("readDesktopSettings backfills provider selection for intentional legacy provider states", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-settings-"));
  const settingsPath = path.join(tempDir, "desktop-settings.json");

  await writeFile(settingsPath, `${JSON.stringify({
    version: 8,
    selectedProvider: "ollama",
    databaseMode: "default",
    presetId: "desktop_dev_local",
    capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
    projects: [],
    ollamaBaseUrl: "http://127.0.0.1:11434",
    advancedWorkspaceEnabled: false,
  }, null, 2)}\n`, "utf8");

  const restored = await readDesktopSettings(settingsPath);

  assert.equal(typeof restored.providerSelectionCompletedAt, "string");
  assert.equal(restored.selectedProvider, "ollama");
  assert.equal(restored.ollamaBaseUrl, "http://127.0.0.1:11434");
});

test("writeDesktopSettings persists provider options without serializing credentials", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-settings-"));
  const settingsPath = path.join(tempDir, "desktop-settings.json");

  const saved = await writeDesktopSettings(settingsPath, {
    selectedProvider: "openai",
    databaseMode: "default",
    presetId: "desktop_dev_local",
    capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
    projects: [
      { path: " ../workspace-a ", label: " Workspace A " },
      { path: "../workspace-a", label: "duplicate" },
      { path: "/tmp/workspace-b", label: "" },
    ],
    openrouterApiKey: "  legacy-key  ",
    openrouterModel: "  openai/gpt-5.2  ",
    openrouterBaseUrl: "  https://openrouter.ai  ",
    openrouterSiteUrl: "  https://kestrel.example  ",
    openrouterAppName: "  kestrel-desktop  ",
    openaiApiKey: "  openai-key  ",
    openaiModel: "  gpt-5.4-2026-03-05  ",
    openaiBaseUrl: "  https://api.openai.com  ",
    openaiOrgId: "  org-123  ",
    openaiProjectId: "  project-openai  ",
    anthropicApiKey: "",
    anthropicModel: "  claude-3-5-haiku-latest  ",
    anthropicBaseUrl: "  https://api.anthropic.com  ",
    anthropicVersion: "  2023-06-01  ",
    tavilyApiKey: "  tavily-key  ",
    tavilyBaseUrl: "  https://api.tavily.com  ",
    tavilyProject: "  project-123  ",
    tavilyHttpProxy: "  http://proxy.internal:8080  ",
    tavilyHttpsProxy: "",
    providerSelectionCompletedAt: "2026-04-18T00:00:00.000Z",
    setupCompletedAt: "2026-04-19T00:00:00.000Z",
    advancedWorkspaceEnabled: false,
  });
  const restored = await readDesktopSettings(settingsPath);
  const raw = await readFile(settingsPath, "utf8");

  assert.equal(saved.selectedProvider, "openai");
  assert.equal(saved.databaseMode, "default");
  assert.equal(saved.presetId, "desktop_dev_local");
  assert.deepEqual(saved.capabilityPacks, ["balanced", "filesystem", "dev_shell", "sandbox_code", "desktop_host"]);
  assert.deepEqual(saved.projects, [
    { path: path.resolve("../workspace-a"), label: "Workspace A" },
    { path: "/tmp/workspace-b", label: "workspace-b" },
  ]);
  assert.equal(saved.openrouterApiKey, undefined);
  assert.equal(saved.openrouterModel, "openai/gpt-5.2");
  assert.equal(saved.openrouterBaseUrl, "https://openrouter.ai");
  assert.equal(saved.openrouterSiteUrl, "https://kestrel.example");
  assert.equal(saved.openrouterAppName, "kestrel-desktop");
  assert.equal(saved.openaiApiKey, undefined);
  assert.equal(saved.openaiModel, "gpt-5.4-2026-03-05");
  assert.equal(saved.openaiBaseUrl, "https://api.openai.com");
  assert.equal(saved.openaiOrgId, "org-123");
  assert.equal(saved.openaiProjectId, "project-openai");
  assert.equal(saved.anthropicApiKey, undefined);
  assert.equal(saved.anthropicModel, "claude-3-5-haiku-latest");
  assert.equal(saved.anthropicBaseUrl, "https://api.anthropic.com");
  assert.equal(saved.anthropicVersion, "2023-06-01");
  assert.equal(saved.tavilyApiKey, undefined);
  assert.equal(saved.tavilyBaseUrl, "https://api.tavily.com");
  assert.equal(saved.tavilyProject, "project-123");
  assert.equal(saved.tavilyHttpProxy, "http://proxy.internal:8080");
  assert.equal(saved.tavilyHttpsProxy, undefined);
  assert.equal(saved.providerSelectionCompletedAt, "2026-04-18T00:00:00.000Z");
  assert.equal(saved.advancedWorkspaceEnabled, false);
  assert.equal(restored.selectedProvider, "openai");
  assert.equal(restored.openaiApiKey, undefined);
  assert.equal(restored.openaiModel, "gpt-5.4-2026-03-05");
  assert.equal(restored.tavilyApiKey, undefined);
  assert.deepEqual(restored.projects, saved.projects);
  assert.match(raw, /"version": 10/u);
  assert.match(raw, /"selectedProvider": "openai"/u);
  assert.match(raw, /"databaseMode": "default"/u);
  assert.equal(raw.includes("openai-key"), false);
  assert.match(raw, /"openaiModel": "gpt-5\.4-2026-03-05"/u);
  assert.match(raw, /"anthropicVersion": "2023-06-01"/u);
  assert.equal(raw.includes("tavily-key"), false);
  assert.equal(raw.includes("legacy-key"), false);
  assert.match(raw, /"providerSelectionCompletedAt": "2026-04-18T00:00:00.000Z"/u);
  assert.match(raw, /"projects": \[/u);
});

test("writeDesktopSettings persists external database mode without serializing its credential", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-settings-"));
  const settingsPath = path.join(tempDir, "desktop-settings.json");

  const saved = await writeDesktopSettings(settingsPath, {
    selectedProvider: "openrouter",
    databaseMode: "external",
    presetId: "desktop_dev_local",
    capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
    projects: [],
    databaseUrl: "  postgres://user:password@db.example:5432/kestrel  ",
    openrouterApiKey: "router-key",
    providerSelectionCompletedAt: "2026-04-18T00:00:00.000Z",
    advancedWorkspaceEnabled: false,
  });
  const restored = await readDesktopSettings(settingsPath);
  const raw = await readFile(settingsPath, "utf8");

  assert.equal(saved.databaseMode, "external");
  assert.equal(saved.databaseUrl, undefined);
  assert.equal(restored.databaseMode, "external");
  assert.equal(restored.databaseUrl, undefined);
  assert.match(raw, /"version": 10/u);
  assert.match(raw, /"databaseMode": "external"/u);
  assert.equal(raw.includes("user:password"), false);
});

test("writeDesktopSettings round-trips local-provider settings", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-settings-"));
  const settingsPath = path.join(tempDir, "desktop-settings.json");

  const saved = await writeDesktopSettings(settingsPath, {
    selectedProvider: "lmstudio",
    databaseMode: "default",
    presetId: "desktop_dev_local",
    capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
    projects: [],
    lmstudioModel: "qwen2.5-coder",
    lmstudioBaseUrl: "http://127.0.0.1:1234",
    providerSelectionCompletedAt: "2026-04-18T00:00:00.000Z",
    advancedWorkspaceEnabled: false,
  });
  const restored = await readDesktopSettings(settingsPath);

  assert.equal(saved.selectedProvider, "lmstudio");
  assert.equal(saved.lmstudioModel, "qwen2.5-coder");
  assert.equal(saved.lmstudioBaseUrl, "http://127.0.0.1:1234");
  assert.equal(saved.providerSelectionCompletedAt, "2026-04-18T00:00:00.000Z");
  assert.equal(restored.selectedProvider, "lmstudio");
  assert.equal(restored.lmstudioModel, "qwen2.5-coder");
  assert.equal(restored.lmstudioBaseUrl, "http://127.0.0.1:1234");
});

test("buildDesktopModelEnvironment exposes only the selected provider key", () => {
  const openrouterEnv = buildDesktopModelEnvironment(
    {
      PATH: "/usr/bin",
      OPENROUTER_API_KEY: "stale-openrouter",
      OPENROUTER_MODEL: "stale-model",
      OPENROUTER_BASE_URL: "https://stale-openrouter",
      OPENROUTER_SITE_URL: "https://stale-site",
      OPENROUTER_APP_NAME: "stale-app",
      OPENAI_API_KEY: "stale-openai",
      OPENAI_MODEL: "stale-openai-model",
      OPENAI_BASE_URL: "https://stale-openai",
      OPENAI_ORG_ID: "stale-org",
      OPENAI_PROJECT_ID: "stale-project",
      ANTHROPIC_API_KEY: "stale-anthropic",
      ANTHROPIC_MODEL: "stale-anthropic-model",
      ANTHROPIC_BASE_URL: "https://stale-anthropic",
      ANTHROPIC_VERSION: "stale-version",
      TAVILY_API_KEY: "stale-tavily",
      TAVILY_BASE_URL: "https://stale-tavily",
      TAVILY_PROJECT: "stale-project",
      TAVILY_HTTP_PROXY: "http://stale-http",
      TAVILY_HTTPS_PROXY: "http://stale-https",
    },
    {
      selectedProvider: "openrouter",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      openrouterApiKey: "router-key",
      openrouterModel: "openai/gpt-5.2",
      openrouterBaseUrl: "https://openrouter.ai",
      openrouterSiteUrl: "https://kestrel.example",
      openrouterAppName: "kestrel-desktop",
      openaiApiKey: "openai-key",
      openaiModel: "gpt-5.4-2026-03-05",
      openaiBaseUrl: "https://api.openai.com",
      openaiOrgId: "org-123",
      openaiProjectId: "project-openai",
      anthropicApiKey: "anthropic-key",
      anthropicModel: "claude-3-5-haiku-latest",
      anthropicBaseUrl: "https://api.anthropic.com",
      anthropicVersion: "2023-06-01",
      tavilyApiKey: "tavily-key",
      tavilyBaseUrl: "https://api.tavily.com",
      tavilyProject: "project-123",
      tavilyHttpProxy: "http://proxy-http",
      tavilyHttpsProxy: "http://proxy-https",
      advancedWorkspaceEnabled: false,
    },
    {
      version: 1,
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    },
  );
  const openaiEnv = buildDesktopModelEnvironment(
    {
      PATH: "/usr/bin",
      OPENROUTER_API_KEY: "stale-openrouter",
      OPENAI_API_KEY: "stale-openai",
      OPENAI_MODEL: "stale-openai-model",
      OPENAI_BASE_URL: "https://stale-openai",
      OPENAI_ORG_ID: "stale-org",
      OPENAI_PROJECT_ID: "stale-project",
      ANTHROPIC_API_KEY: "stale-anthropic",
      ANTHROPIC_MODEL: "stale-anthropic-model",
      ANTHROPIC_BASE_URL: "https://stale-anthropic",
      ANTHROPIC_VERSION: "stale-version",
    },
    {
      selectedProvider: "openai",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      openrouterApiKey: "router-key",
      openrouterModel: "openai/gpt-5.2",
      openrouterBaseUrl: "https://openrouter.ai",
      openrouterSiteUrl: "https://kestrel.example",
      openrouterAppName: "kestrel-desktop",
      openaiApiKey: "openai-key",
      openaiModel: "gpt-5.4-2026-03-05",
      openaiBaseUrl: "https://api.openai.com",
      openaiOrgId: "org-123",
      openaiProjectId: "project-openai",
      anthropicApiKey: "anthropic-key",
      anthropicModel: "claude-3-5-haiku-latest",
      anthropicBaseUrl: "https://api.anthropic.com",
      anthropicVersion: "2023-06-01",
      tavilyApiKey: "tavily-key",
      tavilyBaseUrl: "https://api.tavily.com",
      tavilyProject: "project-123",
      tavilyHttpProxy: "http://proxy-http",
      tavilyHttpsProxy: "http://proxy-https",
      advancedWorkspaceEnabled: false,
    },
    {
      version: 1,
      provider: "openai",
      model: "gpt-5.4-2026-03-05",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    },
  );
  const anthropicEnv = buildDesktopModelEnvironment(
    {
      PATH: "/usr/bin",
      OPENROUTER_API_KEY: "stale-openrouter",
      OPENAI_API_KEY: "stale-openai",
      OPENAI_MODEL: "stale-openai-model",
      OPENAI_BASE_URL: "https://stale-openai",
      OPENAI_ORG_ID: "stale-org",
      OPENAI_PROJECT_ID: "stale-project",
      ANTHROPIC_API_KEY: "stale-anthropic",
      ANTHROPIC_MODEL: "stale-anthropic-model",
      ANTHROPIC_BASE_URL: "https://stale-anthropic",
      ANTHROPIC_VERSION: "stale-version",
    },
    {
      selectedProvider: "anthropic",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      openrouterApiKey: "router-key",
      openrouterModel: "openai/gpt-5.2",
      openrouterBaseUrl: "https://openrouter.ai",
      openrouterSiteUrl: "https://kestrel.example",
      openrouterAppName: "kestrel-desktop",
      openaiApiKey: "openai-key",
      openaiModel: "gpt-5.4-2026-03-05",
      openaiBaseUrl: "https://api.openai.com",
      openaiOrgId: "org-123",
      openaiProjectId: "project-openai",
      anthropicApiKey: "anthropic-key",
      anthropicModel: "claude-3-5-haiku-latest",
      anthropicBaseUrl: "https://api.anthropic.com",
      anthropicVersion: "2023-06-01",
      tavilyApiKey: "tavily-key",
      tavilyBaseUrl: "https://api.tavily.com",
      tavilyProject: "project-123",
      tavilyHttpProxy: "http://proxy-http",
      tavilyHttpsProxy: "http://proxy-https",
      advancedWorkspaceEnabled: false,
    },
    {
      version: 1,
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    },
  );

  assert.equal(openrouterEnv.OPENROUTER_API_KEY, "router-key");
  assert.equal(openrouterEnv.OPENROUTER_MODEL, "z-ai/glm-5.2");
  assert.equal(openrouterEnv.OPENROUTER_BASE_URL, "https://openrouter.ai");
  assert.equal(openrouterEnv.OPENROUTER_SITE_URL, "https://kestrel.example");
  assert.equal(openrouterEnv.OPENROUTER_APP_NAME, "kestrel-desktop");
  assert.equal(openrouterEnv.OPENAI_API_KEY, undefined);
  assert.equal(openrouterEnv.OPENAI_MODEL, undefined);
  assert.equal(openrouterEnv.OPENAI_BASE_URL, undefined);
  assert.equal(openrouterEnv.OPENAI_ORG_ID, undefined);
  assert.equal(openrouterEnv.OPENAI_PROJECT_ID, undefined);
  assert.equal(openrouterEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(openrouterEnv.ANTHROPIC_MODEL, undefined);
  assert.equal(openrouterEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(openrouterEnv.ANTHROPIC_VERSION, undefined);
  assert.equal(openrouterEnv.TAVILY_API_KEY, "tavily-key");
  assert.equal(openrouterEnv.TAVILY_BASE_URL, "https://api.tavily.com");
  assert.equal(openrouterEnv.TAVILY_PROJECT, "project-123");
  assert.equal(openrouterEnv.TAVILY_HTTP_PROXY, "http://proxy-http");
  assert.equal(openrouterEnv.TAVILY_HTTPS_PROXY, "http://proxy-https");

  assert.equal(openaiEnv.OPENROUTER_API_KEY, undefined);
  assert.equal(openaiEnv.OPENROUTER_MODEL, undefined);
  assert.equal(openaiEnv.OPENROUTER_BASE_URL, undefined);
  assert.equal(openaiEnv.OPENROUTER_SITE_URL, undefined);
  assert.equal(openaiEnv.OPENROUTER_APP_NAME, undefined);
  assert.equal(openaiEnv.OPENAI_API_KEY, "openai-key");
  assert.equal(openaiEnv.OPENAI_MODEL, "gpt-5.4-2026-03-05");
  assert.equal(openaiEnv.OPENAI_BASE_URL, "https://api.openai.com");
  assert.equal(openaiEnv.OPENAI_ORG_ID, "org-123");
  assert.equal(openaiEnv.OPENAI_PROJECT_ID, "project-openai");
  assert.equal(openaiEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(openaiEnv.ANTHROPIC_MODEL, undefined);
  assert.equal(openaiEnv.TAVILY_API_KEY, "tavily-key");

  assert.equal(anthropicEnv.OPENROUTER_API_KEY, undefined);
  assert.equal(anthropicEnv.OPENROUTER_MODEL, undefined);
  assert.equal(anthropicEnv.OPENAI_API_KEY, undefined);
  assert.equal(anthropicEnv.OPENAI_MODEL, undefined);
  assert.equal(anthropicEnv.ANTHROPIC_API_KEY, "anthropic-key");
  assert.equal(anthropicEnv.ANTHROPIC_MODEL, "claude-3-5-haiku-latest");
  assert.equal(anthropicEnv.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(anthropicEnv.ANTHROPIC_VERSION, "2023-06-01");
  assert.equal(anthropicEnv.TAVILY_API_KEY, "tavily-key");
});

test("buildDesktopModelEnvironment configures local OpenAI-compatible providers without API keys", () => {
  const env = buildDesktopModelEnvironment(
    {
      PATH: "/usr/bin",
      OPENROUTER_API_KEY: "stale-openrouter",
      OPENAI_API_KEY: "stale-openai",
      ANTHROPIC_API_KEY: "stale-anthropic",
      OLLAMA_MODEL: "stale-ollama",
      OLLAMA_BASE_URL: "http://stale-ollama",
      LMSTUDIO_MODEL: "stale-lmstudio",
      LMSTUDIO_BASE_URL: "http://stale-lmstudio",
    },
    {
      selectedProvider: "lmstudio",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmstudioBaseUrl: "http://127.0.0.1:1234",
      advancedWorkspaceEnabled: false,
    },
    {
      version: 1,
      provider: "lmstudio",
      model: "local-model",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    },
  );

  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OLLAMA_MODEL, undefined);
  assert.equal(env.LMSTUDIO_MODEL, "local-model");
  assert.equal(env.LMSTUDIO_BASE_URL, "http://127.0.0.1:1234");
});

test("buildDesktopRunnerEnvironment applies local runtime defaults for desktop runs", () => {
  const env = buildDesktopRunnerEnvironment(
    {
      PATH: "/usr/bin",
      KESTREL_DB_PORT: "55499",
      DATABASE_URL: "",
    },
    {
      selectedProvider: "openrouter",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      openrouterApiKey: "router-key",
      tavilyApiKey: "tavily-key",
      advancedWorkspaceEnabled: false,
    },
    {
      version: 1,
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    },
    "/tmp/kestrel-desktop-runtime-home",
  );

  assert.equal(env.KESTREL_HOME, "/tmp/kestrel-desktop-runtime-home");
  assert.equal(env.KESTREL_MODEL_PROMPT_DUMP, "1");
  assert.equal(env.KESTREL_ENABLE_MANAGED_WORKTREES, "1");
  assert.equal(env.OPENROUTER_API_KEY, "router-key");
  assert.equal(env.TAVILY_API_KEY, "tavily-key");
  assert.equal(env.DATABASE_URL, "postgres://kestrel:kestrel@localhost:55499/kestrel");
  assert.equal(env.KESTREL_DATABASE_URL_SOURCE, "desktop_default");
});

test("buildDesktopRunnerEnvironment preserves explicit database wiring for managed desktop postgres", () => {
  const env = buildDesktopRunnerEnvironment(
    {
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://stale/stale",
    },
    {
      selectedProvider: "openrouter",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      openrouterApiKey: "router-key",
      advancedWorkspaceEnabled: false,
    },
    {
      version: 1,
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    },
    "/tmp/kestrel-desktop-runtime-home",
    {
      databaseUrl: "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel",
      databaseUrlSource: "desktop_managed",
    },
  );

  assert.equal(env.DATABASE_URL, "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel");
  assert.equal(env.KESTREL_DATABASE_URL_SOURCE, "desktop_managed");
});

test("buildDesktopRunnerEnvironment does not fallback to local defaults when external database mode is selected without DATABASE_URL", () => {
  const env = buildDesktopRunnerEnvironment(
    {
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://stale/stale",
    },
    {
      selectedProvider: "openrouter",
      databaseMode: "external",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      openrouterApiKey: "router-key",
      advancedWorkspaceEnabled: false,
    },
    {
      version: 1,
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    },
    "/tmp/kestrel-desktop-runtime-home",
  );

  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.KESTREL_DATABASE_URL_SOURCE, "desktop_external");
});

test("buildDesktopModelEnvironment uses the shared model policy instead of DesktopSettings model authority", () => {
  const env = buildDesktopModelEnvironment(
    {
      PATH: "/usr/bin",
      OPENROUTER_API_KEY: "stale-openrouter",
      OPENAI_API_KEY: "stale-openai",
    },
    {
      selectedProvider: "openrouter",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      openrouterApiKey: "router-key",
      openrouterModel: "z-ai/glm-5.2",
      openaiApiKey: "openai-key",
      openaiModel: "legacy-openai-model",
      advancedWorkspaceEnabled: false,
    },
    {
      version: 1,
      provider: "openai",
      model: "gpt-5.4-2026-03-05",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    },
  );

  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.OPENROUTER_MODEL, undefined);
  assert.equal(env.OPENAI_API_KEY, "openai-key");
  assert.equal(env.OPENAI_MODEL, "gpt-5.4-2026-03-05");
});

test("buildDesktopRunnerProfile applies the selected model policy to run.start", () => {
  const profile = buildDesktopRunnerProfile({
    version: 1,
    provider: "ollama",
    model: "qwen3:8b",
    modelByStage: { "agent.loop": "qwen3:14b" },
    modelCapabilities: {
      visionInputEnabled: false,
    },
  });

  assert.equal(profile.modelProvider, "ollama");
  assert.equal(profile.model, "qwen3:8b");
  assert.equal(
    profile.agentStageConfig?.modelByStage?.["agent.loop"],
    "qwen3:14b",
  );
});

test("buildDesktopRunnerProfile applies verified managed MCP servers and tools", () => {
  const settings = {
    ...createDefaultDesktopSettings(),
    mcpServers: [{
      id: "docs", name: "Docs", transport: "http" as const,
      url: "https://mcp.example.test/", enabled: true,
      source: "Kestrel Desktop", sourceKind: "desktop-managed" as const,
      tools: [{ name: "search" }], toolCount: 1,
    }],
  };
  const profile = buildDesktopRunnerProfile(createDefaultModelPolicy(), settings);
  assert.equal(profile.mcpServers?.[0]?.id, "docs");
  assert.equal(profile.mcpServers?.[0]?.transport, "http");
  assert.equal(profile.mcpServers?.[0]?.toolMetadata?.search?.approvalMode, "ask");
  assert.deepEqual(profile.mcpServers?.[0]?.toolMetadata?.search?.allowedInteractionModes, ["build"]);
  assert.equal(profile.toolAllowlist?.includes("mcp.docs.search"), true);
});

test("hasConfiguredDesktopProviderCredential follows the selected provider", () => {
  assert.equal(
    hasConfiguredDesktopProviderCredential({
      selectedProvider: "openrouter",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      openrouterApiKey: "router-key",
      advancedWorkspaceEnabled: false,
    }),
    true,
  );
  assert.equal(
    hasConfiguredDesktopProviderCredential({
      selectedProvider: "openai",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      openrouterApiKey: "router-key",
      openaiApiKey: "",
      advancedWorkspaceEnabled: false,
    }),
    false,
  );
  assert.equal(
    hasConfiguredDesktopProviderCredential({
      selectedProvider: "anthropic",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      anthropicApiKey: "anthropic-key",
      advancedWorkspaceEnabled: false,
    }),
    true,
  );
  assert.equal(
    hasConfiguredDesktopProviderCredential({
      selectedProvider: "ollama",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      advancedWorkspaceEnabled: false,
    }),
    true,
  );
});

test("describeDesktopProviderCredentialRequirement explains the missing selected provider key", () => {
  assert.equal(
    describeDesktopProviderCredentialRequirement({
      selectedProvider: "openrouter",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      advancedWorkspaceEnabled: false,
    }),
    "Choose a model provider to finish Desktop setup before starting a run.",
  );
  assert.equal(
    describeDesktopProviderCredentialRequirement({
      selectedProvider: "openrouter",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      providerSelectionCompletedAt: "2026-04-18T00:00:00.000Z",
      advancedWorkspaceEnabled: false,
    }),
    "OpenRouter is selected, but OPENROUTER_API_KEY is not configured yet. Open settings or finish setup before starting a run.",
  );
  assert.equal(
    describeDesktopProviderCredentialRequirement({
      selectedProvider: "openai",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      providerSelectionCompletedAt: "2026-04-18T00:00:00.000Z",
      openaiApiKey: "openai-key",
      advancedWorkspaceEnabled: false,
    }),
    undefined,
  );
  assert.equal(
    describeDesktopProviderCredentialRequirement({
      selectedProvider: "lmstudio",
      databaseMode: "default",
      presetId: "desktop_dev_local",
      capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
      projects: [],
      providerSelectionCompletedAt: "2026-04-18T00:00:00.000Z",
      advancedWorkspaceEnabled: false,
    }),
    undefined,
  );
});
