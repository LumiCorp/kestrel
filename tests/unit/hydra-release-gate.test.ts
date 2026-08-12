import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHydraRuntimeReleased,
  isHydraRuntimesEnabled,
} from "../../src/runtimes/HydraReleaseGate.js";

test("Hydra gate keeps Kestrel available while the gate is off", () => {
  assert.equal(isHydraRuntimesEnabled({}), false);
  assert.doesNotThrow(() => assertHydraRuntimeReleased("kestrel", {}));
});

test("Hydra gate releases Codex and Claude Code together", () => {
  const enabled = { KESTREL_HYDRA_RUNTIMES_ENABLED: "1" };
  assert.doesNotThrow(() => assertHydraRuntimeReleased("codex", enabled));
  assert.doesNotThrow(() => assertHydraRuntimeReleased("claude", enabled));
});

test("Hydra gate rejects either foreign Runtime while the gate is off", () => {
  for (const runtimeId of ["codex", "claude"] as const) {
    assert.throws(
      () => assertHydraRuntimeReleased(runtimeId, {}),
      /The selected Runtime is not enabled for this release/u,
    );
  }
});
