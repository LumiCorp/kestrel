import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LocalCoreRuntimeBindingError,
  LocalCoreRuntimeBindingStore,
} from "../../src/localCore/runtimeBindings.js";
import {
  closeLocalCoreStore,
  ensureLocalCoreStore,
} from "../../src/localCore/store.js";

test("Local Core persists one immutable Runtime binding per canonical Desktop Thread", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-binding-"));
  try {
    const firstHandle = await ensureLocalCoreStore({ homePath: home });
    const bindings = new LocalCoreRuntimeBindingStore(firstHandle.executor);
    const environmentId = await bindings.environmentId();
    const admitted = await bindings.admit({
      canonicalThreadId: "thread-main:renderer-thread-1",
      runnerSessionId: "renderer-thread-1",
      runtimeId: "codex",
      capabilityDigest: "capabilities-1",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    assert.equal(admitted.environmentId, environmentId);
    assert.equal(admitted.status, "ready");
    assert.equal(admitted.nativeSessionState, "uninitialized");
    assert.equal(
      (await bindings.getForRunnerSession("renderer-thread-1"))?.bindingId,
      admitted.bindingId,
    );
    assert.equal(await bindings.getForRunnerSession("thread-main:renderer-thread-1"), undefined);
    assert.equal(
      await bindings.resolveRunStartEnvironment({
        runnerSessionId: admitted.runnerSessionId,
        runtimeId: admitted.runtimeId,
        runtimeBindingId: admitted.bindingId,
        participantId: admitted.participantId,
      }),
      admitted.environmentId,
    );
    await assert.rejects(
      bindings.resolveRunStartEnvironment({
        runnerSessionId: admitted.runnerSessionId,
        runtimeId: admitted.runtimeId,
        runtimeBindingId: admitted.bindingId,
        participantId: "foreign-participant",
      }),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_BINDING_CORRELATION_INVALID",
    );
    await assert.rejects(
      bindings.resolveRunStartEnvironment({
        runnerSessionId: "missing-foreign-session",
        runtimeId: "codex",
      }),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_BINDING_NOT_FOUND",
    );
    assert.equal(
      await bindings.resolveRunStartEnvironment({
        runnerSessionId: "legacy-kestrel-session",
        runtimeId: "kestrel",
      }),
      environmentId,
    );

    await assert.rejects(
      bindings.admit({
        canonicalThreadId: admitted.canonicalThreadId,
        runnerSessionId: admitted.runnerSessionId,
        runtimeId: "claude",
        capabilityDigest: admitted.capabilityDigest,
        modelProvider: "anthropic",
        modelId: "claude-sonnet",
      }),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_BINDING_IMMUTABLE",
    );

    const ready = await bindings.establish(correlation(admitted));
    assert.equal(ready.nativeSessionState, "ready");
    const degraded = await bindings.degrade({
      ...correlation(ready),
      lossCode: "RUNTIME_NATIVE_SESSION_LOST",
    });
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.latestLossCode, "RUNTIME_NATIVE_SESSION_LOST");
    await assert.rejects(
      bindings.resolveRunStartEnvironment({
        runnerSessionId: degraded.runnerSessionId,
        runtimeId: degraded.runtimeId,
        runtimeBindingId: degraded.bindingId,
        participantId: degraded.participantId,
      }),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_BINDING_DEGRADED",
    );
    await assert.rejects(
      bindings.admit({
        canonicalThreadId: degraded.canonicalThreadId,
        runnerSessionId: degraded.runnerSessionId,
        runtimeId: degraded.runtimeId,
        capabilityDigest: degraded.capabilityDigest,
        modelProvider: degraded.modelProvider,
        modelId: degraded.modelId,
      }),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_BINDING_DEGRADED",
    );

    const released = await bindings.release({
      ...correlation(degraded),
      acknowledgementEventId: "release-event-1",
    });
    assert.equal(released.status, "released");
    assert.equal(
      (await bindings.release({
        ...correlation(released),
        acknowledgementEventId: "release-event-1",
      })).status,
      "released",
    );
    await assert.rejects(
      bindings.release({
        ...correlation(released),
        acknowledgementEventId: "release-event-2",
      }),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_RELEASE_ACKNOWLEDGEMENT_CONFLICT",
    );

    await closeLocalCoreStore(home);
    const restoredHandle = await ensureLocalCoreStore({ homePath: home });
    const restored = new LocalCoreRuntimeBindingStore(restoredHandle.executor);
    assert.equal(await restored.environmentId(), environmentId);
    assert.equal((await restored.get(admitted.canonicalThreadId))?.status, "released");
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core recovery requires a proven loss and is idempotent per source binding", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-recovery-"));
  try {
    const handle = await ensureLocalCoreStore({ homePath: home });
    const bindings = new LocalCoreRuntimeBindingStore(handle.executor);
    const source = await bindings.admit({
      canonicalThreadId: "thread-main:source-session",
      runnerSessionId: "source-session",
      runtimeId: "claude",
      capabilityDigest: "source-capabilities",
      modelProvider: "anthropic",
      modelId: "claude-sonnet",
    });
    const recovery = {
      ...correlation(source),
      targetCanonicalThreadId: "thread-main:fork-session-1",
      targetRunnerSessionId: "fork-session-1",
      targetRuntimeId: "kestrel" as const,
      targetEnvironmentId: source.environmentId,
      targetCapabilityDigest: "kestrel-capabilities",
      targetModelProvider: "openai",
      targetModelId: "gpt-5",
      lossCode: "RUNTIME_NATIVE_SESSION_LOST" as const,
    };

    await assert.rejects(
      bindings.createRecoveryFork(recovery),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_BINDING_DEGRADED",
    );
    await bindings.degrade({
      ...correlation(source),
      lossCode: recovery.lossCode,
    });
    await assert.rejects(
      bindings.createRecoveryFork({ ...recovery, targetRuntimeId: "claude" }),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_RECOVERY_POLICY_INVALID",
    );

    const created = await bindings.createRecoveryFork(recovery);
    assert.equal(created.fork.runtimeId, "kestrel");
    assert.equal(created.fork.nativeSessionState, "ready");
    assert.equal(created.fork.sourceBindingId, source.bindingId);

    const retried = await bindings.createRecoveryFork({
      ...recovery,
      targetCanonicalThreadId: "thread-main:unused-retry-session",
      targetRunnerSessionId: "unused-retry-session",
    });
    assert.equal(retried.fork.bindingId, created.fork.bindingId);
    assert.equal(retried.fork.runnerSessionId, "fork-session-1");

    const outbox = await handle.executor.query<{ state: string }>(
      "SELECT state FROM local_runtime_binding_release_outbox WHERE binding_id = $1",
      [source.bindingId],
    );
    assert.deepEqual(outbox.rows, [{ state: "pending" }]);
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

function correlation(binding: {
  canonicalThreadId: string;
  bindingId: string;
  participantId: string;
  runtimeId: "kestrel" | "codex" | "claude";
  environmentId: string;
}) {
  return {
    canonicalThreadId: binding.canonicalThreadId,
    bindingId: binding.bindingId,
    participantId: binding.participantId,
    runtimeId: binding.runtimeId,
    environmentId: binding.environmentId,
  };
}
