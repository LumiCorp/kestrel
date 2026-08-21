import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createWorkspaceRunnerReadiness,
  waitForWorkspaceRunnerHealth,
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
      { type: "workspace.runner.starting", generation: 1 },
      { type: "workspace.runner.ready", generation: 1 },
    ]);
  },
);

test(
  "Unexpected Workspace runner exit starts one replacement",
  async () => {
    const firstRunner = fakeRunner();
    const secondRunner = fakeRunner();
    const replacementHealth = deferred();
    const runners = [firstRunner, secondRunner];
    let starts = 0;
    let waits = 0;
    const fatalExitCodes: number[] = [];
    const readiness = createWorkspaceRunnerReadiness({
      startRunner: () => {
        const runner = runners[starts];
        starts += 1;
        assert.ok(runner);
        return runner;
      },
      waitUntilHealthy: () => {
        waits += 1;
        return waits === 1 ? Promise.resolve() : replacementHealth.promise;
      },
      probeHealth: async () => {},
      onFatalExit(code) {
        fatalExitCodes.push(code);
      },
      log() {},
    });

    await readiness.ensureReady();
    firstRunner.emit("exit", 0);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 503,
      code: "WORKSPACE_RUNNER_STARTING",
    });
    assert.equal(starts, 2);
    assert.deepEqual(fatalExitCodes, []);

    replacementHealth.resolve();
    await readiness.ensureReady();
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 200,
      code: null,
    });
  },
);

test(
  "Workspace runner health recovers inside the grace period without replacement",
  async () => {
    const recoveryHealth = deferred();
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
        return waits === 1 ? Promise.resolve() : recoveryHealth.promise;
      },
      probeHealth: async () => {
        throw new Error("runner unavailable");
      },
      onFatalExit() {},
      log() {},
    });

    await readiness.ensureReady();
    await assert.rejects(readiness.probeReady(), /runner unavailable/u);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 503,
      code: "WORKSPACE_RUNNER_UNAVAILABLE",
    });

    recoveryHealth.resolve();
    await readiness.ensureReady();
    assert.equal(starts, 1);
    assert.equal(waits, 2);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 200,
      code: null,
    });
  },
);

test(
  "Sustained Workspace health loss replaces the runner exactly once",
  async () => {
    const firstRunner = new EventEmitter() as WorkspaceRunnerProcess;
    const secondRunner = fakeRunner();
    const signals: string[] = [];
    firstRunner.kill = (signal) => {
      signals.push(signal);
      queueMicrotask(() => firstRunner.emit("exit", 0));
      return true;
    };
    const events: WorkspaceRunnerReadinessEvent[] = [];
    const runners = [firstRunner, secondRunner];
    const replacementHealth = deferred();
    let starts = 0;
    let waits = 0;
    const readiness = createWorkspaceRunnerReadiness({
      startRunner: () => {
        const runner = runners[starts];
        starts += 1;
        assert.ok(runner);
        return runner;
      },
      waitUntilHealthy: () => {
        waits += 1;
        if (waits === 1) return Promise.resolve();
        if (waits === 2) return Promise.reject(new Error("grace expired"));
        return replacementHealth.promise;
      },
      probeHealth: async () => {
        throw new Error("runner unavailable");
      },
      onFatalExit() {},
      log: (event) => events.push(event),
    });

    await readiness.ensureReady();
    await assert.rejects(readiness.probeReady(), /runner unavailable/u);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(starts, 2);
    assert.deepEqual(signals, ["SIGTERM"]);
    const recoveryRequests = [readiness.ensureReady(), readiness.ensureReady()];
    assert.equal(recoveryRequests[0], recoveryRequests[1]);

    replacementHealth.resolve();
    await Promise.all(recoveryRequests);
    assert.deepEqual(workspaceRunnerHealthStatus(readiness.state()), {
      status: 200,
      code: null,
    });
    assert.equal(
      events.filter((event) => event.type === "workspace.runner.replacing")
        .length,
      1,
    );
  },
);

test("Failed replacement startup escalates to one fatal Machine restart", async () => {
  const firstRunner = new EventEmitter() as WorkspaceRunnerProcess;
  const secondRunner = fakeRunner();
  firstRunner.kill = () => {
    queueMicrotask(() => firstRunner.emit("exit", 0));
    return true;
  };
  const runners = [firstRunner, secondRunner];
  const fatalExitCodes: number[] = [];
  let starts = 0;
  let waits = 0;
  const readiness = createWorkspaceRunnerReadiness({
    startRunner: () => {
      const runner = runners[starts];
      starts += 1;
      assert.ok(runner);
      return runner;
    },
    waitUntilHealthy: () => {
      waits += 1;
      return waits === 1
        ? Promise.resolve()
        : Promise.reject(new Error("runner unavailable"));
    },
    probeHealth: async () => {
      throw new Error("runner unavailable");
    },
    onFatalExit: (code) => fatalExitCodes.push(code),
    log() {},
  });

  await readiness.ensureReady();
  await assert.rejects(readiness.probeReady(), /runner unavailable/u);
  await assert.rejects(readiness.ensureReady(), /runner unavailable/u);
  assert.equal(starts, 2);
  assert.deepEqual(fatalExitCodes, [1]);
});

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
  "Workspace shutdown escalates once after the graceful timeout without waiting forever",
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
      generation: 1,
    });

    await stopping;
  },
);

test("a runner that ignores SIGKILL triggers one fatal fallback and no competing replacement", async () => {
  const runner = new EventEmitter() as WorkspaceRunnerProcess;
  const signals: string[] = [];
  const fatalExitCodes: number[] = [];
  let starts = 0;
  let waits = 0;
  runner.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const readiness = createWorkspaceRunnerReadiness({
    startRunner: () => {
      starts += 1;
      return runner;
    },
    waitUntilHealthy: () => {
      waits += 1;
      return waits === 1
        ? Promise.resolve()
        : Promise.reject(new Error("runner unavailable"));
    },
    probeHealth: async () => {
      throw new Error("runner unavailable");
    },
    onFatalExit: (code) => fatalExitCodes.push(code),
    log() {},
    recoveryStopTimeoutMs: 5,
  });

  await readiness.ensureReady();
  await assert.rejects(readiness.probeReady(), /runner unavailable/u);
  await assert.rejects(
    readiness.ensureReady(),
    /escalating to Machine restart/u,
  );

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(fatalExitCodes, [1]);
  assert.equal(starts, 1);
});

for (const readyAtMs of [122_000, 299_000]) {
  test(`Workspace runner recovery remains retryable until ${readyAtMs / 1000} seconds`, async () => {
    let nowMs = 0;
    const ready = await waitForWorkspaceRunnerHealth({
      probe: async () => {
        if (nowMs < readyAtMs) throw new Error("store is recovering");
      },
      now: () => nowMs,
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
      pollIntervalMs: 1_000,
    });

    assert.equal(ready, true);
    assert.equal(nowMs, readyAtMs);
  });
}

test("Workspace runner recovery fails closed at its 300 second deadline", async () => {
  let nowMs = 0;
  const ready = await waitForWorkspaceRunnerHealth({
    probe: async () => {
      throw new Error("store is still recovering");
    },
    now: () => nowMs,
    sleep: async (delayMs) => {
      nowMs += delayMs;
    },
    pollIntervalMs: 1_000,
  });

  assert.equal(ready, false);
  assert.equal(nowMs, 300_000);
});

test("Workspace runner recovery bounds a never-resolving health probe", async () => {
  const startedAt = Date.now();
  const ready = await waitForWorkspaceRunnerHealth({
    probe: async () => await new Promise<never>(() => {}),
    timeoutMs: 5,
    probeTimeoutMs: 5,
  });

  assert.equal(ready, false);
  assert.ok(Date.now() - startedAt < 100);
});
