import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionStore } from "../../cli/session/SessionStore.js";
import type { TuiSessionMeta } from "../../cli/contracts.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "SessionStore persists pending waitFor metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-"));
  const store = new SessionStore(tempDir);

  const initial = await store.load();
  const session: TuiSessionMeta = {
    name: "alpha",
    sessionId: "alpha-1",
    profileId: "reference",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    started: true,
    lastMessagePreview: "latest session preview",
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        promptId: "p-123",
      },
    },
  };

  const updated = store.upsert(initial, session);
  await store.save(updated);

  const reloaded = await store.load();
  const loadedSession = store.findByName(reloaded, "alpha");

  assert.equal(loadedSession?.pendingWaitFor?.eventType, "user.reply");
  assert.equal(loadedSession?.pendingWaitFor?.metadata?.promptId, "p-123");
  assert.equal(loadedSession?.lastMessagePreview, "latest session preview");
});

contractTest("runtime.hermetic", "SessionStore resolves a unique session id fragment without changing name precedence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-selector-"));
  const store = new SessionStore(tempDir);
  const initial = await store.load();
  const now = new Date().toISOString();
  const sessions: TuiSessionMeta[] = [
    {
      name: "session-1783373851798",
      sessionId: "reference-session-1783373851798-1783373851801",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    },
    {
      name: "1783373851798",
      sessionId: "reference-session-other",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    },
  ];
  const file = sessions.reduce((next, session) => store.upsert(next, session), initial);

  const byName = store.resolveSelector(file, "1783373851798");
  assert.equal(byName.status, "matched");
  assert.equal(byName.status === "matched" ? byName.session.name : undefined, "1783373851798");
  assert.equal(byName.status === "matched" ? byName.match : undefined, "name");

  const byIdFragment = store.resolveSelector(file, "3373851798-178");
  assert.equal(byIdFragment.status, "matched");
  assert.equal(
    byIdFragment.status === "matched" ? byIdFragment.session.name : undefined,
    "session-1783373851798",
  );
  assert.equal(byIdFragment.status === "matched" ? byIdFragment.match : undefined, "sessionIdFragment");
});

contractTest("runtime.hermetic", "SessionStore reports ambiguous session id fragments", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-selector-"));
  const store = new SessionStore(tempDir);
  const initial = await store.load();
  const now = new Date().toISOString();
  const file = [
    {
      name: "alpha",
      sessionId: "reference-session-1783373851798-1",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    },
    {
      name: "beta",
      sessionId: "reference-session-1783373851798-2",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    },
  ].reduce((next, session) => store.upsert(next, session), initial);

  const resolution = store.resolveSelector(file, "1783373851798");

  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.status === "ambiguous" ? resolution.matches.length : 0, 2);
});

contractTest("runtime.hermetic", "SessionStore resets to empty when legacy version file is present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-legacy-"));
  const filePath = path.join(tempDir, "sessions.json");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      sessions: [{ name: "old" }],
    }),
    "utf8",
  );

  const store = new SessionStore(tempDir);
  const loaded = await store.load();
  assert.equal(loaded.version, 5);
  assert.equal(loaded.sessions.length, 0);
});

contractTest("runtime.hermetic", "SessionStore persists auto-compaction and delegation metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-task-"));
  const store = new SessionStore(tempDir);
  const initial = await store.load();
  const now = new Date().toISOString();
  const session: TuiSessionMeta = {
    name: "task:child",
    sessionId: "task-1",
    profileId: "reference-anthropic",
    createdAt: now,
    updatedAt: now,
    started: true,
    autoCompactionEnabled: true,
    suppressAutoCompactionOnce: true,
    delegation: {
      taskId: "task-1",
      parentSessionId: "parent-1",
      title: "Research this issue",
      status: "WAITING",
      childSessionId: "task-1",
      childSessionName: "task:child",
      profileId: "reference-anthropic",
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      createdAt: now,
      updatedAt: now,
    },
  };

  await store.save(store.upsert(initial, session));
  const reloaded = await store.load();
  const loadedSession = store.findByName(reloaded, "task:child");

  assert.equal(loadedSession?.autoCompactionEnabled, true);
  assert.equal(loadedSession?.suppressAutoCompactionOnce, true);
  assert.equal(loadedSession?.delegation?.provider, "anthropic");
  assert.equal(loadedSession?.delegation?.status, "WAITING");
});

contractTest("runtime.hermetic", "SessionStore persists workspace binding metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-workspace-"));
  const store = new SessionStore(tempDir);
  const initial = await store.load();
  const now = new Date().toISOString();
  const session: TuiSessionMeta = {
    name: "workspace-bound",
    sessionId: "workspace-1",
    profileId: "reference",
    workspaceId: "ws-123",
    workspaceRoot: "/tmp/project-root",
    createdAt: now,
    updatedAt: now,
    started: false,
  };

  await store.save(store.upsert(initial, session));
  const reloaded = await store.load();
  const loadedSession = store.findByName(reloaded, "workspace-bound");

  assert.equal(loadedSession?.workspaceId, "ws-123");
  assert.equal(loadedSession?.workspaceRoot, "/tmp/project-root");
});
