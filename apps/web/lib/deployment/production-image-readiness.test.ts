import assert from "node:assert/strict";
import test from "node:test";
import { isTagCapableEnvironmentLifecycleWorker } from "./production-image-readiness";

test("runtime publication requires every lifecycle worker Machine to use the tag contract", async () => {
  assert.equal(
    await isTagCapableEnvironmentLifecycleWorker(
      fakeFly([
        machine("started", "registry.fly.io/kestrel-one-control-worker:production-42-1"),
        machine("stopped", "registry.fly.io/kestrel-one-control-worker:production-42-1"),
      ]),
    ),
    true,
  );
  assert.equal(
    await isTagCapableEnvironmentLifecycleWorker(
      fakeFly([
        machine("started", "registry.fly.io/kestrel-one-control-worker:production-42-1"),
        machine("stopped", "registry.fly.io/kestrel-one-control-worker@sha256:" + "a".repeat(64)),
      ]),
    ),
    false,
  );
  assert.equal(
    await isTagCapableEnvironmentLifecycleWorker(
      fakeFly([
        machine("starting", "registry.fly.io/kestrel-one-control-worker:production-42-1"),
      ]),
    ),
    false,
  );
});

function machine(state: string, image: string) {
  return { id: crypto.randomUUID(), state, image, region: "iad" };
}

function fakeFly(machines: ReturnType<typeof machine>[]) {
  return {
    async listAppMachines() {
      return machines;
    },
  } as Parameters<typeof isTagCapableEnvironmentLifecycleWorker>[0];
}
