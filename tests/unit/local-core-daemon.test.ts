import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureLocalCoreDaemonReady,
  isLocalCoreDaemonElectronAppLaunch,
  resolveLocalCoreDaemonEntrypoint,
  resolveLocalCoreDaemonNodeMode,
} from "../../src/localCore/daemon.js";
import { startLocalCoreApiServer } from "../../src/localCore/api.js";

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
  const server = await startLocalCoreApiServer({
    env,
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  try {
    const ready = await ensureLocalCoreDaemonReady({
      env,
      platform: "darwin",
      coreVersion: "0.6.0",
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
