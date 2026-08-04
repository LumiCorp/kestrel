import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureLocalCoreDaemonReady,
  inspectLocalCoreDaemon,
  isLocalCoreDaemonElectronAppLaunch,
  LocalCoreRestartBlockedError,
  restartLocalCoreDaemon,
  resolveLocalCoreDaemonEntrypoint,
  resolveLocalCoreDaemonNodeMode,
} from "../../src/localCore/daemon.js";
import { startLocalCoreApiServer } from "../../src/localCore/api.js";
import { resolveLocalCoreBuildIdentity } from "../../src/localCore/buildIdentity.js";
import { resolveLocalCorePaths } from "../../src/localCore/home.js";
import { acquireCoreLock, releaseCoreLock } from "../../src/localCore/lock.js";
import type {
  LocalCoreBuildIdentityV1,
  LocalCoreSystemLifecycle,
} from "../../src/localCore/contracts.js";


test("Local Core daemon runs Electron executables in Node mode", () => {
  assert.equal(resolveLocalCoreDaemonNodeMode({ electron: "37.10.3" }), "1");
  assert.equal(resolveLocalCoreDaemonNodeMode({}), undefined);
  assert.equal(resolveLocalCoreDaemonNodeMode({ electron: "  " }), undefined);
});

test("Local Core daemon resolves the emitted JavaScript entrypoint from compiled callers", () => {
  assert.equal(resolveLocalCoreDaemonEntrypoint({
    env: {},
    moduleUrl: "file:///workspace/apps/desktop/dist/src/localCore/daemon.js",
    fileExists: (filePath) => filePath.endsWith("/daemonMain.js"),
  }), "/workspace/apps/desktop/dist/src/localCore/daemonMain.js");
  assert.equal(resolveLocalCoreDaemonEntrypoint({
    env: {},
    moduleUrl: "file:///workspace/src/localCore/daemon.ts",
    fileExists: () => false,
  }), "/workspace/src/localCore/daemonMain.ts");
  assert.equal(resolveLocalCoreDaemonEntrypoint({
    env: { KESTREL_CLI_LIBEXEC: "/bundle/kestrel-repo" },
    fileExists: () => false,
  }), "/bundle/kestrel-repo/src/localCore/daemonMain.ts");
});

test("Local Core daemon launch is rejected when Electron was not put in Node mode", () => {
  assert.equal(isLocalCoreDaemonElectronAppLaunch({
    env: { KESTREL_LOCAL_CORE_DAEMON: "1" },
    versions: { electron: "37.10.3" },
  }), true);
  assert.equal(isLocalCoreDaemonElectronAppLaunch({
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      KESTREL_LOCAL_CORE_DAEMON: "1",
    },
    versions: { electron: "37.10.3" },
  }), false);
  assert.equal(isLocalCoreDaemonElectronAppLaunch({
    env: {},
    versions: { electron: "37.10.3" },
  }), false);
  assert.equal(isLocalCoreDaemonElectronAppLaunch({
    env: { KESTREL_LOCAL_CORE_DAEMON: "1" },
    versions: {},
  }), false);
});
test("Local Core daemon readiness returns a redaction-aware in-memory connection", async () => {
  const tempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const home = await mkdtemp(path.join(tempRoot, "kc-daemon-"));
  const env = { KESTREL_CORE_HOME: home };
  const buildIdentity = {
    version: "local_core_build_identity_v1" as const,
    buildId: `sha256:${"a".repeat(64)}` as const,
    suiteVersion: "0.6.0",
    source: "source_tree" as const,
  };
  const server = await startLocalCoreApiServer({
    env,
    platform: "darwin",
    coreVersion: "0.6.0",
    buildIdentity,
    idleTimeoutMs: 0,
  });
  try {
    const ready = await ensureLocalCoreDaemonReady({
      env,
      platform: "darwin",
      coreVersion: "0.6.0",
      buildIdentity,
    });
    assert.equal(ready.daemonStarted, false);
    assert.equal(ready.connection?.socketPath, server.socketPath);
    assert.equal(ready.connection?.authToken, server.token);
    assert.deepEqual(JSON.parse(JSON.stringify(ready.connection)), {
      socketPath: server.socketPath,
    });
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent Local Core launchers converge while replacing an idle outdated build", async () => {
  const tempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const home = await mkdtemp(path.join(tempRoot, "kc-daemon-replace-"));
  const env = { KESTREL_CORE_HOME: home, KESTREL_CORE_IDLE_TIMEOUT_MS: "0" };
  const outdatedBuild = {
    version: "local_core_build_identity_v1" as const,
    buildId: `sha256:${"b".repeat(64)}` as const,
    suiteVersion: "0.7.0",
    source: "source_tree" as const,
  };
  const expectedBuild = resolveLocalCoreBuildIdentity({
    runtimeRoot: process.cwd(),
    suiteVersion: "0.7.0",
  });
  const oldServer = await startLocalCoreApiServer({
    env,
    platform: process.platform,
    coreVersion: "0.7.0",
    buildIdentity: outdatedBuild,
    idleTimeoutMs: 0,
  });
  let ready: Array<Awaited<ReturnType<typeof ensureLocalCoreDaemonReady>>> = [];
  try {
    ready = await Promise.all([1, 2].map(async () => await ensureLocalCoreDaemonReady({
        env,
        platform: process.platform,
        coreVersion: "0.7.0",
        buildIdentity: expectedBuild,
        repoRoot: process.cwd(),
        waitTimeoutMs: 15_000,
      })));
    const buildIds = await Promise.all(ready.map(async (result) =>
      (await result.client?.buildIdentity())?.buildId));
    assert.deepEqual(buildIds, [expectedBuild.buildId, expectedBuild.buildId]);
    assert.equal(ready.some((result) => result.daemonStarted), true);
    assert.equal(ready[0]?.status.lock.state, "live");
    assert.equal(ready[1]?.status.lock.state, "live");
    if (ready[0]?.status.lock.state === "live" && ready[1]?.status.lock.state === "live") {
      assert.equal(ready[0].status.lock.lock.ownerPid, ready[1].status.lock.lock.ownerPid);
    }
    assert.equal((await ready[0]?.client?.systemLifecycle())?.state, "idle");
  } finally {
    await ready[0]?.client?.shutdownForCodeUpdate().catch(() => undefined);
    const paths = resolveLocalCorePaths(home);
    const deadline = Date.now() + 5_000;
    while ((existsSync(paths.lockPath) || existsSync(paths.apiSocketPath)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await oldServer.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy idle Local Core upgrades only through the lifecycle-gated Desktop fallback", async () => {
  const home = await mkdtemp(path.join("/tmp", "kc-daemon-legacy-"));
  const env = { KESTREL_CORE_HOME: home, KESTREL_CORE_IDLE_TIMEOUT_MS: "0" };
  const expectedBuild = resolveLocalCoreBuildIdentity({
    runtimeRoot: process.cwd(),
    suiteVersion: "0.7.0",
  });
  const legacy = await startFakeLocalCoreAuthority({
    home,
    coreVersion: "0.7.0",
    legacy: true,
  });
  let ready: Awaited<ReturnType<typeof ensureLocalCoreDaemonReady>> | undefined;
  try {
    ready = await ensureLocalCoreDaemonReady({
      env,
      platform: process.platform,
      coreVersion: "0.7.0",
      buildIdentity: expectedBuild,
      repoRoot: process.cwd(),
      waitTimeoutMs: 15_000,
    });
    assert.deepEqual(legacy.shutdownReasons, ["code_update", "desktop_update"]);
    assert.equal((await ready.client?.buildIdentity())?.buildId, expectedBuild.buildId);
  } finally {
    await ready?.client?.shutdownForCodeUpdate().catch(() => undefined);
    await legacy.close();
    await waitForCoreRelease(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy idle Local Core upgrades through the Desktop fallback across suite versions", async () => {
  const home = await mkdtemp(path.join("/tmp", "kc-daemon-legacy-version-"));
  const env = { KESTREL_CORE_HOME: home, KESTREL_CORE_IDLE_TIMEOUT_MS: "0" };
  const expectedBuild = resolveLocalCoreBuildIdentity({
    runtimeRoot: process.cwd(),
    suiteVersion: "0.7.0",
  });
  const legacy = await startFakeLocalCoreAuthority({
    home,
    coreVersion: "0.7.1",
    legacy: true,
  });
  let ready: Awaited<ReturnType<typeof ensureLocalCoreDaemonReady>> | undefined;
  try {
    ready = await ensureLocalCoreDaemonReady({
      env,
      platform: process.platform,
      coreVersion: "0.7.0",
      buildIdentity: expectedBuild,
      repoRoot: process.cwd(),
      waitTimeoutMs: 15_000,
    });
    assert.deepEqual(legacy.shutdownReasons, ["code_update", "desktop_update"]);
    assert.equal((await ready.client?.buildIdentity())?.buildId, expectedBuild.buildId);
  } finally {
    await ready?.client?.shutdownForCodeUpdate().catch(() => undefined);
    await legacy.close();
    await waitForCoreRelease(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy Local Core without lifecycle safety is never signaled automatically", async () => {
  const home = await mkdtemp(path.join("/tmp", "kc-daemon-legacy-unsafe-"));
  const expectedBuild = resolveLocalCoreBuildIdentity({
    runtimeRoot: process.cwd(),
    suiteVersion: "0.7.0",
  });
  const legacy = await startFakeLocalCoreAuthority({
    home,
    coreVersion: "0.7.0",
    legacy: true,
    lifecycleUnavailable: true,
  });
  try {
    await assert.rejects(
      () => ensureLocalCoreDaemonReady({
        env: { KESTREL_CORE_HOME: home },
        platform: process.platform,
        coreVersion: "0.7.0",
        buildIdentity: expectedBuild,
        repoRoot: process.cwd(),
        waitTimeoutMs: 5_000,
      }),
      /cannot report lifecycle safety/u,
    );
    assert.deepEqual(legacy.shutdownReasons, []);
  } finally {
    await legacy.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core restart reports busy blockers without closing admission", async () => {
  const home = await mkdtemp(path.join("/tmp", "kc-daemon-busy-"));
  const expectedBuild = buildFixtureIdentity("c");
  const authority = await startFakeLocalCoreAuthority({
    home,
    coreVersion: "0.7.0",
    buildIdentity: expectedBuild,
    busy: true,
  });
  try {
    await assert.rejects(
      () => restartLocalCoreDaemon({
        env: { KESTREL_CORE_HOME: home },
        platform: process.platform,
        coreVersion: "0.7.0",
        buildIdentity: expectedBuild,
        waitTimeoutMs: 5_000,
      }),
      (error) => error instanceof LocalCoreRestartBlockedError
        && error.inspection.lifecycle?.blockers[0]?.code === "LOCAL_CORE_EXECUTIONS_ACTIVE",
    );
    assert.deepEqual(authority.shutdownReasons, ["code_update"]);
    assert.equal(
      (await inspectLocalCoreDaemon({
        env: { KESTREL_CORE_HOME: home },
        platform: process.platform,
        coreVersion: "0.7.0",
        buildIdentity: expectedBuild,
      })).state,
      "running",
    );
  } finally {
    authority.setBusy(false);
    await authority.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("waiting Local Core restart polls until idle without submitting an early shutdown", async () => {
  const home = await mkdtemp(path.join("/tmp", "kc-daemon-wait-"));
  const env = { KESTREL_CORE_HOME: home, KESTREL_CORE_IDLE_TIMEOUT_MS: "0" };
  const expectedBuild = resolveLocalCoreBuildIdentity({
    runtimeRoot: process.cwd(),
    suiteVersion: "0.7.0",
  });
  const authority = await startFakeLocalCoreAuthority({
    home,
    coreVersion: "0.7.0",
    buildIdentity: expectedBuild,
    busy: true,
  });
  let ready: Awaited<ReturnType<typeof restartLocalCoreDaemon>> | undefined;
  try {
    const restart = restartLocalCoreDaemon({
      env,
      platform: process.platform,
      coreVersion: "0.7.0",
      buildIdentity: expectedBuild,
      repoRoot: process.cwd(),
      waitForIdle: true,
      waitTimeoutMs: 15_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.deepEqual(authority.shutdownReasons, []);
    authority.setBusy(false);
    ready = await restart;
    assert.deepEqual(authority.shutdownReasons, ["code_update"]);
    assert.equal((await ready.client?.buildIdentity())?.buildId, expectedBuild.buildId);
  } finally {
    authority.setBusy(false);
    await ready?.client?.shutdownForCodeUpdate().catch(() => undefined);
    await authority.close();
    await waitForCoreRelease(home);
    await rm(home, { recursive: true, force: true });
  }
});

interface FakeLocalCoreAuthority {
  shutdownReasons: Array<"code_update" | "desktop_update">;
  setBusy(value: boolean): void;
  close(): Promise<void>;
}

async function startFakeLocalCoreAuthority(input: {
  home: string;
  coreVersion: string;
  buildIdentity?: LocalCoreBuildIdentityV1 | undefined;
  legacy?: boolean | undefined;
  busy?: boolean | undefined;
  lifecycleUnavailable?: boolean | undefined;
}): Promise<FakeLocalCoreAuthority> {
  const paths = resolveLocalCorePaths(input.home);
  const token = "fake-local-core-token";
  const authorityId = `fake-authority-${path.basename(input.home)}`;
  let busy = input.busy === true;
  let closePromise: Promise<void> | undefined;
  const shutdownReasons: Array<"code_update" | "desktop_update"> = [];
  await mkdir(paths.corePath, { recursive: true });
  await writeFile(paths.apiTokenPath, `${token}\n`, "utf8");
  const lock = await acquireCoreLock({
    homePath: input.home,
    coreVersion: input.coreVersion,
    ownerExecutable: "/fake/kestrel-core",
    ownerPid: process.pid,
    authorityId,
    socketPath: paths.apiSocketPath,
    isPidAlive: () => true,
  });
  assert.equal(lock.state, "live");

  const close = async (): Promise<void> => {
    closePromise ??= (async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(paths.apiSocketPath, { force: true });
      await releaseCoreLock({
        homePath: input.home,
        coreVersion: input.coreVersion,
        authorityId,
      });
    })();
    await closePromise;
  };
  const lifecycle = (): LocalCoreSystemLifecycle => ({
    state: busy ? "busy" : "idle",
    owner: { pid: process.pid, executable: "/fake/kestrel-core" },
    blockers: busy
      ? [{
          code: "LOCAL_CORE_EXECUTIONS_ACTIVE",
          message: "Runtime executions are active.",
          count: 1,
        }]
      : [],
  });
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/health") {
      writeFakeJson(response, 200, { ok: true });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      writeFakeJson(response, 401, { ok: false });
      return;
    }
    if (request.url === "/v1/system/build-identity") {
      if (input.legacy === true) {
        writeFakeJson(response, 404, { ok: false });
      } else {
        writeFakeJson(response, 200, { ok: true, buildIdentity: input.buildIdentity });
      }
      return;
    }
    if (request.url === "/v1/system/lifecycle") {
      if (input.lifecycleUnavailable === true) {
        writeFakeJson(response, 404, { ok: false });
      } else {
        writeFakeJson(response, 200, { ok: true, lifecycle: lifecycle() });
      }
      return;
    }
    if (request.url === "/v1/system/shutdown" && request.method === "POST") {
      const body = JSON.parse(await readFakeRequestBody(request)) as { reason?: unknown };
      if (body.reason !== "code_update" && body.reason !== "desktop_update") {
        writeFakeJson(response, 400, { ok: false });
        return;
      }
      shutdownReasons.push(body.reason);
      if (input.legacy === true && body.reason === "code_update") {
        writeFakeJson(response, 400, { ok: false });
        return;
      }
      const currentLifecycle = lifecycle();
      if (currentLifecycle.state === "busy") {
        writeFakeJson(response, 409, {
          ok: false,
          shutdown: { status: "blocked", reason: body.reason, lifecycle: currentLifecycle },
        });
        return;
      }
      writeFakeJson(response, 202, {
        ok: true,
        shutdown: { status: "accepted", reason: body.reason, lifecycle: currentLifecycle },
      });
      setImmediate(() => void close());
      return;
    }
    writeFakeJson(response, 404, { ok: false });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.apiSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    shutdownReasons,
    setBusy(value) {
      busy = value;
    },
    close,
  };
}

function buildFixtureIdentity(seed: string): LocalCoreBuildIdentityV1 {
  return {
    version: "local_core_build_identity_v1",
    buildId: `sha256:${seed.repeat(64)}`,
    suiteVersion: "0.7.0",
    source: "source_tree",
  };
}

function writeFakeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readFakeRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForCoreRelease(home: string): Promise<void> {
  const paths = resolveLocalCorePaths(home);
  const deadline = Date.now() + 5_000;
  while ((existsSync(paths.lockPath) || existsSync(paths.apiSocketPath)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
