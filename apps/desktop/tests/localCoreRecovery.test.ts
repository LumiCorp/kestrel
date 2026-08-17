import test from "node:test";
import assert from "node:assert/strict";

import { LocalCoreApiError } from "../../../src/localCore/client.js";
import type { LocalCoreSystemShutdownResult } from "../../../src/localCore/contracts.js";
import {
  createDesktopStartupRecoveryCoordinator,
  parseDesktopRestartKestrelInput,
  type DesktopLocalCoreRecoveryClient,
  type DesktopLocalCoreRecoveryOperations,
  type DesktopLocalCoreRecoveryOwner,
} from "../src/localCoreRecovery.js";

test("Desktop restart bridge input requires the exact force contract", () => {
  assert.deepEqual(parseDesktopRestartKestrelInput({ force: false }), {
    force: false,
  });
  assert.throws(
    () => parseDesktopRestartKestrelInput({}),
    /input\.force must be boolean/u,
  );
  assert.throws(
    () => parseDesktopRestartKestrelInput({ force: true, reason: "update" }),
    /field 'reason' is unsupported/u,
  );
});

const owner: DesktopLocalCoreRecoveryOwner = {
  pid: 4200,
  authorityId: "authority-a",
  socketPath: "/tmp/kestrel-core.sock",
  processIdentity: "process-birth-a",
  socketIdentity: "socket-inode-a",
};

function accepted(reason: "desktop_restart" | "desktop_update" = "desktop_restart"): LocalCoreSystemShutdownResult {
  return {
    status: "accepted",
    reason,
    lifecycle: {
      state: "idle",
      owner: { pid: owner.pid, executable: "/opt/kestrel/daemonMain.js" },
      blockers: [],
    },
  };
}

function blocked(): LocalCoreSystemShutdownResult {
  return {
    status: "blocked",
    reason: "desktop_restart",
    lifecycle: {
      state: "busy",
      owner: { pid: owner.pid, executable: "/opt/kestrel/daemonMain.js" },
      blockers: [{
        code: "LOCAL_CORE_EXECUTIONS_ACTIVE",
        message: "One execution is active.",
        count: 1,
      }],
    },
  };
}

function harness(input: {
  client?: DesktopLocalCoreRecoveryClient | undefined;
  initialOwner?: DesktopLocalCoreRecoveryOwner | undefined;
  signal?: ((signal: NodeJS.Signals) => void) | undefined;
  resourcesReleased?: (() => boolean) | undefined;
  wait?: (() => void) | undefined;
  prepare?: (() => void) | undefined;
  connect?: (() => void) | undefined;
} = {}) {
  let currentOwner = input.initialOwner === undefined ? owner : input.initialOwner;
  const signals: NodeJS.Signals[] = [];
  let prepared = 0;
  let relaunched = 0;
  const operations: DesktopLocalCoreRecoveryOperations = {
    async inspectOwner() {
      return currentOwner;
    },
    async connect() {
      input.connect?.();
      return input.client;
    },
    async areCoreResourcesReleased() {
      return input.resourcesReleased?.() ?? currentOwner === undefined;
    },
    isProcessAlive(pid) {
      return currentOwner?.pid === pid;
    },
    signalProcess(_pid, signal) {
      signals.push(signal);
      input.signal?.(signal);
      if (input.signal === undefined) currentOwner = undefined;
    },
    async wait() {
      input.wait?.();
    },
  };
  const coordinator = createDesktopStartupRecoveryCoordinator({
    operations,
    async prepareDesktop() {
      input.prepare?.();
      prepared += 1;
    },
    relaunchDesktop() {
      relaunched += 1;
    },
    gracefulExitTimeoutMs: 2,
    sigtermTimeoutMs: 2,
    sigkillTimeoutMs: 2,
    pollIntervalMs: 1,
  });
  return {
    coordinator,
    operations,
    signals,
    get prepared() {
      return prepared;
    },
    get relaunched() {
      return relaunched;
    },
    setOwner(next: DesktopLocalCoreRecoveryOwner | undefined) {
      currentOwner = next;
    },
  };
}

test("blocked-startup recovery gracefully replaces an idle daemon", async () => {
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        state.setOwner(undefined);
        return accepted();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("current daemons must not use the legacy fallback");
      },
    },
  });

  assert.deepEqual(await state.coordinator.restart({ force: false }), {
    status: "restarting",
  });
  assert.equal(state.prepared, 1);
  assert.equal(state.relaunched, 1);
  assert.deepEqual(state.signals, []);
});

test("Desktop resources are prepared only after the Core socket and lock release", async () => {
  let resourcesReleased = false;
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        state.setOwner(undefined);
        return accepted();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("current daemons must not use the legacy fallback");
      },
    },
    resourcesReleased: () => resourcesReleased,
    wait() {
      resourcesReleased = true;
    },
    prepare() {
      assert.equal(resourcesReleased, true);
    },
  });

  assert.equal((await state.coordinator.restart({ force: false })).status, "restarting");
  assert.equal(state.prepared, 1);
});

test("blocked-startup recovery falls back only when a legacy daemon rejects the new reason", async () => {
  let legacyCalls = 0;
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        throw new LocalCoreApiError(400, {
          error: {
            code: "LOCAL_CORE_SHUTDOWN_INVALID",
            message: "legacy shutdown contract",
          },
        });
      },
      async shutdownForDesktopUpdate() {
        legacyCalls += 1;
        state.setOwner(undefined);
        return accepted("desktop_update");
      },
    },
  });

  assert.equal((await state.coordinator.restart({ force: false })).status, "restarting");
  assert.equal(legacyCalls, 1);
});

test("a graceful shutdown timeout offers an explicit force restart", async () => {
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        return accepted();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("no fallback expected");
      },
    },
  });

  const result = await state.coordinator.restart({ force: false });
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("timeout must block recovery");
  assert.equal(result.blockers[0]?.code, "LOCAL_CORE_SHUTDOWN_TIMEOUT");
  assert.equal(result.forceAvailable, true);
  assert.equal(state.prepared, 0);
});

test("graceful recovery rejects a replacement Core authority", async () => {
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        state.setOwner({ ...owner, authorityId: "authority-b" });
        return accepted();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("no fallback expected");
      },
    },
  });

  const result = await state.coordinator.restart({ force: false });
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("owner change must block recovery");
  assert.equal(result.blockers[0]?.code, "LOCAL_CORE_OWNER_CHANGED");
  assert.equal(result.forceAvailable, false);
  assert.equal(state.prepared, 0);
  assert.equal(state.relaunched, 0);
});

test("graceful recovery re-verifies authority before requesting shutdown", async () => {
  let shutdownCalls = 0;
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        shutdownCalls += 1;
        return accepted();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("no fallback expected");
      },
    },
    connect() {
      state.setOwner({ ...owner, authorityId: "authority-b" });
    },
  });

  const result = await state.coordinator.restart({ force: false });
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("owner change must block recovery");
  assert.equal(result.blockers[0]?.code, "LOCAL_CORE_OWNER_CHANGED");
  assert.equal(shutdownCalls, 0);
});

test("active Core work blocks recovery until the user explicitly forces it", async () => {
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        return blocked();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("no fallback expected");
      },
    },
  });

  assert.deepEqual(await state.coordinator.restart({ force: false }), {
    status: "blocked",
    blockers: blocked().lifecycle.blockers,
    forceAvailable: true,
  });
  assert.deepEqual(await state.coordinator.restart({ force: true }), {
    status: "restarting",
  });
  assert.deepEqual(state.signals, ["SIGTERM"]);
  assert.equal(state.prepared, 1);
  assert.equal(state.relaunched, 1);
});

test("force recovery refuses to signal a Core owner with a different authority", async () => {
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        return blocked();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("no fallback expected");
      },
    },
  });
  await state.coordinator.restart({ force: false });
  state.setOwner({ ...owner, authorityId: "authority-b" });

  const result = await state.coordinator.restart({ force: true });
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("owner change must block recovery");
  assert.equal(result.forceAvailable, false);
  assert.equal(result.blockers[0]?.code, "LOCAL_CORE_OWNER_CHANGED");
  assert.deepEqual(state.signals, []);
});

test("force recovery refuses to signal a Core owner with a different PID", async () => {
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        return blocked();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("no fallback expected");
      },
    },
  });
  await state.coordinator.restart({ force: false });
  state.setOwner({ ...owner, pid: owner.pid + 1 });

  const result = await state.coordinator.restart({ force: true });
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("PID change must block recovery");
  assert.equal(result.blockers[0]?.code, "LOCAL_CORE_OWNER_CHANGED");
  assert.deepEqual(state.signals, []);
});

test("unavailable Core asks for force before signaling the verified owner", async () => {
  const state = harness();
  const first = await state.coordinator.restart({ force: false });
  assert.equal(first.status, "blocked");
  if (first.status !== "blocked") assert.fail("unavailable Core must block first");
  assert.equal(first.forceAvailable, true);
  assert.equal(first.blockers[0]?.code, "LOCAL_CORE_RECOVERY_CONNECTION_UNAVAILABLE");
  assert.equal((await state.coordinator.restart({ force: true })).status, "restarting");
  assert.deepEqual(state.signals, ["SIGTERM"]);
});

test("force recovery escalates from SIGTERM to SIGKILL after the bounded wait", async () => {
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        return blocked();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("no fallback expected");
      },
    },
    signal(signal) {
      if (signal === "SIGKILL") state.setOwner(undefined);
    },
  });
  await state.coordinator.restart({ force: false });

  assert.equal((await state.coordinator.restart({ force: true })).status, "restarting");
  assert.deepEqual(state.signals, ["SIGTERM", "SIGKILL"]);
});

test("force recovery does not signal a replacement authority after SIGTERM", async () => {
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        return blocked();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("no fallback expected");
      },
    },
    signal(signal) {
      if (signal === "SIGTERM") {
        state.setOwner({ ...owner, authorityId: "authority-b" });
      }
    },
  });
  await state.coordinator.restart({ force: false });

  const result = await state.coordinator.restart({ force: true });
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("owner change must block recovery");
  assert.equal(result.blockers[0]?.code, "LOCAL_CORE_OWNER_CHANGED");
  assert.deepEqual(state.signals, ["SIGTERM"]);
  assert.equal(state.prepared, 0);
  assert.equal(state.relaunched, 0);
});

test("automatic startup recovery never signals a responsive verified owner", async () => {
  const state = harness({
    initialOwner: {
      ...owner,
      ownerExecutable: "/opt/kestrel/daemonMain.js",
      heartbeatStale: true,
      executableVerified: true,
    },
    client: {
      async shutdownForDesktopRestart() {
        assert.fail("automatic recovery must not shut down a responsive owner");
      },
      async shutdownForDesktopUpdate() {
        assert.fail("automatic recovery must not shut down a responsive owner");
      },
    },
  });

  assert.equal(await state.coordinator.recoverStartupFailure(), undefined);
  assert.deepEqual(state.signals, []);
});

test("automatic startup recovery replaces only a stale unreachable verified owner", async () => {
  const state = harness({
    initialOwner: {
      ...owner,
      ownerExecutable: "/opt/kestrel/daemonMain.js",
      heartbeatStale: true,
      executableVerified: true,
    },
  });

  assert.deepEqual(await state.coordinator.recoverStartupFailure(), { status: "restarting" });
  assert.deepEqual(state.signals, ["SIGTERM"]);
  assert.equal(state.prepared, 1);
  assert.equal(state.relaunched, 1);
});

test("automatic startup recovery aborts when ownership changes after handshake failure", async () => {
  const state = harness({
    initialOwner: {
      ...owner,
      ownerExecutable: "/opt/kestrel/daemonMain.js",
      heartbeatStale: true,
      executableVerified: true,
    },
    connect() {
      state.setOwner({
        ...owner,
        authorityId: "authority-b",
        ownerExecutable: "/opt/kestrel/daemonMain.js",
        heartbeatStale: true,
        executableVerified: true,
      });
    },
  });

  const result = await state.coordinator.recoverStartupFailure();
  assert.equal(result?.status, "blocked");
  assert.deepEqual(state.signals, []);
});

test("automatic startup recovery aborts when the PID has a different process birth identity", async () => {
  const state = harness({
    initialOwner: {
      ...owner,
      ownerExecutable: "/opt/kestrel/daemonMain.js",
      heartbeatStale: true,
      executableVerified: true,
    },
    connect() {
      state.setOwner({
        ...owner,
        processIdentity: "process-birth-b",
        ownerExecutable: "/opt/kestrel/daemonMain.js",
        heartbeatStale: true,
        executableVerified: true,
      });
    },
  });

  assert.equal((await state.coordinator.recoverStartupFailure())?.status, "blocked");
  assert.deepEqual(state.signals, []);
});

test("automatic startup recovery aborts when the socket is replaced at the same path", async () => {
  const state = harness({
    initialOwner: {
      ...owner,
      ownerExecutable: "/opt/kestrel/daemonMain.js",
      heartbeatStale: true,
      executableVerified: true,
    },
    connect() {
      state.setOwner({
        ...owner,
        socketIdentity: "socket-inode-b",
        ownerExecutable: "/opt/kestrel/daemonMain.js",
        heartbeatStale: true,
        executableVerified: true,
      });
    },
  });

  assert.equal((await state.coordinator.recoverStartupFailure())?.status, "blocked");
  assert.deepEqual(state.signals, []);
});

test("automatic startup recovery refuses ambiguous executable ownership", async () => {
  const state = harness({
    initialOwner: {
      ...owner,
      ownerExecutable: "/usr/bin/node",
      heartbeatStale: true,
      executableVerified: false,
    },
  });

  assert.equal(await state.coordinator.recoverStartupFailure(), undefined);
  assert.deepEqual(state.signals, []);
});

test("recovery requests are single-flight", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let shutdownCalls = 0;
  const state = harness({
    client: {
      async shutdownForDesktopRestart() {
        shutdownCalls += 1;
        await pending;
        state.setOwner(undefined);
        return accepted();
      },
      async shutdownForDesktopUpdate() {
        assert.fail("no fallback expected");
      },
    },
  });

  const first = state.coordinator.restart({ force: false });
  const second = state.coordinator.restart({ force: false });
  assert.equal(first, second);
  release();
  await first;
  assert.equal(shutdownCalls, 1);
});
