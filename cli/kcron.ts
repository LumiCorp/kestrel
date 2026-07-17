#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";

import { WorkspaceStore } from "./workspace/WorkspaceStore.js";
import { resolveWorkspaceFromBinding } from "./workspace/WorkspaceResolver.js";
import { KcronStateStore, type KcronStateFile, } from "./kcron/state.js";
import { installManagedService, uninstallManagedService } from "./kcron/service.js";
import { ensureCliLocalCoreReady, formatCliLocalCoreStatus } from "./localCoreShell.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  const [command = "status"] = process.argv.slice(2);
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`kcron ${readSuiteVersion()}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(formatKcronHelp());
    return;
  }
  const localCoreStatus = await ensureCliLocalCoreReady();
  const home = localCoreStatus.home.homePath;
  const workspaceStore = new WorkspaceStore(home);
  const stateStore = new KcronStateStore(home);

  if (command === "run-once") {
    await evaluateRegisteredWorkspaces(stateStore, workspaceStore);
    process.stdout.write("kcron run-once completed.\n");
    return;
  }

  if (command === "status") {
    const state = await stateStore.load();
    process.stdout.write(formatStatus(state, localCoreStatus));
    return;
  }

  if (command === "stop") {
    const state = await stateStore.load();
    const pid = state.daemon?.pid;
    if (pid === undefined || isPidRunning(pid) === false) {
      process.stdout.write("kcron is not running.\n");
      return;
    }
    process.kill(pid, "SIGTERM");
    process.stdout.write(`Stopped kcron pid=${pid}.\n`);
    return;
  }

  if (command === "install") {
    const filePath = await installManagedService({
      command: realpathSync(process.argv[1] ?? "kcron"),
      homeDir: home,
      ...(localCoreStatus.home.source !== "isolated_dev_home"
        ? { coreHomeDir: localCoreStatus.home.homePath }
        : {}),
    });
    process.stdout.write(`Installed kcron service at '${filePath}'.\n`);
    return;
  }

  if (command === "uninstall") {
    const filePath = await uninstallManagedService();
    process.stdout.write(`Uninstalled kcron service '${filePath}'.\n`);
    return;
  }

  if (command === "start") {
    await startDaemon(stateStore, workspaceStore, localCoreStatus);
    return;
  }

  throw new Error("Usage: kcron <start|stop|status|run-once|install|uninstall>");
}

function formatKcronHelp(): string {
  return [
    "Usage: kcron <start|stop|status|run-once|install|uninstall>",
    "",
    "kcron is beta local automation in Kestrel v0.5.",
    "",
    "Commands:",
    "  status",
    "  run-once",
    "  start",
    "  stop",
    "  install",
    "  uninstall",
    "",
    "Options:",
    "  --version",
    "  --help",
    "",
  ].join("\n");
}

function readSuiteVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  return typeof manifest.version === "string" && manifest.version.trim().length > 0
    ? manifest.version
    : "unknown";
}

async function startDaemon(
  stateStore: KcronStateStore,
  workspaceStore: WorkspaceStore,
  localCoreStatus: Awaited<ReturnType<typeof ensureCliLocalCoreReady>>,
): Promise<void> {
  if (localCoreStatus.client !== undefined) {
    const lease = await localCoreStatus.client.postJson("/v1/kcron/lease/acquire", { ownerPid: process.pid }) as {
      ok?: boolean | undefined;
      acquired?: boolean | undefined;
      reason?: string | undefined;
    };
    if (lease.acquired !== true) {
      throw new Error(lease.reason ?? "kcron could not acquire the Local Core lease.");
    }
  } else {
    const state = await stateStore.load();
    if (
      state.daemon?.pid !== undefined &&
      state.daemon.pid !== process.pid &&
      isPidRunning(state.daemon.pid)
    ) {
      throw new Error(`kcron is already running with pid ${state.daemon.pid}.`);
    }

    state.daemon = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    await stateStore.save(state);
  }

  const shutdown = async () => {
    if (localCoreStatus.client !== undefined) {
      await localCoreStatus.client.postJson("/v1/kcron/lease/release", { ownerPid: process.pid });
    } else {
      const latest = await stateStore.load();
      if (latest.daemon?.pid === process.pid) {
        delete latest.daemon;
        await stateStore.save(latest);
      }
    }
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await evaluateRegisteredWorkspaces(stateStore, workspaceStore);
  const heartbeat = setInterval(() => {
    if (localCoreStatus.client !== undefined) {
      void localCoreStatus.client.postJson("/v1/kcron/lease/heartbeat", { ownerPid: process.pid }).catch((error) => {
        process.stderr.write(`[kcron] lease heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
  }, DEFAULT_POLL_INTERVAL_MS);
  heartbeat.unref?.();
  const timer = setInterval(() => {
    void evaluateRegisteredWorkspaces(stateStore, workspaceStore).catch((error) => {
      process.stderr.write(`[kcron] ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, DEFAULT_POLL_INTERVAL_MS);
  timer.unref?.();

  await new Promise<void>(() => {});
}

async function evaluateRegisteredWorkspaces(
  stateStore: KcronStateStore,
  workspaceStore: WorkspaceStore,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const workspaces = await workspaceStore.load();
  const state = await stateStore.load();

  for (const entry of workspaces.workspaces) {
    const current = state.workspaces[entry.workspaceId] ?? {
      workspaceId: entry.workspaceId,
      rootPath: entry.rootPath,
    };
    if (entry.automationEnabled !== true) {
      state.workspaces[entry.workspaceId] = {
        ...current,
        rootPath: entry.rootPath,
        lastEvaluatedAt: nowIso,
        lastOutcome: "disabled",
        lastError: undefined,
        nextRunAt: undefined,
        runningPid: undefined,
        runningStartedAt: undefined,
      };
      continue;
    }
    const resolved = await resolveWorkspaceFromBinding({
      workspaceId: entry.workspaceId,
      workspaceRoot: entry.rootPath,
    }, workspaceStore);
    if (resolved.workspace === undefined) {
      state.workspaces[entry.workspaceId] = {
        ...current,
        rootPath: entry.rootPath,
        lastEvaluatedAt: nowIso,
        lastOutcome: "stale",
        lastError: resolved.notices.join(" | ") || "Workspace binding is stale.",
      };
      continue;
    }

    state.workspaces[entry.workspaceId] = {
      ...current,
      rootPath: resolved.workspace.rootPath,
      lastEvaluatedAt: nowIso,
      lastOutcome: "deferred",
      lastError: "Workspace automation is deferred until the central scheduler model is implemented.",
      nextRunAt: undefined,
      runningPid: undefined,
      runningStartedAt: undefined,
    };
  }

  await stateStore.save(state);
}

function formatStatus(
  state: KcronStateFile,
  localCoreStatus: Awaited<ReturnType<typeof ensureCliLocalCoreReady>>,
): string {
  const lines = [
    formatCliLocalCoreStatus(localCoreStatus).trimEnd(),
    `kcron: ${state.daemon?.pid !== undefined ? `running pid=${state.daemon.pid}` : "stopped"}`,
  ];
  for (const workspace of Object.values(state.workspaces).sort((left, right) => left.rootPath.localeCompare(right.rootPath))) {
    lines.push(
      [
        `${workspace.workspaceId}`,
        workspace.rootPath,
        `outcome=${workspace.lastOutcome ?? "unknown"}`,
        ...(workspace.nextRunAt !== undefined ? [`next=${workspace.nextRunAt}`] : []),
        ...(workspace.runningPid !== undefined ? [`runningPid=${workspace.runningPid}`] : []),
      ].join(" "),
    );
  }
  return `${lines.join("\n")}\n`;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
