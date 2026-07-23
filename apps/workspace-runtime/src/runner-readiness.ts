export type WorkspaceRunnerReadinessEvent =
  | { type: "workspace.runner.starting" }
  | { type: "workspace.runner.ready" }
  | {
      type: "workspace.runner.failed";
      reason: "health" | "exit";
      exitCode?: number | null;
    };

export type WorkspaceRunnerReadinessState =
  | "idle"
  | "starting"
  | "ready"
  | "failed"
  | "stopping";

export interface WorkspaceRunnerProcess {
  kill(signal: "SIGTERM"): boolean;
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
}) {
  let runner: WorkspaceRunnerProcess | null = null;
  let ready: Promise<void> | null = null;
  let healthProbe: Promise<void> | null = null;
  let generation = 0;
  let state: WorkspaceRunnerReadinessState = "idle";

  const transition = (
    next: typeof state,
    event?: WorkspaceRunnerReadinessEvent,
  ) => {
    if (state === next) return;
    state = next;
    if (event) input.log(event);
  };

  const ensureReady = () => {
    if (!runner) {
      generation += 1;
      const runnerGeneration = generation;
      runner = input.startRunner();
      transition("starting", { type: "workspace.runner.starting" });
      const startedRunner = runner;
      startedRunner.once("exit", (code) => {
        if (runner !== startedRunner || generation !== runnerGeneration) return;
        runner = null;
        ready = null;
        healthProbe = null;
        transition("failed", {
          type: "workspace.runner.failed",
          reason: "exit",
          exitCode: code,
        });
        if (state !== "stopping" && code !== 0) {
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
      transition("stopping");
      generation += 1;
      ready = null;
      healthProbe = null;
      const activeRunner = runner;
      runner = null;
      activeRunner?.kill("SIGTERM");
    },
  };
}
