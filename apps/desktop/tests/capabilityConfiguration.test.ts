import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultModelPolicy } from "../../../src/profile/modelPolicy.js";
import { parseDesktopCapabilityConfigurationInput } from "../../../src/desktopShell/contracts.js";
import { createDesktopModelConfiguration } from "../../../src/desktopShell/configuration.js";
import {
  buildDesktopCapabilityConfigurationPlan,
  promoteDesktopDefaultModelConfiguration,
} from "../src/capabilityConfiguration.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";


test("capability configuration builds one verified hosted-model replacement", () => {
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

test("onboarding promotes the verified model as the immutable Desktop default", () => {
  const settings = createDefaultDesktopSettings();
  const existingConfiguration = createDesktopModelConfiguration(
    {
      ...createDefaultModelPolicy(),
      model: "existing/model",
    },
    { id: "existing-configuration", name: "Existing" },
  );
  settings.modelConfigurations.push(existingConfiguration);
  const previousDefault = structuredClone(settings.modelConfigurations[0]!);
  const verifiedPolicy = {
    ...createDefaultModelPolicy(),
    provider: "openai" as const,
    model: "gpt-5",
  };

  const promoted = promoteDesktopDefaultModelConfiguration(
    settings,
    verifiedPolicy,
    "2026-08-04T12:00:00.000Z",
  );
  const defaultConfiguration = promoted.modelConfigurations.find(
    (configuration) => configuration.id === promoted.defaultModelConfigurationId,
  )!;

  assert.equal(defaultConfiguration.id, settings.defaultModelConfigurationId);
  assert.equal(defaultConfiguration.currentRevision, 2);
  assert.deepEqual(defaultConfiguration.revisions[0], previousDefault.revisions[0]);
  assert.deepEqual(defaultConfiguration.revisions[1], {
    revision: 2,
    createdAt: "2026-08-04T12:00:00.000Z",
    policy: verifiedPolicy,
  });
  assert.deepEqual(promoted.modelConfigurations[1], existingConfiguration);

  const repeated = promoteDesktopDefaultModelConfiguration(
    promoted,
    verifiedPolicy,
    "2026-08-04T12:01:00.000Z",
  );
  assert.deepEqual(repeated.modelConfigurations, promoted.modelConfigurations);
});

test("hosted capability changes require credential re-entry for atomic verification", () => {
  assert.throws(
    () => buildDesktopCapabilityConfigurationPlan({
      currentSettings: createDefaultDesktopSettings(),
      currentModelPolicy: createDefaultModelPolicy(),
      configuration: { capabilityId: "model.openrouter", settings: { model: "replacement/model" } },
    }),
    /Re-enter the credential/u,
  );
});

test("local model configuration carries the verified endpoint through the shared apply plan", () => {
  const settings = createDefaultDesktopSettings();
  const plan = buildDesktopCapabilityConfigurationPlan({
    currentSettings: settings,
    currentModelPolicy: createDefaultModelPolicy(),
    configuration: parseDesktopCapabilityConfigurationInput({
      capabilityId: "model.ollama",
      enabled: true,
      settings: {
        model: "qwen3:8b",
        baseUrl: "http://127.0.0.1:2244",
      },
    }),
  });

  assert.equal(settings.ollamaBaseUrl, undefined);
  assert.equal(plan.settings.ollamaBaseUrl, "http://127.0.0.1:2244");
  assert.equal(plan.settings.ollamaModel, "qwen3:8b");
  assert.equal(plan.requiresVerification, true);
});

test("credential removal does not verify or disturb unrelated settings", () => {
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

test("capability packs are toggled through registry metadata", () => {
  const plan = buildDesktopCapabilityConfigurationPlan({
    currentSettings: createDefaultDesktopSettings(),
    currentModelPolicy: createDefaultModelPolicy(),
    configuration: { capabilityId: "local.sandbox_code", enabled: false },
  });
  assert.equal(plan.settings.capabilityPacks.includes("sandbox_code"), false);
});

test("external database mode requires a verified write-only connection URL", () => {
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

test("configuration rejects unsupported fields and disabling the active model", () => {
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

test("capability configuration parser is strict at the IPC boundary", () => {
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
