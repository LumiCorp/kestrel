import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRuntimeReleased,
  isHydraRuntimesEnabled,
} from "@/lib/runtimes/release-gate";

test("Hydra release gate is off unless the server explicitly enables it", () => {
  assert.equal(isHydraRuntimesEnabled({}), false);
  assert.equal(
    isHydraRuntimesEnabled({ KESTREL_HYDRA_RUNTIMES_ENABLED: "0" }),
    false,
  );
  assert.equal(
    isHydraRuntimesEnabled({ KESTREL_HYDRA_RUNTIMES_ENABLED: "true" }),
    false,
  );
  assert.equal(
    isHydraRuntimesEnabled({ KESTREL_HYDRA_RUNTIMES_ENABLED: "1" }),
    true,
  );
});

test("Hydra release gate always admits Kestrel and admits foreign Runtimes only when enabled", () => {
  assert.doesNotThrow(() => assertRuntimeReleased("kestrel", {}));
  assert.doesNotThrow(() =>
    assertRuntimeReleased("codex", {
      KESTREL_HYDRA_RUNTIMES_ENABLED: "1",
    }),
  );
  assert.throws(
    () => assertRuntimeReleased("claude", {}),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUNTIME_RELEASE_DISABLED",
  );
});
