import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileClaudeSessionStore,
  FileCodexRolloutCheckpointStore,
  FileRuntimeBindingCorrelationStore,
  FileRuntimeNativeSessionStore,
} from "../../src/runtimes/FileRuntimeStateStore.js";

test("Codex rollout checkpoint materializes across isolated roots without persisting paths", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-codex-state-"));
  const firstHome = await mkdtemp(path.join(os.tmpdir(), "kestrel-codex-home-a-"));
  const secondHome = await mkdtemp(path.join(os.tmpdir(), "kestrel-codex-home-b-"));
  const relative = path.join("sessions", "2026", "rollout.jsonl");
  const rollout = path.join(firstHome, relative);
  await mkdir(path.dirname(rollout), { recursive: true });
  await writeFile(rollout, '{"thread":"private"}\n', { mode: 0o600 });
  const store = new FileCodexRolloutCheckpointStore(stateRoot);
  await store.capture({
    bindingId: "binding-checkpoint",
    codexHome: firstHome,
    rolloutPath: rollout,
  });
  assert.equal(
    await store.materialize({
      bindingId: "binding-checkpoint",
      codexHome: secondHome,
    }),
    "materialized",
  );
  assert.equal(
    await readFile(path.join(secondHome, relative), "utf8"),
    '{"thread":"private"}\n',
  );
  const metadata = await readFile(
    path.join(
      stateRoot,
      "codex",
      "checkpoints",
      createHash("sha256").update("binding-checkpoint").digest("hex"),
      "metadata.json",
    ),
    "utf8",
  );
  assert.doesNotMatch(metadata, new RegExp(firstHome, "u"));
  assert.doesNotMatch(metadata, new RegExp(secondHome, "u"));
  assert.doesNotMatch(metadata, /fingerprint/u);
  await store.release("binding-checkpoint");
  assert.equal(
    await store.materialize({
      bindingId: "binding-checkpoint",
      codexHome: secondHome,
    }),
    "missing",
  );
});

test("Runtime binding correlation persists and tombstones before native session creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-state-"));
  const binding = {
    version: "runtime_binding_v1" as const,
    bindingId: "binding-pre-session",
    runtimeId: "codex" as const,
    threadId: "thread-pre-session",
    participantId: "runtime:codex",
    environmentId: "environment-1",
    adapterContractVersion: 1 as const,
    capabilityDigest: "",
    status: "ready" as const,
    nativeSessionState: "uninitialized" as const,
  };
  await new FileRuntimeBindingCorrelationStore(root).register(binding);
  const reopened = new FileRuntimeBindingCorrelationStore(root);
  assert.equal((await reopened.load(binding.bindingId))?.status, "active");
  await reopened.release(binding);
  assert.equal(
    (await new FileRuntimeBindingCorrelationStore(root).load(binding.bindingId))
      ?.status,
    "released",
  );
  await assert.rejects(
    () => reopened.register(binding),
    /cannot become active/u,
  );
  const persisted = await readFile(
    path.join(
      root,
      "binding-correlations",
      `${createHash("sha256").update(binding.bindingId).digest("hex")}.json`,
    ),
    "utf8",
  );
  assert.doesNotMatch(persisted, /nativeSessionId|credential|fingerprint|config.*path/iu);
});

test("native Runtime correlation survives store recreation without credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-state-"));
  const first = new FileRuntimeNativeSessionStore(root);
  await first.save({
    version: "runtime_native_session_v1",
    bindingId: "binding-1",
    runtimeId: "codex",
    threadId: "thread-1",
    participantId: "runtime:codex",
    environmentId: "environment-1",
    nativeSessionId: "native-1",
    nativeVersion: "0.147.0",
    status: "ready",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  });

  assert.equal(
    (await new FileRuntimeNativeSessionStore(root).load("binding-1"))?.nativeSessionId,
    "native-1",
  );
});

test("native Runtime state is monotonic and release removes native correlation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-state-"));
  const store = new FileRuntimeNativeSessionStore(root);
  const ready = {
    version: "runtime_native_session_v1" as const,
    bindingId: "binding-monotonic",
    runtimeId: "codex" as const,
    threadId: "thread-1",
    participantId: "runtime:codex",
    environmentId: "environment-1",
    nativeSessionId: "native-private",
    nativeVersion: "0.147.0",
    status: "ready" as const,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
  await store.save(ready);
  await store.save({
    ...ready,
    status: "degraded",
    updatedAt: "2026-08-11T00:01:00.000Z",
  });
  await assert.rejects(() => store.save(ready), /cannot move/u);
  await store.release(ready.bindingId);

  const released = await store.load(ready.bindingId);
  assert.equal(released?.status, "released");
  assert.equal("nativeSessionId" in (released ?? {}), false);
  assert.equal(released?.threadId, "thread-1");
});

test("legacy released native records are read without exposing their native ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-state-"));
  const bindingId = "binding-legacy-release";
  const filePath = path.join(
    root,
    "bindings",
    `${createHash("sha256").update(bindingId).digest("hex")}.json`,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({
      version: "runtime_native_session_v1",
      bindingId,
      runtimeId: "codex",
      nativeSessionId: "legacy-private-id",
      nativeVersion: "0.147.0",
      status: "released",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:01:00.000Z",
    }),
  );
  const loaded = await new FileRuntimeNativeSessionStore(root).load(bindingId);
  assert.equal(loaded?.status, "released");
  assert.equal("nativeSessionId" in (loaded ?? {}), false);
});

test("Claude transcript mirroring is append ordered and UUID idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-claude-state-"));
  const store = new FileClaudeSessionStore(root);
  const key = { projectKey: "tenant-1", sessionId: "session-1" };
  await store.append(key, [{ type: "user", uuid: "entry-1" }]);
  await store.append(key, [
    { type: "user", uuid: "entry-1" },
    { type: "assistant", uuid: "entry-2" },
  ]);
  assert.deepEqual(await store.load(key), [
    { type: "user", uuid: "entry-1" },
    { type: "assistant", uuid: "entry-2" },
  ]);
});

test("Claude release is serialized with writes and tombstones late appends", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-claude-state-"));
  const store = new FileClaudeSessionStore(root);
  const key = { projectKey: "tenant-1", sessionId: "session-release" };
  await store.append(key, [{ type: "user", uuid: "entry-1" }]);
  await store.releaseSession(key.sessionId);
  assert.equal(await store.load(key), null);
  await assert.rejects(
    () => store.append(key, [{ type: "assistant", uuid: "late" }]),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "RUNTIME_SESSION_RELEASED",
  );
  assert.doesNotMatch(
    await readFile(
      path.join(
        root,
        "claude-released",
        `${createHash("sha256").update(key.sessionId).digest("hex")}.json`,
      ),
      "utf8",
    ),
    /session-release/u,
  );
});
