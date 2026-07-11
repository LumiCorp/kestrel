import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureHarborBinary, formatCommand } from "./terminal-bench-harbor.js";

interface RuntimeDeps {
  spawn: typeof spawnSync;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface TerminalBenchCodexOptions {
  dataset: string;
  taskId?: string | undefined;
  dryRun: boolean;
  harborBin: string;
  artifacts: string[];
  agentEnv: string[];
}

export interface TerminalBenchCodexCommand {
  args: string[];
}

export interface CodexAdapterFailure {
  path: string;
  status: string;
  failureKind?: string | undefined;
  taskId?: string | undefined;
  notes?: string | undefined;
}

const DEFAULT_DATASET = "terminal-bench@2.0";
const CODEX_AGENT_IMPORT_PATH = "benchmarks.terminal_bench.codex_harbor_agent:CodexHarborCliInstalledAgent";
const CODEX_RESULT_ADAPTER = "codex-harbor-cli";

class HelpRequested extends Error {}

export function parseTerminalBenchCodexArgs(argv: string[]): TerminalBenchCodexOptions {
  let taskId: string | undefined;
  let full = false;
  let dryRun = false;
  let harborBin = "harbor";
  let dataset = DEFAULT_DATASET;
  const artifacts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    }
    if (arg === "--full") {
      full = true;
      taskId = undefined;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--harbor-bin") {
      harborBin = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--dataset") {
      dataset = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--artifact") {
      artifacts.push(readValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (taskId !== undefined) {
      throw new Error(`Unexpected extra task id: ${arg}`);
    }
    taskId = arg;
  }

  if (!full && taskId === undefined) {
    throw new Error("Provide a Terminal-Bench 2.0 task id or pass --full.");
  }
  assertSafeDataset(dataset);
  if (taskId !== undefined) {
    assertSafeTaskId(taskId);
  }
  for (const artifact of artifacts) {
    assertSafeArtifactPath(artifact);
  }

  return {
    dataset,
    ...(taskId !== undefined ? { taskId } : {}),
    dryRun,
    harborBin,
    artifacts,
    agentEnv: [],
  };
}

export function buildTerminalBenchCodexCommand(options: TerminalBenchCodexOptions): TerminalBenchCodexCommand {
  return {
    args: [
      "run",
      "-d",
      options.dataset,
      "--agent-import-path",
      CODEX_AGENT_IMPORT_PATH,
      ...options.agentEnv.flatMap((value) => ["--agent-env", value]),
      ...(options.taskId !== undefined ? ["--include-task-name", options.taskId] : []),
      ...options.artifacts.flatMap((value) => ["--artifact", value]),
    ],
  };
}

export async function runTerminalBenchCodex(argv: string[], deps: RuntimeDeps): Promise<number> {
  let options: TerminalBenchCodexOptions;
  try {
    options = parseTerminalBenchCodexArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      deps.stdout.write(helpText());
      return 0;
    }
    deps.stderr.write(`bench:terminal:codex failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
    deps.stderr.write(helpText());
    return 1;
  }

  const env: NodeJS.ProcessEnv = { ...deps.env };
  options = {
    ...options,
    agentEnv: buildCodexAgentEnvArgs(env),
  };
  const command = buildTerminalBenchCodexCommand(options);
  deps.stdout.write(`[bench:terminal:codex] dataset=${options.dataset} task=${options.taskId ?? "full"}\n`);
  deps.stdout.write(`[bench:terminal:codex] harbor: ${formatCommand(options.harborBin, command.args)}\n`);

  if (options.dryRun) {
    deps.stdout.write("[bench:terminal:codex] dry run complete. No Harbor tasks were started.\n");
    return 0;
  }

  const harborBinary = ensureHarborBinary({
    requestedBinary: options.harborBin,
    spawn: deps.spawn,
    env,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
  if (harborBinary === undefined) {
    return 1;
  }

  const startedAt = Date.now();
  const result = deps.spawn(harborBinary, command.args, {
    cwd: deps.cwd,
    env,
    stdio: "inherit",
    timeout: readHarborCommandTimeoutMs(env),
  });
  const harborFailure = readRecentHarborRunFailure(deps.cwd, startedAt, options.taskId !== undefined);
  const failures = readRecentCodexAdapterFailures(deps.cwd, startedAt);
  if (harborFailure !== undefined) {
    deps.stderr.write(`[bench:terminal:codex] Harbor run failed: ${harborFailure}\n`);
    return 1;
  }
  if (failures.length > 0) {
    deps.stderr.write(
      [
        "[bench:terminal:codex] failed: harbor_task_or_agent_failed.",
        ...failures.map((failure) =>
          `- ${failure.path}: status=${failure.status} failure_kind=${failure.failureKind ?? "unknown"} task=${failure.taskId ?? "unknown"}`
        ),
        "",
      ].join("\n"),
    );
    return 1;
  }
  if (result.status !== 0 || result.error !== undefined) {
    deps.stderr.write(`[bench:terminal:codex] Harbor command failed.\n${formatSpawnFailure(result)}`);
    return result.status ?? 1;
  }
  deps.stdout.write("[bench:terminal:codex] complete. Codex artifacts are written with the Harbor run logs when available.\n");
  return 0;
}

export function readRecentCodexAdapterFailures(cwd: string, startedAtMs: number): CodexAdapterFailure[] {
  const failures: CodexAdapterFailure[] = [];
  for (const root of recentHarborJobRoots(cwd, startedAtMs)) {
    for (const jsonPath of listJsonFiles(root)) {
      const failure = readCodexAdapterFailure(cwd, jsonPath, startedAtMs);
      if (failure !== undefined) {
        failures.push(failure);
      }
    }
  }
  return failures;
}

export function readRecentHarborRunFailure(
  cwd: string,
  startedAtMs: number,
  requirePerfectReward = false,
): string | undefined {
  const recentRoots = recentHarborJobRoots(cwd, startedAtMs);
  let latest: { path: string; mtimeMs: number } | undefined;
  for (const root of recentRoots) {
    const resultPath = path.join(root, "result.json");
    try {
      const stats = statSync(resultPath);
      if (stats.mtimeMs + 1000 < startedAtMs) {
        continue;
      }
      if (latest === undefined || stats.mtimeMs > latest.mtimeMs) {
        latest = { path: resultPath, mtimeMs: stats.mtimeMs };
      }
    } catch {
      continue;
    }
  }
  if (latest === undefined) {
    return undefined;
  }
  const parsed = readJsonRecord(latest.path);
  if (parsed === undefined) {
    return undefined;
  }
  const stats = isRecord(parsed?.stats) ? parsed.stats : undefined;
  const errored = typeof stats?.n_errored_trials === "number" ? stats.n_errored_trials : 0;
  if (errored <= 0) {
    return requirePerfectReward ? readHarborRewardFailure(cwd, latest.path, parsed) : undefined;
  }
  return `${path.relative(cwd, latest.path)} reports ${errored} errored trial(s)`;
}

function readHarborRewardFailure(cwd: string, resultPath: string, parsed: Record<string, unknown>): string | undefined {
  const stats = isRecord(parsed.stats) ? parsed.stats : undefined;
  const evals = isRecord(stats?.evals) ? stats.evals : undefined;
  if (evals === undefined) {
    return undefined;
  }
  for (const value of Object.values(evals)) {
    if (!isRecord(value)) {
      continue;
    }
    const metrics = Array.isArray(value.metrics) ? value.metrics : [];
    for (const metric of metrics) {
      if (!isRecord(metric) || typeof metric.mean !== "number") {
        continue;
      }
      if (metric.mean < 1) {
        return `${path.relative(cwd, resultPath)} reports reward mean ${metric.mean}`;
      }
    }
  }
  return undefined;
}

function buildCodexAgentEnvArgs(env: NodeJS.ProcessEnv): string[] {
  const entries = new Map<string, string>([
    ["CODEX_TBENCH_RESULT_ADAPTER", CODEX_RESULT_ADAPTER],
    ["CODEX_TBENCH_RESULT_DATASET", DEFAULT_DATASET],
  ]);
  for (const key of [
    "KESTREL_TBENCH_CODEX_TIMEOUT_SEC",
    "KESTREL_TBENCH_CODEX_INSTALL_TIMEOUT_SEC",
    "KESTREL_TBENCH_AGENT_TIMEOUT_SEC",
    "KESTREL_TBENCH_RUN_TIMEOUT_SEC",
  ]) {
    if (env[key] !== undefined && env[key] !== "") {
      entries.set(key, `\${${key}}`);
    }
  }
  return [...entries].map(([key, value]) => `${key}=${value}`);
}

function recentHarborJobRoots(cwd: string, startedAtMs: number): string[] {
  const jobsRoot = path.join(cwd, "jobs");
  if (!existsSync(jobsRoot)) {
    return [];
  }
  return readdirSync(jobsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(jobsRoot, entry.name))
    .filter((jobRoot) => {
      try {
        const stats = statSync(jobRoot);
        return stats.mtimeMs + 1000 >= startedAtMs;
      } catch {
        return false;
      }
    });
}

function readCodexAdapterFailure(cwd: string, jsonPath: string, startedAtMs: number): CodexAdapterFailure | undefined {
  if (!jsonPath.includes("kestrel-codex-harbor-cli-")) {
    return undefined;
  }
  let stats;
  try {
    stats = statSync(jsonPath);
  } catch {
    return undefined;
  }
  if (stats.mtimeMs + 1000 < startedAtMs) {
    return undefined;
  }
  const parsed = readJsonRecord(jsonPath);
  if (parsed === undefined) {
    return undefined;
  }
  const status = typeof parsed.status === "string" ? parsed.status : undefined;
  if (status === undefined || status === "completed") {
    return undefined;
  }
  return {
    path: path.relative(cwd, jsonPath),
    status,
    ...(typeof parsed.failure_kind === "string" ? { failureKind: parsed.failure_kind } : {}),
    ...(typeof parsed.task_id === "string" ? { taskId: parsed.task_id } : {}),
    ...(typeof parsed.notes === "string" ? { notes: parsed.notes } : {}),
  };
}

function readValue(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function assertSafeDataset(dataset: string): void {
  if (!/^[a-zA-Z0-9._/-]+@[a-zA-Z0-9._-]+$/u.test(dataset)) {
    throw new Error(`Unsafe Harbor dataset: ${dataset}`);
  }
  if (dataset.includes("..") || dataset.startsWith("/") || dataset.endsWith("/")) {
    throw new Error(`Unsafe Harbor dataset: ${dataset}`);
  }
}

function assertSafeTaskId(taskId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/u.test(taskId) || taskId === "." || taskId === "..") {
    throw new Error(`Unsafe Terminal-Bench 2.0 task id: ${taskId}`);
  }
}

function assertSafeArtifactPath(artifact: string): void {
  if (!artifact.startsWith("/") || artifact.includes("..") || artifact.includes("\0")) {
    throw new Error(`Unsafe Harbor artifact path: ${artifact}`);
  }
}

function readHarborCommandTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.KESTREL_TBENCH_HARBOR_COMMAND_TIMEOUT_SEC ?? env.KESTREL_TBENCH_COMMAND_TIMEOUT_SEC;
  const seconds = raw !== undefined && raw.trim().length > 0 ? Number(raw) : 1800;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 1800_000;
}

function listJsonFiles(root: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files;
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
  const output = [
    result.stdout?.toString("utf8") ?? "",
    result.stderr?.toString("utf8") ?? "",
    result.error instanceof Error ? result.error.message : "",
  ].filter((value) => value.trim().length > 0);
  return output.length > 0 ? `${output.join("\n")}\n` : "";
}

function helpText(): string {
  return `Usage: pnpm run bench:terminal:codex -- <task-id> [options]
       pnpm run bench:terminal:codex -- --full [options]

Runs Terminal-Bench 2.0 through Harbor with a Codex CLI installed-agent adapter.

Options:
  --full                 Run the full terminal-bench@2.0 dataset.
  --dataset <dataset>    Harbor dataset to run. Default: terminal-bench@2.0.
  --harbor-bin <path>    Harbor binary to execute. Default: harbor.
  --artifact <path>      Collect an environment path into Harbor artifacts. Repeatable.
  --dry-run              Print the Harbor command without running it.
  -h, --help             Show this help.
`;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  void runTerminalBenchCodex(process.argv.slice(2), {
    spawn: spawnSync,
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((code) => {
    process.exitCode = code;
  });
}
