import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createWorkspaceRunnerReadiness,
  type WorkspaceRunnerProcess,
  type WorkspaceRunnerReadinessEvent,
  workspaceRunnerHealthStatus,
} from "../src/runner-readiness.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakeRunner() {
  const runner = new EventEmitter() as WorkspaceRunnerProcess;
  runner.kill = () => true;
  return runner;
}

test(
  "concurrent Workspace health checks start one runner and stay unavailable until it is ready",
  async () => {
    const health = deferred();
    const runner = fakeRunner();
    const events: WorkspaceRunnerReadinessEvent[] = [];
    let starts = 0;
    const readiness = createWorkspaceRunnerReadiness({
      startRunner: () => {
        starts += 1;
        return runner;
      },
      waitUntilHealthy: () => health.promise,
      probeHealth: async () => {},
      onFatalExit() {},
      log: (event) => events.push(event),
    });

    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 503,
      code: "WORKSPACE_RUNNER_STARTING",
    });
    const requests = Array.from({ length: 16 }, () => readiness.ensureReady());
    assert.ok(requests.every((request) => request === requests[0]));
    assert.equal(starts, 1);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 503,
      code: "WORKSPACE_RUNNER_STARTING",
    });

    health.resolve();
    await Promise.all(requests);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 200,
      code: null,
    });
    assert.deepEqual(events, [
      { type: "workspace.runner.starting" },
      { type: "workspace.runner.ready" },
    ]);
  },
);

test(
  "Workspace runner loss downgrades health and permits one replacement start",
  async () => {
    const firstRunner = fakeRunner();
    const secondRunner = fakeRunner();
    const runners = [firstRunner, secondRunner];
    let starts = 0;
    const readiness = createWorkspaceRunnerReadiness({
      startRunner: () => {
        const runner = runners[starts];
        starts += 1;
        assert.ok(runner);
        return runner;
      },
      waitUntilHealthy: async () => {},
      probeHealth: async () => {},
      onFatalExit() {},
      log() {},
    });

    await readiness.ensureReady();
    firstRunner.emit("exit", 0);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 503,
      code: "WORKSPACE_RUNNER_UNAVAILABLE",
    });
    await Promise.all([readiness.ensureReady(), readiness.ensureReady()]);
    assert.equal(starts, 2);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 200,
      code: null,
    });
  },
);

test(
  "Workspace runner health failures remain retryable without duplicate processes",
  async () => {
    const health = deferred();
    const runner = fakeRunner();
    let starts = 0;
    let waits = 0;
    const readiness = createWorkspaceRunnerReadiness({
      startRunner: () => {
        starts += 1;
        return runner;
      },
      waitUntilHealthy: () => {
        waits += 1;
        return waits === 1 ? health.promise : Promise.resolve();
      },
      probeHealth: async () => {},
      onFatalExit() {},
      log() {},
    });

    const first = readiness.ensureReady();
    health.reject(new Error("not ready"));
    await assert.rejects(first, /not ready/u);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 503,
      code: "WORKSPACE_RUNNER_UNAVAILABLE",
    });
    await readiness.ensureReady();
    assert.equal(starts, 1);
    assert.equal(waits, 2);
  },
);

test(
  "Workspace health downgrades when the running runner loses its health contract",
  async () => {
    const runner = fakeRunner();
    const events: WorkspaceRunnerReadinessEvent[] = [];
    let probeHealthy = true;
    let starts = 0;
    const readiness = createWorkspaceRunnerReadiness({
      startRunner: () => {
        starts += 1;
        return runner;
      },
      waitUntilHealthy: async () => {},
      probeHealth: async () => {
        if (!probeHealthy) throw new Error("runner unavailable");
      },
      onFatalExit() {},
      log: (event) => events.push(event),
    });

    await readiness.ensureReady();
    await readiness.probeReady();
    probeHealthy = false;
    await assert.rejects(readiness.probeReady(), /runner unavailable/u);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 503,
      code: "WORKSPACE_RUNNER_UNAVAILABLE",
    });
    assert.equal(starts, 1);
    assert.deepEqual(events.at(-1), {
      type: "workspace.runner.failed",
      reason: "health",
    });
  },
);

test(
  "Workspace shutdown is shared and waits for the runner to exit",
  async () => {
    const runner = new EventEmitter() as WorkspaceRunnerProcess;
    const signals: string[] = [];
    runner.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    const readiness = createWorkspaceRunnerReadiness({
      startRunner: () => runner,
      waitUntilHealthy: async () => {},
      probeHealth: async () => {},
      onFatalExit() {
        assert.fail("shutdown exit must not be treated as fatal");
      },
      log() {},
      shutdownTimeoutMs: 100,
    });

    await readiness.ensureReady();
    const firstStop = readiness.stop();
    const secondStop = readiness.stop();
    assert.equal(firstStop, secondStop);
    assert.deepEqual(signals, ["SIGTERM"]);

    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);

    runner.emit("exit", 0);
    await firstStop;
    assert.equal(stopped, true);
  },
);

test(
  "Workspace shutdown escalates once after the graceful timeout and still awaits exit",
  async () => {
    const runner = new EventEmitter() as WorkspaceRunnerProcess;
    const signals: string[] = [];
    const events: WorkspaceRunnerReadinessEvent[] = [];
    runner.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    const readiness = createWorkspaceRunnerReadiness({
      startRunner: () => runner,
      waitUntilHealthy: async () => {},
      probeHealth: async () => {},
      onFatalExit() {},
      log: (event) => events.push(event),
      shutdownTimeoutMs: 5,
    });

    await readiness.ensureReady();
    const stopping = readiness.stop();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(events.at(-1), {
      type: "workspace.runner.failed",
      reason: "shutdown_timeout",
    });

    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    runner.emit("exit", null);
    await stopping;
  },
);
