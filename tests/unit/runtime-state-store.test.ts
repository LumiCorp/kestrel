import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileClaudeSessionStore,
  FileRuntimeNativeSessionStore,
} from "../../src/runtimes/FileRuntimeStateStore.js";

test("native Runtime correlation survives store recreation without credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-state-"));
  const first = new FileRuntimeNativeSessionStore(root);
  await first.save({
    version: "runtime_native_session_v1",
    bindingId: "binding-1",
    runtimeId: "codex",
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
