import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultLocalCoreRuntimeConfiguration } from "../../../../src/localCore/runtimeConfiguration";
import { createLocalCoreModelReadiness } from "../../../../src/localCore/modelReadiness";
import {
  isDesktopModelRoleReady,
  readDesktopModelIdentity,
} from "./desktop-model-readiness";

test("legacy Desktop health cannot admit an agent role", () => {
  assert.equal(
    isDesktopModelRoleReady({
      model: { provider: "ollama", model: "glm-4.5-air", health: "ready" },
      provider: "ollama",
      modelId: "glm-4.5-air",
      role: "agent.loop",
    }),
    false,
  );
});

test("an exact but pending Local Core registration remains visible and unavailable", () => {
  const model = createLocalCoreModelReadiness({
    runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
    profile: { modelProvider: "lmstudio", model: "glm-4.5-air" },
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });
  assert.deepEqual(readDesktopModelIdentity(model), {
    provider: "lmstudio",
    model: "glm-4.5-air",
  });
  assert.equal(
    isDesktopModelRoleReady({
      model,
      provider: "lmstudio",
      modelId: "glm-4.5-air",
      role: "agent.loop",
    }),
    false,
  );
});
