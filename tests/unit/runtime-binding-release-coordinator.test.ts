import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeBindingReleaseCoordinator } from "../../src/runtimes/RuntimeBindingReleaseCoordinator.js";
import {
  InMemoryRuntimeBindingCorrelationStore,
  InMemoryRuntimeNativeSessionStore,
  type RuntimeBindingV1,
} from "../../src/runtimes/contracts.js";

const binding: RuntimeBindingV1 = {
  version: "runtime_binding_v1",
  bindingId: "binding-release",
  threadId: "thread-release",
  participantId: "runtime:codex",
  runtimeId: "codex",
  environmentId: "environment-release",
  adapterContractVersion: 1,
  capabilityDigest: "digest",
  status: "ready",
  nativeSessionState: "ready",
};

function payload(overrides: Partial<typeof binding> = {}) {
  const value = { ...binding, ...overrides };
  return {
    runtimeId: value.runtimeId,
    bindingId: value.bindingId,
    participantId: value.participantId,
    threadId: value.threadId,
    environmentId: value.environmentId,
  };
}

test("Runtime release routes to the exact active binding then leaves a correlation-only tombstone", async () => {
  const sessions = new InMemoryRuntimeNativeSessionStore();
  await sessions.save({
    version: "runtime_native_session_v1",
    bindingId: binding.bindingId,
    runtimeId: "codex",
    threadId: binding.threadId,
    participantId: binding.participantId,
    environmentId: binding.environmentId,
    nativeSessionId: "native-private",
    nativeVersion: "0.147.0",
    status: "ready",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  let activeReleases = 0;
  const checkpoints: string[] = [];
  const coordinator = new RuntimeBindingReleaseCoordinator(
    sessions,
    undefined,
    {
      async capture() {},
      async materialize() { return "missing"; },
      async release(bindingId) { checkpoints.push(bindingId); },
    },
  );
  await coordinator.register(binding, async () => { activeReleases += 1; });

  await coordinator.release(payload());
  assert.equal(activeReleases, 1);
  assert.deepEqual(checkpoints, [binding.bindingId]);
  const released = await sessions.load(binding.bindingId);
  assert.equal(released?.status, "released");
  assert.equal("nativeSessionId" in (released ?? {}), false);
  assert.equal(released?.threadId, binding.threadId);
});

test("Runtime release tombstones an exactly registered binding before native session establishment", async () => {
  const sessions = new InMemoryRuntimeNativeSessionStore();
  const correlations = new InMemoryRuntimeBindingCorrelationStore();
  const coordinator = new RuntimeBindingReleaseCoordinator(
    sessions,
    undefined,
    undefined,
    correlations,
  );
  await coordinator.record({
    ...binding,
    nativeSessionState: "uninitialized",
  });

  await coordinator.release(payload());
  assert.equal(
    (await correlations.load(binding.bindingId))?.status,
    "released",
  );
  assert.equal(await sessions.load(binding.bindingId), undefined);
  await coordinator.release(payload());
  await assert.rejects(
    () => coordinator.release(payload({ threadId: "foreign-thread" })),
    /correlation/u,
  );
});

test("inactive Runtime release fails closed on foreign or legacy correlation", async () => {
  const sessions = new InMemoryRuntimeNativeSessionStore();
  await sessions.save({
    version: "runtime_native_session_v1",
    bindingId: binding.bindingId,
    runtimeId: "codex",
    nativeSessionId: "legacy-native",
    nativeVersion: "0.147.0",
    status: "ready",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  const coordinator = new RuntimeBindingReleaseCoordinator(sessions);
  await assert.rejects(() => coordinator.release(payload()), /Legacy native state/u);

  const correlated = new InMemoryRuntimeNativeSessionStore();
  await correlated.save({
    version: "runtime_native_session_v1",
    bindingId: binding.bindingId,
    runtimeId: "codex",
    threadId: binding.threadId,
    participantId: binding.participantId,
    environmentId: binding.environmentId,
    nativeSessionId: "native-private",
    nativeVersion: "0.147.0",
    status: "ready",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  const exact = new RuntimeBindingReleaseCoordinator(correlated);
  await assert.rejects(
    () => exact.release(payload({ threadId: "foreign-thread" })),
    /persisted binding correlation/u,
  );
});
