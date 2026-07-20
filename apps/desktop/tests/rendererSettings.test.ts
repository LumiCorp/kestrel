import assert from "node:assert/strict";
import test from "node:test";

import { toDesktopRendererSettings } from "../src/rendererSettings.js";
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

  assert.equal(projected.providerCredentialConfigured, true);
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
    "providerCredentialConfigured",
    "providerReadiness",
    "selectedProvider",
  ]);
  assert.equal(JSON.stringify(projected).includes("secret"), false);

  projected.projects[0]!.label = "changed";
  assert.equal(settings.projects[0]?.label, "kestrel");
});
