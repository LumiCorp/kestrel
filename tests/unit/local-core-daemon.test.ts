import assert from "node:assert/strict";
import test from "node:test";

import {
  isLocalCoreDaemonElectronAppLaunch,
  resolveLocalCoreDaemonNodeMode,
} from "../../src/localCore/daemon.js";

test("Local Core daemon runs Electron executables in Node mode", () => {
  assert.equal(resolveLocalCoreDaemonNodeMode({ electron: "37.10.3" }), "1");
  assert.equal(resolveLocalCoreDaemonNodeMode({}), undefined);
  assert.equal(resolveLocalCoreDaemonNodeMode({ electron: "  " }), undefined);
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
