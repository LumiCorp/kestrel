import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionStore } from "../../cli/session/SessionStore.js";
import type { SessionsFile, TuiSessionMeta } from "../../cli/contracts.js";


test("SessionStore persists pending waitFor metadata", async () => {
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

test("SessionStore rehydrates the recoverable background lifecycle state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-recovering-"));
  const store = new SessionStore(tempDir);
  const now = new Date(0).toISOString();
  const initial = await store.load();
  const recovering: TuiSessionMeta = {
    name: "recovering-child",
    sessionId: "recovering-child",
    profileId: "reference",
    createdAt: now,
    updatedAt: now,
    started: true,
    delegation: {
      taskId: "task-recovering-child",
      parentSessionId: "parent",
      childSessionId: "recovering-child",
      childSessionName: "recovering-child",
      title: "Recover child runtime status",
      status: "RECOVERING",
      profileId: "reference",
      provider: "openrouter",
      model: "test-model",
      createdAt: now,
      updatedAt: now,
    },
  };

  await store.save(store.upsert(initial, recovering));

  assert.equal(
    store.findByName(await store.load(), "recovering-child")?.delegation?.status,
    "RECOVERING",
  );
});

test("SessionStore round-trips exact pending and accepted TUI run identity with legacy compatibility", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-run-identity-"));
  const store = new SessionStore(tempDir);
  const now = new Date(0).toISOString();
  const session: TuiSessionMeta = {
    name: "exact-run-child",
    sessionId: "exact-run-child",
    profileId: "reference",
    createdAt: now,
    updatedAt: now,
    started: true,
    pendingRunId: "run-pending",
    pendingRunRequestId: "request-pending",
    pendingRunMessageId: "message-pending",
    pendingRunThreadId: "thread-main:exact-run-child",
    queuedRunReservations: [
      {
        runId: "run-queued-a",
        messageId: "message-queued-a",
        threadId: "thread-main:exact-run-child",
        predecessorRunId: "run-predecessor-a",
        indeterminate: true,
      },
      {
        runId: "run-queued-b",
        messageId: "message-queued-b",
        threadId: "thread-child:exact-run-child",
      },
    ],
    pendingQueueSubmissions: [
      {
        runId: "run-pending-queue-a",
        messageId: "message-pending-queue-a",
        threadId: "thread-main:exact-run-child",
        predecessorRunId: "run-predecessor-a",
      },
      {
        runId: "run-pending-queue-b",
        messageId: "message-pending-queue-b",
        threadId: "thread-child:exact-run-child",
      },
    ],
    terminalQueuedRuns: [{
      runId: "run-terminal-queued",
      messageId: "message-terminal-queued",
      threadId: "thread-main:exact-run-child",
      status: "COMPLETED",
      predecessorRunId: "run-predecessor-a",
    }],
    acceptedRunId: "run-accepted",
    acceptedRunMessageId: "message-accepted",
    acceptedRunThreadId: "thread-accepted:exact-run-child",
  };

  await store.save(store.upsert(await store.load(), session));
  const loaded = store.findByName(await store.load(), session.name);
  assert.equal(loaded?.pendingRunId, "run-pending");
  assert.equal(loaded?.pendingRunRequestId, "request-pending");
  assert.equal(loaded?.pendingRunMessageId, "message-pending");
  assert.equal(loaded?.pendingRunThreadId, "thread-main:exact-run-child");
  assert.deepEqual(loaded?.queuedRunReservations, session.queuedRunReservations);
  assert.deepEqual(loaded?.pendingQueueSubmissions, session.pendingQueueSubmissions);
  assert.deepEqual(loaded?.terminalQueuedRuns, session.terminalQueuedRuns);
  assert.equal(loaded?.acceptedRunId, "run-accepted");
  assert.equal(loaded?.acceptedRunMessageId, "message-accepted");
  assert.equal(loaded?.acceptedRunThreadId, "thread-accepted:exact-run-child");

  await writeFile(
    path.join(tempDir, "sessions.json"),
    JSON.stringify({
      version: 5,
      sessions: [{
        name: "legacy-no-run-identity",
        sessionId: "legacy-no-run-identity",
        profileId: "reference",
        createdAt: now,
        updatedAt: now,
        started: false,
      }],
    }),
    "utf8",
  );
  const legacy = store.findByName(await store.load(), "legacy-no-run-identity");
  assert.equal(legacy?.pendingRunId, undefined);
  assert.equal(legacy?.pendingRunRequestId, undefined);
  assert.equal(legacy?.pendingRunMessageId, undefined);
  assert.equal(legacy?.queuedRunReservations, undefined);
  assert.equal(legacy?.pendingQueueSubmissions, undefined);
  assert.equal(legacy?.acceptedRunId, undefined);
  assert.equal(legacy?.terminalQueuedRuns, undefined);
  assert.equal(legacy?.acceptedRunThreadId, undefined);
});

test("SessionStore readers never observe a partially written sessions file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-atomic-"));
  const store = new SessionStore(tempDir);
  const now = new Date().toISOString();
  const makeFile = (revision: number) => ({
    version: 5 as const,
    activeSessionName: `session-${revision}`,
    sessions: Array.from({ length: 250 }, (_, index): TuiSessionMeta => ({
      name: index === 0 ? `session-${revision}` : `session-${revision}-${index}`,
      sessionId: `session-${revision}-${index}-${"x".repeat(256)}`,
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    })),
  });

  await store.save(makeFile(0));
  const writes = Array.from({ length: 12 }, (_, revision) => store.save(makeFile(revision + 1)));
  const reads = Array.from({ length: 120 }, () => store.load());
  const loaded = await Promise.all(reads);
  await Promise.all(writes);

  assert.equal(loaded.every((file) => file.version === 5 && file.sessions.length === 250), true);
});

test("SessionStore serializes delayed saves in invocation order", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-ordered-"));
  const store = new SessionStore(tempDir);
  await store.load();
  const now = new Date(0).toISOString();
  const makeFile = (name: string): SessionsFile => ({
    version: 5,
    activeSessionName: name,
    sessions: [{
      name,
      sessionId: name,
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    }],
  });
  const controlled = store as unknown as {
    writeSnapshot(file: SessionsFile): Promise<void>;
  };
  const writeSnapshot = controlled.writeSnapshot.bind(store);
  const observed: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let firstStartedResolve: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    firstStartedResolve = resolve;
  });
  let writeCount = 0;
  controlled.writeSnapshot = async (file) => {
    writeCount += 1;
    observed.push(file.activeSessionName ?? "missing");
    if (writeCount === 1) {
      firstStartedResolve?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
    await writeSnapshot(file);
  };

  const older = store.save(makeFile("older"));
  await firstStarted;
  const newer = store.save(makeFile("newer"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(observed, ["older"]);
  releaseFirst?.();
  await Promise.all([older, newer]);

  assert.deepEqual(observed, ["older", "newer"]);
  assert.equal((await store.load()).activeSessionName, "newer");
});

test("SessionStore propagates a failed save without blocking the next ordered snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-failed-"));
  const store = new SessionStore(tempDir);
  await store.load();
  const now = new Date(0).toISOString();
  const makeFile = (name: string): SessionsFile => ({
    version: 5,
    activeSessionName: name,
    sessions: [{
      name,
      sessionId: name,
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    }],
  });
  const controlled = store as unknown as {
    writeSnapshot(file: SessionsFile): Promise<void>;
  };
  const writeSnapshot = controlled.writeSnapshot.bind(store);
  let writeCount = 0;
  controlled.writeSnapshot = async (file) => {
    writeCount += 1;
    if (writeCount === 1) throw new Error("injected ordered save failure");
    await writeSnapshot(file);
  };

  const failed = store.save(makeFile("failed"));
  const recovered = store.save(makeFile("recovered"));
  await assert.rejects(failed, /injected ordered save failure/u);
  await recovered;

  assert.equal((await store.load()).activeSessionName, "recovered");
});

test("SessionStore resolves a unique session id fragment without changing name precedence", async () => {
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

test("SessionStore reports ambiguous session id fragments", async () => {
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

test("SessionStore resets to empty when legacy version file is present", async () => {
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

test("SessionStore persists auto-compaction and delegation metadata", async () => {
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

test("SessionStore persists workspace binding metadata", async () => {
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

test("SessionStore round-trips exact TUI runtime identity metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-session-store-identity-"));
  const store = new SessionStore(tempDir);
  const now = new Date().toISOString();
  const session: TuiSessionMeta = {
    name: "developer-workspace",
    sessionId: "workspace-dev-1",
    profileId: "kestrel",
    profileLabel: "Kestrel",
    agentProfileId: "kestrel",
    agentProfileLabel: "Kestrel",
    environmentShellKind: "cli",
    environmentPresetId: "cli_dev_local",
    environmentCapabilityPackIds: ["balanced", "filesystem", "dev_shell"],
    effectiveAssemblyId: "bundle:kestrel:developer",
    effectiveAssemblyLabel: "Kestrel on cli:cli_dev_local",
    createdAt: now,
    updatedAt: now,
    started: true,
  };

  await store.save(store.upsert(await store.load(), session));
  const loaded = store.findByName(await store.load(), session.name);

  assert.equal(loaded?.agentProfileId, "kestrel");
  assert.equal(loaded?.agentProfileLabel, "Kestrel");
  assert.equal(loaded?.environmentShellKind, "cli");
  assert.equal(loaded?.environmentPresetId, "cli_dev_local");
  assert.deepEqual(loaded?.environmentCapabilityPackIds, [
    "balanced",
    "filesystem",
    "dev_shell",
  ]);
  assert.equal(loaded?.effectiveAssemblyId, "bundle:kestrel:developer");
  assert.equal(loaded?.effectiveAssemblyLabel, "Kestrel on cli:cli_dev_local");
});
