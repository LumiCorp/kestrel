export type WorkspaceRunnerReadinessEvent =
  | { type: "workspace.runner.starting" }
  | { type: "workspace.runner.ready" }
  | {
      type: "workspace.runner.failed";
      reason: "health" | "exit" | "shutdown_timeout";
      exitCode?: number | null;
    };

export type WorkspaceRunnerReadinessState =
  | "idle"
  | "starting"
  | "ready"
  | "failed"
  | "stopping";

export interface WorkspaceRunnerProcess {
  kill(signal: "SIGTERM" | "SIGKILL"): boolean;
  once(event: "exit", listener: (code: number | null) => void): this;
}

export function workspaceRunnerHealthStatus(
  state: WorkspaceRunnerReadinessState,
):
  | { status: 200; code: null }
  | {
      status: 503;
      code: "WORKSPACE_RUNNER_STARTING" | "WORKSPACE_RUNNER_UNAVAILABLE";
    } {
  if (state === "ready") return { status: 200, code: null };
  return {
    status: 503,
    code:
      state === "failed"
        ? "WORKSPACE_RUNNER_UNAVAILABLE"
        : "WORKSPACE_RUNNER_STARTING",
  };
}

export function createWorkspaceRunnerReadiness(input: {
  startRunner: () => WorkspaceRunnerProcess;
  waitUntilHealthy: () => Promise<void>;
  probeHealth: () => Promise<void>;
  onFatalExit: (code: number) => void;
  log: (event: WorkspaceRunnerReadinessEvent) => void;
  shutdownTimeoutMs?: number | undefined;
}) {
  let runner: WorkspaceRunnerProcess | null = null;
  let ready: Promise<void> | null = null;
  let healthProbe: Promise<void> | null = null;
  let generation = 0;
  let state: WorkspaceRunnerReadinessState = "idle";
  let runnerExit: Promise<void> | null = null;
  let resolveRunnerExit: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;

  const transition = (
    next: typeof state,
    event?: WorkspaceRunnerReadinessEvent,
  ) => {
    if (state === next) return;
    state = next;
    if (event) input.log(event);
  };

  const ensureReady = () => {
    if (state === "stopping") {
      return Promise.reject(new Error("Workspace runner is stopping."));
    }
    if (!runner) {
      generation += 1;
      const runnerGeneration = generation;
      runner = input.startRunner();
      runnerExit = new Promise<void>((resolve) => {
        resolveRunnerExit = resolve;
      });
      transition("starting", { type: "workspace.runner.starting" });
      const startedRunner = runner;
      const resolveStartedRunnerExit = resolveRunnerExit;
      startedRunner.once("exit", (code) => {
        resolveStartedRunnerExit?.();
        if (runner !== startedRunner || generation !== runnerGeneration) return;
        const exitedWhileStopping = state === "stopping";
        runner = null;
        runnerExit = null;
        resolveRunnerExit = null;
        ready = null;
        healthProbe = null;
        if (exitedWhileStopping) return;
        transition("failed", {
          type: "workspace.runner.failed",
          reason: "exit",
          exitCode: code,
        });
        if (code !== 0) {
          input.onFatalExit(code ?? 1);
        }
      });
    }
    if (!ready) {
      const readinessGeneration = generation;
      const readiness = input.waitUntilHealthy().then(
        () => {
          if (generation === readinessGeneration && runner) {
            transition("ready", { type: "workspace.runner.ready" });
          }
        },
        (error: unknown) => {
          if (generation === readinessGeneration) {
            ready = null;
            transition("failed", {
              type: "workspace.runner.failed",
              reason: "health",
            });
          }
          throw error;
        },
      );
      ready = readiness;
    }
    return ready;
  };

  const probeReady = () => {
    if (state !== "ready") return Promise.resolve();
    if (!healthProbe) {
      const probeGeneration = generation;
      const probe = input.probeHealth().catch((error: unknown) => {
        if (
          generation === probeGeneration &&
          runner &&
          state === "ready"
        ) {
          ready = null;
          transition("failed", {
            type: "workspace.runner.failed",
            reason: "health",
          });
        }
        throw error;
      });
      const trackedProbe = probe.finally(() => {
        if (healthProbe === trackedProbe) healthProbe = null;
      });
      healthProbe = trackedProbe;
    }
    return healthProbe;
  };

  return {
    ensureReady,
    probeReady,
    state: () => state,
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        transition("stopping");
        generation += 1;
        ready = null;
        healthProbe = null;
        const activeRunner = runner;
        const activeRunnerExit = runnerExit;
        if (!(activeRunner && activeRunnerExit)) return;

        activeRunner.kill("SIGTERM");
        const exitedGracefully = await waitForRunnerExit(
          activeRunnerExit,
          input.shutdownTimeoutMs ?? 110_000,
        );
        if (!exitedGracefully) {
          input.log({
            type: "workspace.runner.failed",
            reason: "shutdown_timeout",
          });
          activeRunner.kill("SIGKILL");
          await activeRunnerExit;
        }
        if (runner === activeRunner) {
          runner = null;
          runnerExit = null;
          resolveRunnerExit = null;
        }
      })();
      return stopPromise;
    },
  };
}

function waitForRunnerExit(
  runnerExit: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref();
    void runnerExit.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}
