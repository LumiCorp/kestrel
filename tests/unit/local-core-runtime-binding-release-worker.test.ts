import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LocalCoreRuntimeBindingReleaseWorker,
} from "../../src/localCore/runtimeBindingReleaseWorker.js";
import {
  LocalCoreRuntimeBindingError,
  LocalCoreRuntimeBindingStore,
} from "../../src/localCore/runtimeBindings.js";
import {
  closeLocalCoreStore,
  ensureLocalCoreStore,
} from "../../src/localCore/store.js";

test("Local Core release worker sends one protocol release and durably records its exact acknowledgement", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-local-release-worker-"));
  try {
    const handle = await ensureLocalCoreStore({ homePath: home });
    const bindings = new LocalCoreRuntimeBindingStore(handle.executor);
    const source = await createDegradedSource(bindings, "codex", "release-success");
    await bindings.createRecoveryFork(recoveryInput(source, "recovery-success"));

    const commands: unknown[] = [];
    const worker = new LocalCoreRuntimeBindingReleaseWorker({
      runtimeBindings: () => bindings,
      retryDelayMs: 1,
      runnerClient: {
        async sendRunnerCommand(line, input) {
          const command = JSON.parse(line) as {
            id: string;
            type: string;
            payload: Record<string, unknown>;
          };
          commands.push(command);
          input.onLine(JSON.stringify({
            id: randomUUID(),
            type: "runtime.released",
            ts: new Date().toISOString(),
            commandId: command.id,
            sessionId: source.canonicalThreadId,
            threadId: source.canonicalThreadId,
            payload: command.payload,
          }));
        },
      },
    });

    await worker.wake();
    await worker.close();

    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0], {
      version: "runner_command_v2",
      id: (commands[0] as { id: string }).id,
      type: "runtime.release",
      metadata: {
        actor: {
          actorId: "local-core-runtime-release-worker",
          actorType: "service",
        },
      },
      payload: {
        runtimeId: source.runtimeId,
        bindingId: source.bindingId,
        participantId: source.participantId,
        threadId: source.canonicalThreadId,
        environmentId: source.environmentId,
      },
    });
    const outbox = await readReleaseRow(handle.executor, source.bindingId);
    assert.equal(outbox.state, "released");
    assert.equal(outbox.attempts, 1);
    assert.match(outbox.acknowledgement_event_id ?? "", /^[0-9a-f-]{36}$/u);
    assert.equal(outbox.failure_code, null);
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core release worker retries a failed durable row after restart without changing correlation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-local-release-retry-"));
  try {
    const handle = await ensureLocalCoreStore({ homePath: home });
    const bindings = new LocalCoreRuntimeBindingStore(handle.executor);
    const source = await createDegradedSource(bindings, "claude", "release-retry");
    await bindings.createRecoveryFork(recoveryInput(source, "recovery-retry"));
    let now = new Date("2026-08-12T12:00:00.000Z");

    const first = new LocalCoreRuntimeBindingReleaseWorker({
      runtimeBindings: () => bindings,
      retryDelayMs: 1_000,
      now: () => now,
      runnerClient: {
        async sendRunnerCommand() {
          throw Object.assign(new Error("provider detail must not persist"), {
            code: "RUNNER_RUNTIME_ERROR",
          });
        },
      },
    });
    await first.wake();
    await first.close();
    const failed = await readReleaseRow(handle.executor, source.bindingId);
    assert.equal(failed.state, "failed");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.failure_code, "RUNNER_RUNTIME_ERROR");
    assert.equal(JSON.stringify(failed).includes("provider detail"), false);

    now = new Date("2099-01-01T00:00:00.000Z");
    let retriedCommandId: string | undefined;
    const second = new LocalCoreRuntimeBindingReleaseWorker({
      runtimeBindings: () => bindings,
      retryDelayMs: 1_000,
      now: () => now,
      runnerClient: {
        async sendRunnerCommand(line, input) {
          const command = JSON.parse(line) as {
            id: string;
            payload: Record<string, unknown>;
          };
          retriedCommandId = command.id;
          input.onLine(JSON.stringify({
            id: randomUUID(),
            type: "runtime.released",
            ts: now.toISOString(),
            commandId: command.id,
            payload: command.payload,
          }));
        },
      },
    });
    await second.wake();
    await second.close();

    const released = await readReleaseRow(handle.executor, source.bindingId);
    assert.equal(released.state, "released");
    assert.equal(released.attempts, 2);
    assert.equal(retriedCommandId, released.id);
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core release completion is idempotent only for the same durable event and correlation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-local-release-proof-"));
  try {
    const handle = await ensureLocalCoreStore({ homePath: home });
    const bindings = new LocalCoreRuntimeBindingStore(handle.executor);
    const source = await createDegradedSource(bindings, "codex", "release-proof");
    await bindings.createRecoveryFork(recoveryInput(source, "recovery-proof"));
    const claimed = await bindings.claimRuntimeBindingRelease({
      retryBefore: new Date("2099-01-01T00:00:00.000Z"),
    });
    assert.ok(claimed);
    const eventId = randomUUID();
    const proof = {
      releaseId: claimed.id,
      eventId,
      commandId: claimed.id,
      bindingId: claimed.bindingId,
      participantId: claimed.participantId,
      canonicalThreadId: claimed.canonicalThreadId,
      runtimeId: claimed.runtimeId,
      environmentId: claimed.environmentId,
    };
    assert.equal(
      (await bindings.completeRuntimeBindingRelease(proof)).state,
      "released",
    );
    assert.equal(
      (await bindings.completeRuntimeBindingRelease(proof)).acknowledgementEventId,
      eventId,
    );
    await assert.rejects(
      bindings.completeRuntimeBindingRelease({
        ...proof,
        eventId: randomUUID(),
      }),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_RELEASE_ACKNOWLEDGEMENT_CONFLICT",
    );
    await assert.rejects(
      bindings.completeRuntimeBindingRelease({
        ...proof,
        environmentId: randomUUID(),
      }),
      (error: unknown) =>
        error instanceof LocalCoreRuntimeBindingError &&
        error.code === "RUNTIME_RELEASE_CORRELATION_INVALID",
    );
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

async function createDegradedSource(
  bindings: LocalCoreRuntimeBindingStore,
  runtimeId: "codex" | "claude",
  suffix: string,
) {
  const source = await bindings.admit({
    canonicalThreadId: `thread:${suffix}`,
    runnerSessionId: `session:${suffix}`,
    runtimeId,
    capabilityDigest: `capabilities:${suffix}`,
    modelProvider: runtimeId === "codex" ? "openai" : "anthropic",
    modelId: runtimeId === "codex" ? "gpt-5" : "claude-sonnet",
  });
  return await bindings.degrade({
    canonicalThreadId: source.canonicalThreadId,
    bindingId: source.bindingId,
    participantId: source.participantId,
    runtimeId: source.runtimeId,
    environmentId: source.environmentId,
    lossCode: "RUNTIME_NATIVE_SESSION_LOST",
  });
}

function recoveryInput(
  source: Awaited<ReturnType<typeof createDegradedSource>>,
  suffix: string,
) {
  return {
    canonicalThreadId: source.canonicalThreadId,
    bindingId: source.bindingId,
    participantId: source.participantId,
    runtimeId: source.runtimeId,
    environmentId: source.environmentId,
    targetCanonicalThreadId: `thread:${suffix}`,
    targetRunnerSessionId: `session:${suffix}`,
    targetRuntimeId: "kestrel" as const,
    targetEnvironmentId: source.environmentId,
    targetCapabilityDigest: `capabilities:${suffix}`,
    targetModelProvider: "openai",
    targetModelId: "gpt-5",
    lossCode: "RUNTIME_NATIVE_SESSION_LOST" as const,
  };
}

async function readReleaseRow(
  executor: {
    query<Row extends Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: Row[] }>;
  },
  bindingId: string,
) {
  const result = await executor.query<{
    id: string;
    state: string;
    attempts: number;
    acknowledgement_event_id: string | null;
    failure_code: string | null;
  }>(
    `SELECT id, state, attempts, acknowledgement_event_id, failure_code
       FROM local_runtime_binding_release_outbox
      WHERE binding_id = $1`,
    [bindingId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}
