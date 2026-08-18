import test from "node:test";
import assert from "node:assert/strict";

import {
  getEffectiveDesktopEnabledAppIds,
  toDesktopRendererSettings,
} from "../src/rendererSettings.js";
import {
  createDefaultDesktopSettings,
  normalizeDesktopSettings,
} from "../src/settingsStore.js";


test("Desktop renderer settings never project persisted credentials", () => {
  const settings = {
    ...createDefaultDesktopSettings(),
    openrouterApiKey: "openrouter-secret",
    openaiApiKey: "openai-secret",
    anthropicApiKey: "anthropic-secret",
    tavilyApiKey: "tavily-secret",
    databaseUrl: "postgres://user:secret@localhost/kestrel",
    tavilyHttpProxy: "http://user:secret@proxy.example",
    projects: [{ path: "/workspace/kestrel", label: "kestrel" }],
  };

  const projected = toDesktopRendererSettings(settings);

  assert.deepEqual(Object.keys(projected).sort(), [
    "advancedWorkspaceEnabled",
    "appearanceTheme",
    "apps",
    "capabilityPacks",
    "databaseMode",
    "defaultEnabledBuiltInAppIds",
    "defaultModelConfigurationId",
    "enabledConnectedAppIds",
    "modelConfigurations",
    "presetId",
    "projects",
    "providerReadiness",
    "selectedProvider",
  ]);
  assert.equal(JSON.stringify(projected).includes("secret"), false);

  projected.projects[0]!.label = "changed";
  assert.equal(settings.projects[0]?.label, "kestrel");
});

test("Desktop renderer settings project the completed onboarding project as the default", () => {
  const settings = {
    ...createDefaultDesktopSettings(),
    projects: [
      { path: "/workspace/first", label: "first" },
      { path: "/workspace/selected", label: "selected" },
    ],
    desktopOnboarding: {
      version: 1 as const,
      status: "complete" as const,
      startedAt: "2026-08-04T12:00:00.000Z",
      completedAt: "2026-08-04T12:02:00.000Z",
      projectPath: "/workspace/selected",
    },
  };

  assert.equal(
    toDesktopRendererSettings(settings).defaultProjectPath,
    "/workspace/selected",
  );
});

test("Desktop does not promote an unregistered MCP server into a standard App", () => {
  const { plugins: _plugins, ...legacySettings } = createDefaultDesktopSettings();
  const settings = normalizeDesktopSettings({
    ...legacySettings,
    mcpServers: [
      {
        id: "linear-local",
        appId: "linear",
        name: "Linear",
        transport: "http" as const,
        url: "https://linear.example.test",
        enabled: true,
        source: "desktop",
        sourceKind: "desktop-managed" as const,
        tools: [{ name: "create_issue", description: "Create an issue." }],
      },
    ],
  });

  const projected = toDesktopRendererSettings(settings);
  assert.equal(projected.apps.find((app) => app.id === "linear"), undefined);
  assert.equal(projected.enabledConnectedAppIds.includes("linear"), false);
  assert.deepEqual(getEffectiveDesktopEnabledAppIds(settings).filter((id) => !projected.defaultEnabledBuiltInAppIds.includes(id)), projected.enabledConnectedAppIds);
});
