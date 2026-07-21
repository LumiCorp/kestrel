import assert from "node:assert/strict";

import { InMemoryStepRegistry } from "../../src/steps/StepRegistry.js";
import type { StepAgent } from "../../src/kestrel/contracts/execution.js";

import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "step registry allows replacing an existing step registration", async () => {
  const registry = new InMemoryStepRegistry();
  const first: StepAgent = async () => ({ status: "FAILED" });
  const second: StepAgent = async () => ({ status: "COMPLETED" });

  registry.register("react.deliberate", first);
  registry.register("react.deliberate", second);

  const resolved = registry.resolve("react.deliberate");
  const transition = await resolved({} as never, {} as never);

  assert.equal(transition.status, "COMPLETED");
});

contractTest("runtime.hermetic", "step registry rejects empty step names with a normalized failure", () => {
  const registry = new InMemoryStepRegistry();

  assert.throws(
    () => registry.register("   ", async () => ({ status: "COMPLETED" })),
    (error: unknown) =>
      error instanceof RuntimeFailure &&
      error.code === "STEP_NAME_INVALID" &&
      error.message === "Step name cannot be empty",
  );
});

contractTest("runtime.hermetic", "step registry rejects missing step lookups with a normalized failure", () => {
  const registry = new InMemoryStepRegistry();

  assert.throws(
    () => registry.resolve("react.missing"),
    (error: unknown) =>
      error instanceof RuntimeFailure &&
      error.code === "STEP_NOT_REGISTERED" &&
      error.message === "Step not registered: react.missing",
  );
});
