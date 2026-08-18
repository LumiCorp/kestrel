import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceShutdownCoordinator,
  WORKSPACE_FATAL_SHUTDOWN_TIMEOUT_MS,
  WORKSPACE_NORMAL_SHUTDOWN_TIMEOUT_MS,
} from "../src/shutdown.js";

test("Workspace shutdown budgets leave provider margin", () => {
  assert.equal(WORKSPACE_FATAL_SHUTDOWN_TIMEOUT_MS, 10_000);
  assert.equal(WORKSPACE_NORMAL_SHUTDOWN_TIMEOUT_MS, 115_000);
});

test("Workspace shutdown is shared and destroys held sockets at the deadline", async () => {
  let serverCloseCalls = 0;
  let closeIdleCalls = 0;
  let closeAllCalls = 0;
  let destroyedSockets = 0;
  let enteredDraining = 0;
  let terminalsClosed = 0;
  let idleTimerCleared = 0;
  const exitCodes: number[] = [];
  const neverSettles = new Promise<void>(() => {});
  const coordinator = createWorkspaceShutdownCoordinator({
    server: {
      close() {
        serverCloseCalls += 1;
      },
      closeIdleConnections() {
        closeIdleCalls += 1;
      },
      closeAllConnections() {
        closeAllCalls += 1;
      },
    },
    sockets: new Set([
      {
        destroy() {
          destroyedSockets += 1;
        },
      },
    ]),
    enterDraining() {
      enteredDraining += 1;
    },
    clearIdleTimer() {
      idleTimerCleared += 1;
    },
    closeTerminals() {
      terminalsClosed += 1;
    },
    stopServices: [() => neverSettles],
    exit(code) {
      exitCodes.push(code);
    },
    normalTimeoutMs: 5,
    fatalTimeoutMs: 2,
  });

  const first = coordinator.shutdown(0, "normal");
  const second = coordinator.shutdown(1, "fatal");
  assert.equal(first, second);
  await first;

  assert.equal(enteredDraining, 1);
  assert.equal(idleTimerCleared, 1);
  assert.equal(terminalsClosed, 1);
  assert.equal(serverCloseCalls, 1);
  assert.equal(closeIdleCalls, 1);
  assert.equal(closeAllCalls, 1);
  assert.equal(destroyedSockets, 1);
  assert.deepEqual(exitCodes, [0]);
});

test("Fatal Workspace shutdown uses the abbreviated deadline and exits nonzero", async () => {
  let destroyed = false;
  let exitCode: number | undefined;
  const coordinator = createWorkspaceShutdownCoordinator({
    server: {
      close() {},
      closeIdleConnections() {},
      closeAllConnections() {},
    },
    sockets: new Set([{ destroy: () => { destroyed = true; } }]),
    enterDraining() {},
    clearIdleTimer() {},
    closeTerminals() {},
    stopServices: [() => new Promise<void>(() => {})],
    exit(code) {
      exitCode = code;
    },
    fatalTimeoutMs: 1,
  });

  await coordinator.shutdown(17, "fatal");

  assert.equal(destroyed, true);
  assert.equal(exitCode, 17);
});
