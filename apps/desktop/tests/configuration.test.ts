import assert from "node:assert/strict";
import test from "node:test";

import {
  appendDesktopModelConfigurationRevision,
  assertDesktopModelConfigurationHistoryPreserved,
  createDesktopModelConfiguration,
  getDesktopAppDefinition,
  parseDesktopExecutionSelection,
  parseDesktopModelConfigurations,
  resolveDesktopModelConfiguration,
} from "../../../src/desktopShell/configuration.js";

test("desktop model configurations retain immutable revisions", () => {
  const initial = createDesktopModelConfiguration({
    version: 1,
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    modelByStage: {},
    modelCapabilities: { visionInputEnabled: false },
  }, {
    id: "primary",
    name: "Primary",
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  const next = appendDesktopModelConfigurationRevision(initial, {
    ...initial.revisions[0]!.policy,
    provider: "openai",
    model: "gpt-5.4",
  }, "2026-07-20T01:00:00.000Z");

  assert.equal(initial.currentRevision, 1);
  assert.equal(next.currentRevision, 2);
  assert.equal(next.revisions[0]!.policy.provider, "openrouter");
  assert.equal(next.revisions[1]!.policy.provider, "openai");
  assert.equal(
    resolveDesktopModelConfiguration([next], { id: "primary", revision: 1 })?.revision.policy.provider,
    "openrouter",
  );
  assert.deepEqual(parseDesktopModelConfigurations([next]), [next]);
});

test("desktop execution selections reject duplicate apps and preserve explicit contracts", () => {
  assert.throws(() => parseDesktopExecutionSelection({
    modelConfiguration: { id: "primary", revision: 1 },
    apps: [{ id: "weather", contractVersion: 1 }, { id: "weather", contractVersion: 1 }],
  }), /duplicated/u);

  assert.deepEqual(parseDesktopExecutionSelection({
    modelConfiguration: { id: "primary", revision: 2 },
    apps: [{ id: "weather", contractVersion: 1 }],
  }), {
    modelConfiguration: { id: "primary", revision: 2 },
    apps: [{ id: "weather", contractVersion: 1 }],
  });
  assert.deepEqual(getDesktopAppDefinition("weather", 1)?.toolNames, [
    "free.weather.current",
    "free.weather.forecast",
  ]);
  assert.equal(getDesktopAppDefinition("weather", 2), undefined);
});

test("desktop model configuration updates preserve pinned revision history", () => {
  const initial = createDesktopModelConfiguration({
    version: 1,
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    modelByStage: {},
    modelCapabilities: { visionInputEnabled: false },
  }, { id: "primary", name: "Primary" });
  const appended = appendDesktopModelConfigurationRevision(initial, {
    ...initial.revisions[0]!.policy,
    model: "openai/gpt-5.4",
  });

  assert.doesNotThrow(() => assertDesktopModelConfigurationHistoryPreserved(
    [initial],
    [{ ...appended, name: "Primary model" }],
  ));
  assert.throws(() => assertDesktopModelConfigurationHistoryPreserved(
    [initial],
    [{
      ...initial,
      revisions: [{
        ...initial.revisions[0]!,
        policy: { ...initial.revisions[0]!.policy, model: "rewritten-model" },
      }],
    }],
  ), /revision 1 is immutable/u);
  assert.throws(
    () => assertDesktopModelConfigurationHistoryPreserved([initial], []),
    /cannot be removed/u,
  );
});
