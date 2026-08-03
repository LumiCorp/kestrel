import test from "node:test";
import assert from "node:assert/strict";

import {
  getEffectiveDesktopEnabledAppIds,
  toDesktopRendererSettings,
} from "../src/rendererSettings.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";


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
    "defaultEnabledAppIds",
    "defaultModelConfigurationId",
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

test("Desktop projects standard capabilities under their canonical App", () => {
  const settings = {
    ...createDefaultDesktopSettings(),
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
  };

  const projected = toDesktopRendererSettings(settings);
  const linear = projected.apps.find((app) => app.id === "linear");

  assert.deepEqual(linear, {
    id: "linear",
    contractVersion: 1,
    label: "Linear",
    description: "Plan, track, and update product and engineering work.",
    toolNames: ["mcp.linear-local.create_issue"],
  });
  assert.ok(projected.defaultEnabledAppIds.includes("linear"));
  assert.deepEqual(getEffectiveDesktopEnabledAppIds(settings), projected.defaultEnabledAppIds);
});
