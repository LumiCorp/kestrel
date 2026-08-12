import test from "node:test";
import assert from "node:assert/strict";

import { createWebDemoProfile } from "../../src/web/index.js";
import { FILESYSTEM_TOOL_NAMES } from "../../tools/index.js";


test("web demo profile resolves to the balanced web preset by default", () => {
  const profile = createWebDemoProfile();

  assert.equal(profile.id, "kestrel-web");
  assert.equal(profile.agent, "kestrel");

  assert.equal(profile.shellKind, "web");
  assert.equal(profile.presetId, "web_balanced");
  assert.deepEqual(profile.capabilityPacks, ["balanced"]);
  assert.equal(profile.guardrails?.maxMaintenanceModelCallsPerRun, 8);
  for (const toolName of FILESYSTEM_TOOL_NAMES) {
    assert.equal(profile.toolAllowlist?.includes(toolName), false);
  }
  assert.equal(profile.toolAllowlist?.includes("code.execute"), false);
});

test("desktop demo profile resolves to the isolated desktop preset", () => {
  const profile = createWebDemoProfile("desktop");

  assert.equal(profile.shellKind, "desktop");
  assert.equal(profile.presetId, "desktop_safe_local");
  assert.equal(profile.capabilityPacks?.includes("filesystem"), true);
  assert.equal(profile.capabilityPacks?.includes("dev_shell"), false);
  assert.equal(profile.capabilityPacks?.includes("sandbox_code"), true);
  assert.equal(profile.toolAllowlist?.includes("code.execute"), true);
  assert.equal(profile.toolAllowlist?.includes("dev.shell.run"), false);
});
