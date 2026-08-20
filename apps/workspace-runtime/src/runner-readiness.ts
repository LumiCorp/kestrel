import {
  WORKSPACE_RUNNER_HEALTH_PROBE_TIMEOUT_MS,
  WORKSPACE_RUNNER_RECOVERY_GRACE_MS,
  WORKSPACE_RUNNER_RECOVERY_STOP_TIMEOUT_MS,
  WORKSPACE_RUNNER_STARTUP_TIMEOUT_MS,
} from "@lumi/kestrel-environment-auth";

export type WorkspaceRunnerReadinessEvent =
  | { type: "workspace.runner.starting"; generation: number }
  | {
      type: "workspace.runner.ready";
      generation: number;
      recoveryReason?: "health" | "exit" | undefined;
      recoveryDurationMs?: number | undefined;
    }
  | {
      type: "workspace.runner.failed";
      reason: "health" | "exit" | "shutdown_timeout";
      generation: number;
      exitCode?: number | null;
    }
  | {
      type:
        | "workspace.runner.recovering"
        | "workspace.runner.replacing"
        | "workspace.runner.escalated";
      reason: "health" | "exit";
      generation: number;
      durationMs: number;
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

export async function waitForWorkspaceRunnerHealth(input: {
  probe: (signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number | undefined;
  probeTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((delayMs: number) => Promise<void>) | undefined;
}): Promise<boolean> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() +
    (input.timeoutMs ?? WORKSPACE_RUNNER_STARTUP_TIMEOUT_MS);
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  while (now() < deadline) {
    const remainingBeforeProbeMs = deadline - now();
    if (remainingBeforeProbeMs <= 0) break;
    try {
      await probeWithTimeout(
        input.probe,
        Math.min(
          input.probeTimeoutMs ?? WORKSPACE_RUNNER_HEALTH_PROBE_TIMEOUT_MS,
          remainingBeforeProbeMs,
        ),
      );
      return true;
    } catch {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }
  }
  return false;
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
  waitUntilHealthy: (timeoutMs?: number | undefined) => Promise<void>;
  probeHealth: () => Promise<void>;
  onFatalExit: (code: number) => void;
  log: (event: WorkspaceRunnerReadinessEvent) => void;
  shutdownTimeoutMs?: number | undefined;
  recoveryGraceMs?: number | undefined;
  recoveryStopTimeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}) {
  type RunnerContext = {
    process: WorkspaceRunnerProcess;
    generation: number;
    exited: Promise<number | null>;
  };

  const now = input.now ?? Date.now;
  let runner: RunnerContext | null = null;
  let ready: Promise<void> | null = null;
  let healthProbe: Promise<void> | null = null;
  let recovery: Promise<void> | null = null;
  let generation = 0;
  let state: WorkspaceRunnerReadinessState = "idle";
  let stopPromise: Promise<void> | null = null;
  let fatalExitRequested = false;
  const runnerStops = new Map<WorkspaceRunnerProcess, Promise<void>>();

  const transition = (
    next: typeof state,
    event?: WorkspaceRunnerReadinessEvent,
  ) => {
    if (state === next) return;
    state = next;
    if (event) input.log(event);
  };
  const isStopping = () => state === "stopping";

  const requestFatalExit = (code: number) => {
    if (fatalExitRequested || state === "stopping") return;
    fatalExitRequested = true;
    input.onFatalExit(code === 0 ? 1 : code);
  };

  const stopRunner = (context: RunnerContext, timeoutMs: number) => {
    const existing = runnerStops.get(context.process);
    if (existing) return existing;
    const stopping = (async () => {
      context.process.kill("SIGTERM");
      const exitedGracefully = await waitForRunnerExit(
        context.exited.then(() => undefined),
        timeoutMs,
      );
      if (!exitedGracefully) {
        input.log({
          type: "workspace.runner.failed",
          reason: "shutdown_timeout",
          generation: context.generation,
        });
        context.process.kill("SIGKILL");
        await context.exited;
      }
    })();
    runnerStops.set(context.process, stopping);
    return stopping;
  };

  const spawnRunner = (): RunnerContext => {
    generation += 1;
    const runnerGeneration = generation;
    const process = input.startRunner();
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const context = { process, generation: runnerGeneration, exited };
    runner = context;
    transition("starting", {
      type: "workspace.runner.starting",
      generation: runnerGeneration,
    });
    process.once("exit", (code) => {
      resolveExit(code);
      if (runner !== context) return;
      runner = null;
      healthProbe = null;
      const exitedWhileStopping = state === "stopping";
      if (exitedWhileStopping) return;
      transition("failed", {
        type: "workspace.runner.failed",
        reason: "exit",
        generation: runnerGeneration,
        exitCode: code,
      });
      if (!recovery) launchRecovery("exit", null);
    });
    return context;
  };

  const waitForContextHealth = async (
    context: RunnerContext,
    timeoutMs?: number,
  ) => {
    const outcome = await Promise.race([
      input.waitUntilHealthy(timeoutMs).then(() => "healthy" as const),
      context.exited.then(() => "exit" as const),
    ]);
    if (outcome !== "healthy" || runner !== context) {
      throw new Error("Workspace runner exited before becoming healthy.");
    }
  };

  const recover = async (
    reason: "health" | "exit",
    unhealthyRunner: RunnerContext | null,
    startedAt: number,
  ) => {
    const recoveryGeneration = unhealthyRunner?.generation ?? generation;
    input.log({
      type: "workspace.runner.recovering",
      reason,
      generation: recoveryGeneration,
      durationMs: 0,
    });

    if (reason === "health" && unhealthyRunner) {
      const recovered = await Promise.race([
        input
          .waitUntilHealthy(
            input.recoveryGraceMs ?? WORKSPACE_RUNNER_RECOVERY_GRACE_MS,
          )
          .then(() => true, () => false),
        unhealthyRunner.exited.then(() => false),
      ]);
      if (recovered && runner === unhealthyRunner && state !== "stopping") {
        transition("ready", {
          type: "workspace.runner.ready",
          generation: unhealthyRunner.generation,
          recoveryReason: reason,
          recoveryDurationMs: Math.max(0, now() - startedAt),
        });
        return;
      }
    }

    if (isStopping()) return;
    input.log({
      type: "workspace.runner.replacing",
      reason,
      generation: recoveryGeneration,
      durationMs: Math.max(0, now() - startedAt),
    });
    if (unhealthyRunner) {
      if (runner === unhealthyRunner) runner = null;
      await stopRunner(
        unhealthyRunner,
        input.recoveryStopTimeoutMs ??
          WORKSPACE_RUNNER_RECOVERY_STOP_TIMEOUT_MS,
      );
    }
    if (isStopping()) return;

    const replacement = spawnRunner();
    try {
      await waitForContextHealth(replacement);
      transition("ready", {
        type: "workspace.runner.ready",
        generation: replacement.generation,
        recoveryReason: reason,
        recoveryDurationMs: Math.max(0, now() - startedAt),
      });
    } catch (error) {
      transition("failed", {
        type: "workspace.runner.failed",
        reason: "health",
        generation: replacement.generation,
      });
      input.log({
        type: "workspace.runner.escalated",
        reason,
        generation: replacement.generation,
        durationMs: Math.max(0, now() - startedAt),
      });
      requestFatalExit(1);
      throw error;
    }
  };

  function launchRecovery(
    reason: "health" | "exit",
    unhealthyRunner: RunnerContext | null,
  ) {
    if (recovery) return recovery;
    const startedAt = now();
    const task = recover(reason, unhealthyRunner, startedAt);
    const tracked = task.finally(() => {
      if (recovery === tracked) recovery = null;
    });
    recovery = tracked;
    ready = tracked;
    void tracked.catch(() => {});
    return tracked;
  }

  const ensureReady = () => {
    if (state === "stopping") {
      return Promise.reject(new Error("Workspace runner is stopping."));
    }
    if (fatalExitRequested) {
      return Promise.reject(new Error("Workspace runner restart was escalated."));
    }
    if (recovery) return recovery;
    if (!runner) {
      spawnRunner();
    }
    if (!ready) {
      const startingRunner = runner;
      if (!startingRunner) {
        return Promise.reject(new Error("Workspace runner is unavailable."));
      }
      const readiness = waitForContextHealth(startingRunner).then(
        () => {
          if (runner === startingRunner) {
            transition("ready", {
              type: "workspace.runner.ready",
              generation: startingRunner.generation,
            });
          }
        },
        (error: unknown) => {
          if (recovery) return recovery;
          if (runner === startingRunner) {
            ready = null;
            transition("failed", {
              type: "workspace.runner.failed",
              reason: "health",
              generation: startingRunner.generation,
            });
            requestFatalExit(1);
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
      const probedRunner = runner;
      if (!probedRunner) return Promise.resolve();
      const probe = input.probeHealth().catch((error: unknown) => {
        if (
          runner === probedRunner &&
          state === "ready"
        ) {
          ready = null;
          transition("failed", {
            type: "workspace.runner.failed",
            reason: "health",
            generation: probedRunner.generation,
          });
          launchRecovery("health", probedRunner);
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
        if (!activeRunner) return;
        runner = null;
        await stopRunner(activeRunner, input.shutdownTimeoutMs ?? 110_000);
      })();
      return stopPromise;
    },
  };
}

async function probeWithTimeout(
  probe: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Workspace runner health probe timed out.");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    await Promise.race([probe(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
