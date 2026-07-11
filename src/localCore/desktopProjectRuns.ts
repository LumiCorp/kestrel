import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";

import type {
  DesktopManagedProjectRun,
  DesktopManagedProjectRunPreviewUrl,
  DesktopPackageManager,
  DesktopProjectLauncherDescriptor,
} from "../desktopShell/contracts.js";
import { redactDiagnosticText } from "../diagnostics/redaction.js";

const RUN_TAIL_LIMIT = 160;
const RECENT_RUN_LIMIT = 48;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/giu;
const URL_TRAILING_PUNCTUATION = /[),.;\]}]+$/u;

type SpawnImpl = typeof spawn;
type KillProcessImpl = (pid: number, signal: NodeJS.Signals) => void;
type ProjectRunChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface DesktopProjectRunError extends Error {
  code: string;
  details?: string | undefined;
}

export interface DesktopProjectRunLedger {
  readRuns(): Promise<DesktopManagedProjectRun[]>;
  writeRuns(runs: DesktopManagedProjectRun[]): Promise<void>;
}

function createDesktopError(input: {
  code: string;
  message: string;
  details?: string | undefined;
}): DesktopProjectRunError {
  const error = new Error(input.message) as DesktopProjectRunError;
  error.name = "DesktopProjectRunError";
  error.code = input.code;
  if (input.details !== undefined) {
    error.details = input.details;
  }
  return error;
}

type RunningProjectRun = {
  liveKey: string;
  snapshot: DesktopManagedProjectRun;
  child: ProjectRunChildProcess;
  stdoutReader: readline.Interface;
  stderrReader: readline.Interface;
  settled: boolean;
  stopRequested: boolean;
  forceKillTimer?: ReturnType<typeof setTimeout> | undefined;
  restartPromise?: Promise<DesktopManagedProjectRun> | undefined;
  settlePromise: Promise<DesktopManagedProjectRun>;
  settle: (run: DesktopManagedProjectRun) => void;
};

function createSettledPromise(): {
  promise: Promise<DesktopManagedProjectRun>;
  resolve: (run: DesktopManagedProjectRun) => void;
} {
  let resolve = (_run: DesktopManagedProjectRun) => {};
  const promise = new Promise<DesktopManagedProjectRun>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function cloneRun(run: DesktopManagedProjectRun): DesktopManagedProjectRun {
  return {
    ...run,
    ...(run.previewUrls !== undefined
      ? { previewUrls: run.previewUrls.map((entry) => ({ ...entry })) }
      : {}),
    stdoutTail: [...run.stdoutTail],
    stderrTail: [...run.stderrTail],
  };
}

export function createDesktopProjectRunLedger(input: {
  ledgerPath: string;
  limit?: number | undefined;
}): DesktopProjectRunLedger {
  const limit = input.limit ?? RECENT_RUN_LIMIT;
  return {
    async readRuns() {
      try {
        const parsed = JSON.parse(await readFile(input.ledgerPath, "utf8")) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return [];
        }
        const runs = (parsed as { runs?: unknown }).runs;
        return Array.isArray(runs)
          ? runs.map(parseLedgerRun).filter((run): run is DesktopManagedProjectRun => run !== undefined).map(settleHydratedRun).slice(0, limit)
          : [];
      } catch {
        return [];
      }
    },
    async writeRuns(runs) {
      const sanitized = runs
        .slice()
        .sort(compareRunsByStartDesc)
        .slice(0, limit)
        .map(sanitizeRunForLedger);
      await mkdir(path.dirname(input.ledgerPath), { recursive: true });
      await writeFile(input.ledgerPath, `${JSON.stringify({ version: 1, runs: sanitized }, null, 2)}\n`, "utf8");
    },
  };
}

function parseLedgerRun(value: unknown): DesktopManagedProjectRun | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.runId !== "string" ||
    typeof record.projectPath !== "string" ||
    typeof record.manifestPath !== "string" ||
    typeof record.scriptName !== "string" ||
    (record.packageManager !== "npm" && record.packageManager !== "pnpm") ||
    typeof record.command !== "string" ||
    typeof record.status !== "string" ||
    typeof record.startedAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return undefined;
  }
  if (
    record.status !== "running" &&
    record.status !== "stopping" &&
    record.status !== "completed" &&
    record.status !== "failed" &&
    record.status !== "stopped"
  ) {
    return undefined;
  }
  return {
    runId: record.runId,
    projectPath: record.projectPath,
    manifestPath: record.manifestPath,
    scriptName: record.scriptName,
    packageManager: record.packageManager,
    command: record.command,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
    ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
    ...(typeof record.stopSignal === "string" ? { stopSignal: record.stopSignal } : {}),
    ...(Array.isArray(record.previewUrls)
      ? { previewUrls: record.previewUrls.map(parseLedgerPreviewUrl).filter((entry): entry is DesktopManagedProjectRunPreviewUrl => entry !== undefined) }
      : {}),
    ...(typeof record.primaryPreviewUrl === "string" && isPreviewableHttpUrl(record.primaryPreviewUrl)
      ? { primaryPreviewUrl: record.primaryPreviewUrl }
      : {}),
    stdoutTail: Array.isArray(record.stdoutTail) ? record.stdoutTail.filter((line): line is string => typeof line === "string") : [],
    stderrTail: Array.isArray(record.stderrTail) ? record.stderrTail.filter((line): line is string => typeof line === "string") : [],
  };
}

function parseLedgerPreviewUrl(value: unknown): DesktopManagedProjectRunPreviewUrl | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.url !== "string" ||
    isPreviewableHttpUrl(record.url) === false ||
    (record.source !== "stdout" && record.source !== "stderr") ||
    typeof record.firstSeenAt !== "string" ||
    typeof record.lastSeenAt !== "string" ||
    typeof record.line !== "string" ||
    typeof record.count !== "number" ||
    Number.isFinite(record.count) === false ||
    record.count < 1
  ) {
    return undefined;
  }
  return {
    url: record.url,
    source: record.source,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    line: record.line,
    count: Math.floor(record.count),
  };
}

function settleHydratedRun(run: DesktopManagedProjectRun): DesktopManagedProjectRun {
  if (run.status !== "running" && run.status !== "stopping") {
    return run;
  }
  return {
    ...run,
    status: "stopped",
    pendingAction: undefined,
    completedAt: run.completedAt ?? run.updatedAt,
    stderrTail: appendTail(run.stderrTail, "Desktop restarted before this run completed."),
  };
}

function sanitizeRunForLedger(run: DesktopManagedProjectRun): DesktopManagedProjectRun {
  const previewUrls = run.previewUrls?.map((entry) => ({
    ...entry,
    url: redactDiagnosticText(entry.url).value,
    line: redactDiagnosticText(entry.line).value,
  }));
  return {
    ...run,
    projectPath: redactDiagnosticText(run.projectPath).value,
    manifestPath: redactDiagnosticText(run.manifestPath).value,
    command: redactDiagnosticText(run.command).value,
    ...(previewUrls !== undefined ? { previewUrls } : {}),
    ...(run.primaryPreviewUrl !== undefined
      ? { primaryPreviewUrl: redactDiagnosticText(run.primaryPreviewUrl).value }
      : {}),
    stdoutTail: run.stdoutTail.map((line) => redactDiagnosticText(line).value),
    stderrTail: run.stderrTail.map((line) => redactDiagnosticText(line).value),
  };
}

function appendTail(existing: string[], line: string): string[] {
  const normalized = line.trimEnd();
  if (normalized.length === 0) {
    return existing;
  }
  const next = [...existing, normalized];
  return next.length > RUN_TAIL_LIMIT ? next.slice(next.length - RUN_TAIL_LIMIT) : next;
}

function extractPreviewUrlsFromLine(line: string): string[] {
  const urls: string[] = [];
  for (const match of line.matchAll(HTTP_URL_PATTERN)) {
    const rawUrl = match[0].replace(URL_TRAILING_PUNCTUATION, "");
    if (isPreviewableHttpUrl(rawUrl)) {
      urls.push(new URL(rawUrl).href);
    }
  }
  return urls;
}

function isPreviewableHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0;
  } catch {
    return false;
  }
}

function appendPreviewUrls(
  existing: DesktopManagedProjectRunPreviewUrl[] | undefined,
  input: {
    line: string;
    source: "stdout" | "stderr";
    observedAt: string;
  },
): {
  previewUrls?: DesktopManagedProjectRunPreviewUrl[] | undefined;
  primaryPreviewUrl?: string | undefined;
} {
  const urls = extractPreviewUrlsFromLine(input.line);
  if (urls.length === 0) {
    return {
      ...(existing !== undefined ? { previewUrls: existing } : {}),
    };
  }
  const next = existing?.map((entry) => ({ ...entry })) ?? [];
  let primaryPreviewUrl: string | undefined;
  for (const url of urls) {
    primaryPreviewUrl = url;
    const existingIndex = next.findIndex((entry) => entry.url === url);
    if (existingIndex === -1) {
      next.push({
        url,
        source: input.source,
        firstSeenAt: input.observedAt,
        lastSeenAt: input.observedAt,
        line: input.line.trimEnd(),
        count: 1,
      });
      continue;
    }
    const current = next[existingIndex]!;
    next[existingIndex] = {
      ...current,
      source: input.source,
      lastSeenAt: input.observedAt,
      line: input.line.trimEnd(),
      count: current.count + 1,
    };
  }
  return {
    previewUrls: next,
    ...(primaryPreviewUrl !== undefined ? { primaryPreviewUrl } : {}),
  };
}

function compareRunsByStartDesc(left: DesktopManagedProjectRun, right: DesktopManagedProjectRun): number {
  return right.startedAt.localeCompare(left.startedAt);
}

function createLiveRunKey(projectPath: string, scriptName: string): string {
  return `${projectPath}::${scriptName}`;
}

function supportsDetachedProcessGroups(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

function resolvePackageManagerCommand(
  packageManager: DesktopPackageManager,
  platform: NodeJS.Platform,
): string {
  return platform === "win32" ? `${packageManager}.cmd` : packageManager;
}

function normalizePackageManagerField(value: unknown): {
  packageManager?: DesktopPackageManager | undefined;
  unsupportedPackageManager?: string | undefined;
} {
  if (typeof value !== "string") {
    return {};
  }
  const trimmed = value.trim();
  if (trimmed === "npm" || trimmed.startsWith("npm@")) {
    return { packageManager: "npm" };
  }
  if (trimmed === "pnpm" || trimmed.startsWith("pnpm@")) {
    return { packageManager: "pnpm" };
  }
  return trimmed.length > 0 ? { unsupportedPackageManager: trimmed } : {};
}

export async function readProjectLauncherDescriptor(input: {
  projectPath: string;
  packageManagerOverride?: DesktopPackageManager | undefined;
}): Promise<DesktopProjectLauncherDescriptor | undefined> {
  const projectPath = path.resolve(input.projectPath);
  const manifestPath = path.join(projectPath, "package.json");
  try {
    const manifestStat = await stat(manifestPath);
    if (manifestStat.isFile() === false) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw createDesktopError({
      code: "desktop.invalid_package_json",
      message: "The project package.json could not be parsed.",
      details: error instanceof Error ? error.message : String(error),
    });
  }

  const scriptsValue = parsed.scripts;
  const scripts = typeof scriptsValue === "object" && scriptsValue !== null && Array.isArray(scriptsValue) === false
    ? Object.entries(scriptsValue)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
        .map(([name, command]) => ({
          name,
          command,
        }))
    : [];
  if (scripts.length === 0) {
    return undefined;
  }

  const normalizedPackageManager = normalizePackageManagerField(parsed.packageManager);
  const packageManager = normalizedPackageManager.packageManager ?? input.packageManagerOverride;

  return {
    projectPath,
    manifestPath,
    scripts,
    ...(packageManager !== undefined ? { packageManager } : {}),
    packageManagerSelectionRequired: normalizedPackageManager.packageManager === undefined
      && normalizedPackageManager.unsupportedPackageManager === undefined
      && input.packageManagerOverride === undefined,
    ...(normalizedPackageManager.unsupportedPackageManager !== undefined
      ? { unsupportedPackageManager: normalizedPackageManager.unsupportedPackageManager }
      : {}),
  };
}

export class DesktopProjectRunRegistry {
  private readonly runningById = new Map<string, RunningProjectRun>();
  private readonly liveRunIdByKey = new Map<string, string>();
  private recentRuns: DesktopManagedProjectRun[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPending = false;
  private readonly ledgerWrites = new Set<Promise<void>>();

  constructor(
    private readonly options: {
      spawnImpl?: SpawnImpl | undefined;
      killProcessImpl?: KillProcessImpl | undefined;
      onRunsChanged?: ((runs: DesktopManagedProjectRun[]) => void) | undefined;
      ledger?: DesktopProjectRunLedger | undefined;
      now?: (() => Date) | undefined;
      platform?: NodeJS.Platform | undefined;
      stopTimeoutMs?: number | undefined;
      flushIntervalMs?: number | undefined;
    } = {},
  ) {}

  async readProjectLauncher(input: {
    projectPath: string;
    packageManagerOverride?: DesktopPackageManager | undefined;
  }): Promise<DesktopProjectLauncherDescriptor | undefined> {
    return readProjectLauncherDescriptor(input);
  }

  async hydrate(): Promise<void> {
    if (this.options.ledger === undefined) {
      return;
    }
    this.recentRuns = (await this.options.ledger.readRuns()).slice(0, RECENT_RUN_LIMIT);
    void this.emitChange({ immediate: true });
  }

  listRuns(): DesktopManagedProjectRun[] {
    return this.snapshotRuns();
  }

  hasActiveRuns(): boolean {
    return [...this.runningById.values()].some((run) => run.settled === false);
  }

  resolvePreviewUrl(input: {
    runId: string;
    url?: string | undefined;
  }): {
    run: DesktopManagedProjectRun;
    url: string;
  } {
    const run = this.findRun(input.runId);
    if (run === undefined) {
      throw createDesktopError({
        code: "desktop.project_run_not_found",
        message: "The selected project run no longer exists.",
      });
    }
    const requestedUrl = input.url ?? run.primaryPreviewUrl;
    if (typeof requestedUrl !== "string" || requestedUrl.trim().length === 0) {
      throw createDesktopError({
        code: "desktop.project_run_preview_url_missing",
        message: "The selected project run has not emitted a preview URL.",
      });
    }
    if (isPreviewableHttpUrl(requestedUrl) === false) {
      throw createDesktopError({
        code: "desktop.invalid_project_run_preview_url",
        message: "Project run previews require an http(s) URL without embedded credentials.",
      });
    }
    const matchedUrl = run.previewUrls?.find((entry) => entry.url === requestedUrl)?.url;
    if (matchedUrl === undefined) {
      throw createDesktopError({
        code: "desktop.project_run_preview_url_not_recorded",
        message: "Project run previews can only open URLs emitted by that managed run.",
      });
    }
    return {
      run: cloneRun(run),
      url: matchedUrl,
    };
  }

  async startRun(input: {
    projectPath: string;
    scriptName: string;
    packageManagerOverride?: DesktopPackageManager | undefined;
  }): Promise<DesktopManagedProjectRun> {
    const descriptor = await readProjectLauncherDescriptor({
      projectPath: input.projectPath,
      packageManagerOverride: input.packageManagerOverride,
    });
    if (descriptor === undefined) {
      throw createDesktopError({
        code: "desktop.project_launcher_unavailable",
        message: "This project does not expose root package.json scripts.",
      });
    }
    if (descriptor.packageManager === undefined) {
      if (descriptor.unsupportedPackageManager !== undefined) {
        throw createDesktopError({
          code: "desktop.unsupported_package_manager",
          message: `Unsupported package manager '${descriptor.unsupportedPackageManager}'.`,
        });
      }
      throw createDesktopError({
        code: "desktop.package_manager_required",
        message: "Choose npm or pnpm before running this script.",
      });
    }
    const script = descriptor.scripts.find((entry) => entry.name === input.scriptName);
    if (script === undefined) {
      throw createDesktopError({
        code: "desktop.script_not_found",
        message: `Script '${input.scriptName}' was not found in the project package.json.`,
      });
    }

    const liveKey = createLiveRunKey(descriptor.projectPath, script.name);
    const activeRun = this.findActiveRunByKey(liveKey);
    if (activeRun !== undefined) {
      return cloneRun(activeRun.snapshot);
    }

    const runId = randomUUID();
    const startedAt = this.now().toISOString();
    const command = `${descriptor.packageManager} run ${script.name}`;
    const child = (this.options.spawnImpl ?? spawn)(
      resolvePackageManagerCommand(descriptor.packageManager, this.platform()),
      ["run", script.name],
      {
      cwd: descriptor.projectPath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(supportsDetachedProcessGroups(this.platform()) ? { detached: true } : {}),
      },
    );
    const settled = createSettledPromise();
    const snapshot: DesktopManagedProjectRun = {
      runId,
      projectPath: descriptor.projectPath,
      manifestPath: descriptor.manifestPath,
      scriptName: script.name,
      packageManager: descriptor.packageManager,
      command,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      stdoutTail: [],
      stderrTail: [],
    };
    const running: RunningProjectRun = {
      liveKey,
      snapshot,
      child,
      stdoutReader: readline.createInterface({ input: child.stdout, terminal: false }),
      stderrReader: readline.createInterface({ input: child.stderr, terminal: false }),
      settled: false,
      stopRequested: false,
      settlePromise: settled.promise,
      settle: settled.resolve,
    };

    running.stdoutReader.on("line", (line) => {
      const observedAt = this.now().toISOString();
      this.updateRun(runId, (current) => ({
        ...current,
        stdoutTail: appendTail(current.stdoutTail, line),
        ...appendPreviewUrls(current.previewUrls, {
          line,
          source: "stdout",
          observedAt,
        }),
        updatedAt: observedAt,
      }));
    });
    running.stderrReader.on("line", (line) => {
      const observedAt = this.now().toISOString();
      this.updateRun(runId, (current) => ({
        ...current,
        stderrTail: appendTail(current.stderrTail, line),
        ...appendPreviewUrls(current.previewUrls, {
          line,
          source: "stderr",
          observedAt,
        }),
        updatedAt: observedAt,
      }));
    });
    child.on("error", (error) => {
      this.updateRun(runId, (current) => ({
        ...current,
        stderrTail: appendTail(current.stderrTail, error.message),
        updatedAt: this.now().toISOString(),
      }));
      void this.settleRun(runId, {
        status: "failed",
      });
    });
    child.on("exit", (code, signal) => {
      void this.settleRun(runId, {
        status: running.stopRequested ? "stopped" : code === 0 ? "completed" : "failed",
        exitCode: typeof code === "number" ? code : undefined,
        stopSignal: signal ?? undefined,
      });
    });

    this.runningById.set(runId, running);
    this.liveRunIdByKey.set(liveKey, runId);
    this.recentRuns = [snapshot, ...this.recentRuns].slice(0, RECENT_RUN_LIMIT);
    void this.emitChange({ immediate: true });
    return cloneRun(snapshot);
  }

  async stopRun(runId: string): Promise<DesktopManagedProjectRun | undefined> {
    const running = this.runningById.get(runId);
    if (running === undefined) {
      const existing = this.recentRuns.find((entry) => entry.runId === runId);
      return existing === undefined ? undefined : cloneRun(existing);
    }
    if (running.settled) {
      return cloneRun(running.snapshot);
    }
    const settled = await this.requestRunStop(runId, "stop");
    return cloneRun(settled);
  }

  async restartRun(runId: string): Promise<DesktopManagedProjectRun> {
    const existing = this.findRun(runId);
    if (existing === undefined) {
      throw createDesktopError({
        code: "desktop.project_run_not_found",
        message: "The selected project run no longer exists.",
      });
    }
    const liveKey = createLiveRunKey(existing.projectPath, existing.scriptName);
    const running = this.findActiveRunByKey(liveKey);
    if (running !== undefined) {
      if (running.restartPromise !== undefined) {
        return running.restartPromise;
      }
      if (running.snapshot.status === "stopping") {
        throw createDesktopError({
          code: "desktop.project_run_stopping",
          message: "The selected project run is already stopping.",
        });
      }
      const restartPromise = (async () => {
        await this.requestRunStop(running.snapshot.runId, "restart");
        return this.startRun({
          projectPath: running.snapshot.projectPath,
          scriptName: running.snapshot.scriptName,
          packageManagerOverride: running.snapshot.packageManager,
        });
      })();
      running.restartPromise = restartPromise.finally(() => {
        if (running.restartPromise === restartPromise) {
          running.restartPromise = undefined;
        }
      });
      return running.restartPromise;
    }
    return this.startRun({
      projectPath: existing.projectPath,
      scriptName: existing.scriptName,
      packageManagerOverride: existing.packageManager,
    });
  }

  async stopAll(): Promise<void> {
    const runIds = [...this.runningById.keys()];
    await Promise.all(runIds.map(async (runId) => {
      await this.stopRun(runId);
    }));
    await this.flushNow();
  }

  private async settleRun(
    runId: string,
    input: {
      status: DesktopManagedProjectRun["status"];
      exitCode?: number | undefined;
      stopSignal?: string | undefined;
    },
  ): Promise<void> {
    const running = this.runningById.get(runId);
    if (running === undefined || running.settled) {
      return;
    }
    running.settled = true;
    if (running.forceKillTimer !== undefined) {
      clearTimeout(running.forceKillTimer);
      running.forceKillTimer = undefined;
    }
    running.stdoutReader.close();
    running.stderrReader.close();
    const completedAt = this.now().toISOString();
    const nextSnapshot: DesktopManagedProjectRun = {
      ...running.snapshot,
      status: input.status,
      updatedAt: completedAt,
      completedAt,
      pendingAction: undefined,
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.stopSignal !== undefined ? { stopSignal: input.stopSignal } : {}),
    };
    running.snapshot = nextSnapshot;
    this.runningById.delete(runId);
    if (this.liveRunIdByKey.get(running.liveKey) === runId) {
      this.liveRunIdByKey.delete(running.liveKey);
    }
    this.recentRuns = this.recentRuns.map((entry) => entry.runId === runId ? nextSnapshot : entry);
    await this.emitChange({ immediate: true });
    running.settle(nextSnapshot);
  }

  private updateRun(
    runId: string,
    mutate: (run: DesktopManagedProjectRun) => DesktopManagedProjectRun,
  ): void {
    const running = this.runningById.get(runId);
    if (running === undefined) {
      return;
    }
    running.snapshot = mutate(running.snapshot);
    this.recentRuns = this.recentRuns.map((entry) => entry.runId === runId ? running.snapshot : entry);
    void this.emitChange();
  }

  private snapshotRuns(): DesktopManagedProjectRun[] {
    return this.recentRuns
      .slice()
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((run) => cloneRun(run));
  }

  private findRun(runId: string): DesktopManagedProjectRun | undefined {
    const running = this.runningById.get(runId);
    if (running !== undefined) {
      return running.snapshot;
    }
    return this.recentRuns.find((entry) => entry.runId === runId);
  }

  private async emitChange(input: { immediate?: boolean | undefined } = {}): Promise<void> {
    this.flushPending = true;
    if (input.immediate === true) {
      await this.flushNow();
      return;
    }
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushNow();
    }, this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  }

  private async flushNow(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.flushPending === false) {
      await this.drainLedgerWrites();
      return;
    }
    this.flushPending = false;
    const snapshot = this.snapshotRuns();
    this.options.onRunsChanged?.(snapshot);
    if (this.options.ledger !== undefined) {
      const writePromise = this.options.ledger.writeRuns(snapshot)
        .catch(() => undefined)
        .finally(() => {
          this.ledgerWrites.delete(writePromise);
        });
      this.ledgerWrites.add(writePromise);
      await writePromise;
    }
    await this.drainLedgerWrites();
  }

  private async drainLedgerWrites(): Promise<void> {
    while (this.ledgerWrites.size > 0) {
      await Promise.all([...this.ledgerWrites]);
    }
  }

  private findActiveRunByKey(liveKey: string): RunningProjectRun | undefined {
    const runId = this.liveRunIdByKey.get(liveKey);
    if (runId === undefined) {
      return undefined;
    }
    const running = this.runningById.get(runId);
    if (running === undefined || running.settled) {
      this.liveRunIdByKey.delete(liveKey);
      return undefined;
    }
    return running;
  }

  private async requestRunStop(
    runId: string,
    pendingAction: NonNullable<DesktopManagedProjectRun["pendingAction"]>,
  ): Promise<DesktopManagedProjectRun> {
    const running = this.runningById.get(runId);
    if (running === undefined) {
      const existing = this.findRun(runId);
      if (existing === undefined) {
        throw createDesktopError({
          code: "desktop.project_run_not_found",
          message: "The selected project run no longer exists.",
        });
      }
      return existing;
    }
    if (running.settled) {
      return running.snapshot;
    }
    if (running.snapshot.status !== "stopping") {
      running.stopRequested = true;
      running.snapshot = {
        ...running.snapshot,
        status: "stopping",
        pendingAction,
        updatedAt: this.now().toISOString(),
      };
      this.recentRuns = this.recentRuns.map((entry) => entry.runId === runId ? running.snapshot : entry);
      void this.emitChange({ immediate: true });
      this.trySignalRunning(running, "SIGTERM", "Failed to stop managed project run");
      running.forceKillTimer = setTimeout(() => {
        if (running.settled === false) {
          this.trySignalRunning(running, "SIGKILL", "Failed to force kill managed project run");
        }
      }, this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    }
    return running.settlePromise;
  }

  private trySignalRunning(
    running: RunningProjectRun,
    signal: NodeJS.Signals,
    failurePrefix: string,
  ): void {
    const childPid = running.child.pid;
    if (supportsDetachedProcessGroups(this.platform()) && typeof childPid === "number" && childPid > 0) {
      try {
        (this.options.killProcessImpl ?? process.kill)(-childPid, signal);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.updateRun(running.snapshot.runId, (current) => ({
          ...current,
          stderrTail: appendTail(current.stderrTail, `${failurePrefix}: ${message}`),
          updatedAt: this.now().toISOString(),
        }));
      }
    }
    try {
      const signalled = running.child.kill(signal);
      if (signalled === false) {
        this.updateRun(running.snapshot.runId, (current) => ({
          ...current,
          stderrTail: appendTail(current.stderrTail, `${failurePrefix}: kill(${signal}) returned false.`),
          updatedAt: this.now().toISOString(),
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateRun(running.snapshot.runId, (current) => ({
        ...current,
        stderrTail: appendTail(current.stderrTail, `${failurePrefix}: ${message}`),
        updatedAt: this.now().toISOString(),
      }));
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }
}
