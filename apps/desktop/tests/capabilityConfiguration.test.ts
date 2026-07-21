import assert from "node:assert/strict";

import { createDefaultModelPolicy } from "../../../src/profile/modelPolicy.js";
import { parseDesktopCapabilityConfigurationInput } from "../../../src/desktopShell/contracts.js";
import { buildDesktopCapabilityConfigurationPlan } from "../src/capabilityConfiguration.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "capability configuration builds one verified hosted-model replacement", () => {
  const plan = buildDesktopCapabilityConfigurationPlan({
    currentSettings: createDefaultDesktopSettings(),
    currentModelPolicy: createDefaultModelPolicy(),
    configuration: {
      capabilityId: "model.openai",
      enabled: true,
      credential: "new-secret",
      settings: {
        model: "gpt-5",
        baseUrl: "https://api.example.test/v1",
        organizationId: "org-example",
        projectId: "project-example",
      },
    },
  });

  assert.equal(plan.settings.selectedProvider, "openai");
  assert.equal(plan.settings.openaiModel, "gpt-5");
  assert.equal(plan.settings.openaiBaseUrl, "https://api.example.test/v1");
  assert.equal(plan.modelPolicy.provider, "openai");
  assert.equal(plan.modelPolicy.model, "gpt-5");
  assert.deepEqual(plan.credential, { id: "provider.openai.default", value: "new-secret" });
  assert.equal(plan.requiresVerification, true);
  assert.equal(plan.restartRuntime, true);
});

contractTest("desktop.hermetic", "hosted capability changes require credential re-entry for atomic verification", () => {
  assert.throws(
    () => buildDesktopCapabilityConfigurationPlan({
      currentSettings: createDefaultDesktopSettings(),
      currentModelPolicy: createDefaultModelPolicy(),
      configuration: { capabilityId: "model.openrouter", settings: { model: "replacement/model" } },
    }),
    /Re-enter the credential/u,
  );
});

contractTest("desktop.hermetic", "credential removal does not verify or disturb unrelated settings", () => {
  const settings = { ...createDefaultDesktopSettings(), tavilyBaseUrl: "https://example.test" };
  const plan = buildDesktopCapabilityConfigurationPlan({
    currentSettings: settings,
    currentModelPolicy: createDefaultModelPolicy(),
    configuration: { capabilityId: "tools.internet.tavily", credential: null },
  });

  assert.deepEqual(plan.credential, { id: "tool.tavily.default", value: null });
  assert.equal(plan.requiresVerification, false);
  assert.equal(plan.settings.tavilyBaseUrl, "https://example.test");
});

contractTest("desktop.hermetic", "capability packs are toggled through registry metadata", () => {
  const plan = buildDesktopCapabilityConfigurationPlan({
    currentSettings: createDefaultDesktopSettings(),
    currentModelPolicy: createDefaultModelPolicy(),
    configuration: { capabilityId: "local.sandbox_code", enabled: false },
  });
  assert.equal(plan.settings.capabilityPacks.includes("sandbox_code"), false);
});

contractTest("desktop.hermetic", "external database mode requires a verified write-only connection URL", () => {
  assert.throws(
    () => buildDesktopCapabilityConfigurationPlan({
      currentSettings: createDefaultDesktopSettings(),
      currentModelPolicy: createDefaultModelPolicy(),
      configuration: { capabilityId: "data.database", settings: { mode: "external" } },
    }),
    /Re-enter the credential/u,
  );
  const plan = buildDesktopCapabilityConfigurationPlan({
    currentSettings: createDefaultDesktopSettings(),
    currentModelPolicy: createDefaultModelPolicy(),
    configuration: { capabilityId: "data.database", settings: { mode: "external" }, credential: "postgresql://user:pass@db.example.test/kestrel" },
  });
  assert.equal(plan.settings.databaseMode, "external");
  assert.equal(plan.credential?.id, "data.database.external");
  assert.equal(plan.requiresVerification, true);
});

contractTest("desktop.hermetic", "configuration rejects unsupported fields and disabling the active model", () => {
  assert.throws(
    () => buildDesktopCapabilityConfigurationPlan({
      currentSettings: createDefaultDesktopSettings(),
      currentModelPolicy: createDefaultModelPolicy(),
      configuration: { capabilityId: "model.openrouter", settings: { invented: "value" }, credential: "secret" },
    }),
    /does not support setting 'invented'/u,
  );
  assert.throws(
    () => buildDesktopCapabilityConfigurationPlan({
      currentSettings: createDefaultDesktopSettings(),
      currentModelPolicy: createDefaultModelPolicy(),
      configuration: { capabilityId: "model.openrouter", enabled: false },
    }),
    /active model provider cannot be disabled/u,
  );
});

contractTest("desktop.hermetic", "capability configuration parser is strict at the IPC boundary", () => {
  assert.deepEqual(
    parseDesktopCapabilityConfigurationInput({
      capabilityId: "local.filesystem",
      enabled: false,
      settings: {},
    }),
    { capabilityId: "local.filesystem", enabled: false, settings: {} },
  );
  assert.throws(
    () => parseDesktopCapabilityConfigurationInput({ capabilityId: "model.openai", secret: "leak" }),
    /unsupported field 'secret'/u,
  );
  assert.throws(
    () => parseDesktopCapabilityConfigurationInput({ capabilityId: "unknown" }),
    /ID is not supported/u,
  );
});
