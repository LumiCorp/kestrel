import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LocalCoreClient,
  ensureLocalCoreReady,
  readCoreLock,
  resolveLocalCorePaths,
  startLocalCoreApiServer,
} from "../src/localCore/index.js";
import { WorkspaceStore } from "../cli/workspace/WorkspaceStore.js";
import { SessionStore } from "../cli/session/SessionStore.js";

const VERSION = "0.6.0";
const SMOKE_TEMP_ROOT = process.platform === "darwin" ? "/tmp" : os.tmpdir();

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(SMOKE_TEMP_ROOT, "kestrel-lc-smoke-"));
  const desktopHome = path.join(root, "desktop-first");
  const cliHome = path.join(root, "cli-first");
  try {
    await smokeInheritedDatabaseUrlRejection(path.join(root, "inherited-db"));
    await smokeShellAttachOrder(desktopHome, "desktop-first");
    await smokeShellAttachOrder(cliHome, "cli-first");
    await smokeConcurrentOwnership(path.join(root, "concurrent"));
    await smokeStaleLockClassification(path.join(root, "stale-lock"));
    process.stdout.write("[local-core-smoke] passed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function smokeInheritedDatabaseUrlRejection(home: string): Promise<void> {
  const status = await ensureLocalCoreReady({
    env: {
      KESTREL_CORE_HOME: home,
      DATABASE_URL: "postgres://host-db.example.invalid/kestrel",
    },
    platform: "darwin",
    coreVersion: VERSION,
    databaseMode: "external",
  });
  assert.equal(status.state, "blocked");
  assert.equal(status.lastError?.code, "LOCAL_CORE_EXTERNAL_DATABASE_URL_REQUIRED");
}

async function smokeShellAttachOrder(home: string, label: string): Promise<void> {
  const server = await startLocalCoreApiServer({
    env: {
      KESTREL_CORE_HOME: home,
      OPENROUTER_API_KEY: "sk-redact-me",
    },
    platform: "darwin",
    coreVersion: VERSION,
    idleTimeoutMs: 0,
  });
  const previousCoreHome = process.env.KESTREL_CORE_HOME;
  const previousSocket = process.env.KESTREL_LOCAL_CORE_API_SOCKET;
  const previousToken = process.env.KESTREL_LOCAL_CORE_API_TOKEN;
  try {
    process.env.KESTREL_CORE_HOME = home;
    process.env.KESTREL_LOCAL_CORE_API_SOCKET = server.socketPath;
    process.env.KESTREL_LOCAL_CORE_API_TOKEN = server.token;

    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    const status = await client.status();
    const stateHome = path.join(home, "state", "0.6");
    assert.equal(status.state, "healthy");
    assert.equal(status.home.productRootPath, home);
    assert.equal(status.home.homePath, stateHome);
    process.env.KESTREL_CORE_HOME = stateHome;
    assert.equal(status.lock.state, "live");

    await new WorkspaceStore(stateHome).save({
      version: 3,
      workspaces: [{
        workspaceId: `${label}-workspace`,
        rootPath: home,
        automationEnabled: false,
        discoveredAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      }],
    });
    assert.equal((await new WorkspaceStore(stateHome).load()).workspaces[0]?.workspaceId, `${label}-workspace`);

    await new SessionStore(stateHome).save({
      version: 5,
      activeSessionName: `${label}-session`,
      sessions: [{
        name: `${label}-session`,
        sessionId: `${label}-session-id`,
        profileId: "reference",
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
        started: true,
        interactionMode: "build",
      }],
    });
    assert.equal((await new SessionStore(stateHome).load()).activeSessionName, `${label}-session`);

    const lease = await client.postJson("/v1/kcron/lease/acquire", { ownerPid: process.pid }) as { acquired?: boolean };
    assert.equal(lease.acquired, true);
    const duplicate = await client.postJson("/v1/kcron/lease/acquire", { ownerPid: process.pid + 1 }) as { acquired?: boolean };
    assert.equal(duplicate.acquired, false);

    const supportBundle = await client.supportBundle();
    assert.equal(JSON.stringify(supportBundle).includes("sk-redact-me"), false);
  } finally {
    restoreEnv("KESTREL_CORE_HOME", previousCoreHome);
    restoreEnv("KESTREL_LOCAL_CORE_API_SOCKET", previousSocket);
    restoreEnv("KESTREL_LOCAL_CORE_API_TOKEN", previousToken);
    await server.close();
  }
}

async function smokeConcurrentOwnership(home: string): Promise<void> {
  const [first, second] = await Promise.all([
    ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: VERSION,
      ownerExecutable: "/Applications/Kestrel.app",
    }),
    ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: VERSION,
      ownerExecutable: "/usr/local/bin/kestrel",
    }),
  ]);
  assert.equal(first.lock.state, "live");
  assert.equal(second.lock.state, "live");
  assert.equal(first.lock.lock.ownerPid, second.lock.lock.ownerPid);
}

async function smokeStaleLockClassification(home: string): Promise<void> {
  await ensureLocalCoreReady({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: VERSION,
    ownerExecutable: "/Applications/Kestrel.app",
    now: new Date("2026-06-17T00:00:00.000Z"),
  });
  const lock = await readCoreLock({
    homePath: home,
    currentCoreVersion: VERSION,
    now: new Date("2026-06-17T00:01:00.000Z"),
  });
  assert.equal(lock.state, "stale");
  assert.equal(resolveLocalCorePaths(home).lockPath.endsWith("core/lock.json"), true);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

void main().catch((error) => {
  process.stderr.write(`[local-core-smoke] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
