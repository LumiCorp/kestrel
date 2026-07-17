import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  benchmarkProviderEnv,
  benchmarkProviderIssues,
  benchmarkProviderWarnings,
  loadBenchmarkDotEnv,
} from "./benchmark-provider-config.js";

type HarborMode = "run";

interface RuntimeDeps {
  spawn: typeof spawnSync;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface TerminalBenchHarborOptions {
  mode: HarborMode;
  dataset: string;
  taskId?: string | undefined;
  dryRun: boolean;
  harborBin: string;
  agentEnv: string[];
  artifacts: string[];
}

export interface TerminalBenchHarborCommand {
  args: string[];
}

export interface HarborAdapterFailure {
  path: string;
  status: string;
  failureKind?: string | undefined;
  taskId?: string | undefined;
  notes?: string | undefined;
}

export type HarborRunSummaryStatus = "PASS" | "FAIL" | "SKIP_INFRA";

export interface HarborProcessFailureSummary {
  commandPreview?: string | undefined;
  exitCode?: number | undefined;
  status?: string | undefined;
}

export interface HarborRunSummary {
  status: HarborRunSummaryStatus;
  reason?: string | undefined;
  taskId?: string | undefined;
  jobPath?: string | undefined;
  resultPath?: string | undefined;
  completedTrials?: number | undefined;
  erroredTrials?: number | undefined;
  rewardMean?: number | undefined;
  exceptionStats?: Record<string, unknown> | undefined;
  adapterPath?: string | undefined;
  adapterStatus?: string | undefined;
  adapterFailureKind?: string | undefined;
  processFailure?: HarborProcessFailureSummary | undefined;
}

const DEFAULT_DATASET = "terminal-bench@2.0";
const HARBOR_AGENT_IMPORT_PATH = "benchmarks.terminal_bench.harbor_agents:KestrelHarborCliInstalledAgent";

class HelpRequested extends Error {}

export function parseTerminalBenchHarborArgs(argv: string[]): TerminalBenchHarborOptions {
  let taskId: string | undefined;
  let full = false;
  let dryRun = false;
  let harborBin = "harbor";
  let dataset = DEFAULT_DATASET;
  const artifacts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
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
    mode: "run",
    dataset,
    ...(taskId !== undefined ? { taskId } : {}),
    dryRun,
    harborBin,
    agentEnv: [],
    artifacts,
  };
}

export function buildTerminalBenchHarborCommand(options: TerminalBenchHarborOptions): TerminalBenchHarborCommand {
  return {
    args: [
      "run",
      "-d",
      options.dataset,
      "--agent-import-path",
      HARBOR_AGENT_IMPORT_PATH,
      ...options.agentEnv.flatMap((value) => ["--agent-env", value]),
      ...(options.taskId !== undefined ? ["--include-task-name", options.taskId] : []),
      ...options.artifacts.flatMap((value) => ["--artifact", value]),
    ],
  };
}

export async function runTerminalBenchHarbor(argv: string[], deps: RuntimeDeps): Promise<number> {
  let options: TerminalBenchHarborOptions;
  try {
    options = parseTerminalBenchHarborArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      deps.stdout.write(helpText());
      return 0;
    }
    deps.stderr.write(`bench:terminal:harbor failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
    deps.stderr.write(helpText());
    return 1;
  }

  const initialEnv: NodeJS.ProcessEnv = {
    ...deps.env,
    KESTREL_TBENCH_REPO_ROOT: deps.env.KESTREL_TBENCH_REPO_ROOT ?? deps.cwd,
  };
  const providerIssues = benchmarkProviderIssues(initialEnv);
  if (providerIssues.length > 0) {
    for (const issue of providerIssues) {
      deps.stderr.write(`[bench:terminal:harbor] ${issue}\n`);
    }
    return 1;
  }
  const providerWarnings = benchmarkProviderWarnings(initialEnv);
  const env: NodeJS.ProcessEnv = benchmarkProviderEnv(initialEnv);
  for (const warning of providerWarnings) {
    deps.stderr.write(`[bench:terminal:harbor] ${warning}\n`);
  }
  options = {
    ...options,
    agentEnv: buildAgentEnvArgs(env),
  };
  const command = buildTerminalBenchHarborCommand(options);
  deps.stdout.write(`[bench:terminal:harbor] dataset=${options.dataset} task=${options.taskId ?? "full"}\n`);
  deps.stdout.write(`[bench:terminal:harbor] harbor: ${formatCommand(options.harborBin, command.args)}\n`);

  if (options.dryRun) {
    deps.stdout.write("[bench:terminal:harbor] dry run complete. No Harbor tasks were started.\n");
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
  const failures = readRecentHarborAdapterFailures(deps.cwd, startedAt);
  if (harborFailure !== undefined) {
    deps.stderr.write(`[bench:terminal:harbor] Harbor run failed: ${harborFailure}\n`);
    return 1;
  }
  if (failures.length > 0) {
    deps.stderr.write(
      [
        "[bench:terminal:harbor] failed: artifact_passed_but_agent_failed.",
        ...failures.map((failure) =>
          `- ${failure.path}: status=${failure.status} failure_kind=${failure.failureKind ?? "unknown"} task=${failure.taskId ?? "unknown"}`
        ),
        "",
      ].join("\n"),
    );
    return 1;
  }
  if (result.status !== 0 || result.error !== undefined) {
    deps.stderr.write(`[bench:terminal:harbor] Harbor command failed.\n${formatSpawnFailure(result)}`);
    return result.status ?? 1;
  }
  deps.stdout.write("[bench:terminal:harbor] complete. Kestrel artifacts are written with the Harbor run logs when available.\n");
  return 0;
}

export function resolveHarborBinary(input: {
  requestedBinary: string;
  spawn: typeof spawnSync;
  env: NodeJS.ProcessEnv;
}): { binary: string; version: SpawnSyncReturns<Buffer> } | undefined {
  for (const binary of harborBinaryCandidates(input.requestedBinary, input.env)) {
    const version = input.spawn(binary, ["--help"], { env: input.env });
    if (version.status === 0 && version.error === undefined) {
      return { binary, version };
    }
  }
  return ;
}

export function ensureHarborBinary(input: {
  requestedBinary: string;
  spawn: typeof spawnSync;
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}): string | undefined {
  const existing = resolveHarborBinary(input);
  if (existing !== undefined) {
    return existing.binary;
  }
  if (input.requestedBinary !== "harbor") {
    input.stderr.write(`[bench:terminal:harbor] Harbor CLI is not available at ${input.requestedBinary}.\n`);
    return ;
  }

  const uvVersion = input.spawn("uv", ["--version"], { env: input.env });
  if (uvVersion.status !== 0 || uvVersion.error !== undefined) {
    input.stderr.write("[bench:terminal:harbor] Harbor CLI is not available, and uv is not installed. Install uv, then run: uv tool install harbor\n");
    return ;
  }

  input.stdout.write("[bench:terminal:harbor] Harbor CLI is not available; installing with uv tool install harbor\n");
  const install = input.spawn("uv", ["tool", "install", "harbor"], {
    env: input.env,
    stdio: "inherit",
  });
  if (install.status !== 0 || install.error !== undefined) {
    input.stderr.write(`[bench:terminal:harbor] Harbor install failed.\n${formatSpawnFailure(install)}`);
    return ;
  }

  const installed = resolveHarborBinary(input);
  if (installed === undefined) {
    input.stderr.write("[bench:terminal:harbor] Harbor was installed but is still not available on PATH. Add the uv tool bin directory to PATH and retry.\n");
    return ;
  }
  return installed.binary;
}

export function readRecentHarborAdapterFailures(cwd: string, startedAtMs: number): HarborAdapterFailure[] {
  const failures: HarborAdapterFailure[] = [];
  for (const root of recentHarborJobRoots(cwd, startedAtMs)) {
    for (const jsonPath of listJsonFiles(root)) {
      const failure = readHarborAdapterFailure(cwd, jsonPath, startedAtMs);
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
  const latest = latestHarborResult(cwd, startedAtMs);
  if (latest === undefined) {
    return ;
  }
  const parsed = readJsonRecord(latest.path);
  if (parsed === undefined) {
    return ;
  }
  const stats = isRecord(parsed.stats) ? parsed.stats : undefined;
  const errored = typeof stats?.n_errored_trials === "number" ? stats.n_errored_trials : 0;
  if (errored > 0) {
    return `${path.relative(cwd, latest.path)} reports ${errored} errored trial(s)`;
  }
  return requirePerfectReward ? readHarborRewardFailure(cwd, latest.path, parsed) : undefined;
}

export function readRecentHarborRunSummary(
  cwd: string,
  startedAtMs: number,
  taskId?: string | undefined,
): HarborRunSummary {
  const latest = latestHarborResult(cwd, startedAtMs);
  if (latest === undefined) {
    return {
      status: "SKIP_INFRA",
      reason: "infra_no_result",
      ...(taskId !== undefined ? { taskId } : {}),
    };
  }

  const root = path.dirname(latest.path);
  const resultPath = path.relative(cwd, latest.path);
  const jobPath = path.relative(cwd, root);
  const parsed = readJsonRecord(latest.path);
  if (parsed === undefined) {
    return {
      status: "SKIP_INFRA",
      reason: "infra_invalid_result",
      resultPath,
      jobPath,
      ...(taskId !== undefined ? { taskId } : {}),
    };
  }

  const stats = isRecord(parsed.stats) ? parsed.stats : undefined;
  if (stats === undefined) {
    return {
      status: "SKIP_INFRA",
      reason: "infra_invalid_result",
      resultPath,
      jobPath,
      ...(taskId !== undefined ? { taskId } : {}),
    };
  }

  const completedTrials = typeof stats.n_completed_trials === "number" ? Math.trunc(stats.n_completed_trials) : undefined;
  const erroredTrials = typeof stats.n_errored_trials === "number" ? Math.trunc(stats.n_errored_trials) : undefined;
  const rewardMean = readHarborRewardMean(parsed);
  const exceptionStats = readHarborExceptionStats(stats);
  const adapter = readLatestHarborAdapterSummary(cwd, root, taskId);
  const processFailure = readLatestProcessFailureSummary(root);
  const status = rewardMean === undefined && (completedTrials ?? 0) === 0 && (erroredTrials ?? 0) === 0
    ? "SKIP_INFRA"
    : (erroredTrials ?? 0) > 0 || rewardMean === undefined || rewardMean < 1
      ? "FAIL"
      : "PASS";
  const reason = status === "SKIP_INFRA" ? "infra_no_result" : status === "FAIL" ? "harbor_reward_or_error" : undefined;

  return {
    status,
    ...(reason !== undefined ? { reason } : {}),
    resultPath,
    jobPath,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(completedTrials !== undefined ? { completedTrials } : {}),
    ...(erroredTrials !== undefined ? { erroredTrials } : {}),
    ...(rewardMean !== undefined ? { rewardMean } : {}),
    ...(exceptionStats !== undefined ? { exceptionStats } : {}),
    ...(adapter.path !== undefined ? { adapterPath: adapter.path } : {}),
    ...(adapter.status !== undefined ? { adapterStatus: adapter.status } : {}),
    ...(adapter.failureKind !== undefined ? { adapterFailureKind: adapter.failureKind } : {}),
    ...(processFailure !== undefined ? { processFailure } : {}),
  };
}

function readHarborRewardFailure(cwd: string, resultPath: string, parsed: Record<string, unknown>): string | undefined {
  const rewardMean = readHarborRewardMean(parsed);
  if (rewardMean !== undefined && rewardMean < 1) {
    return `${path.relative(cwd, resultPath)} reports reward mean ${rewardMean}`;
  }
  return ;
}

function readHarborRewardMean(parsed: Record<string, unknown>): number | undefined {
  const stats = isRecord(parsed.stats) ? parsed.stats : undefined;
  const evals = isRecord(stats?.evals) ? stats.evals : undefined;
  if (evals === undefined) {
    return ;
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
      return metric.mean;
    }
  }
  return ;
}

function readHarborExceptionStats(stats: Record<string, unknown>): Record<string, unknown> | undefined {
  const evals = isRecord(stats.evals) ? stats.evals : undefined;
  if (evals === undefined) {
    return ;
  }
  for (const value of Object.values(evals)) {
    if (!isRecord(value)) {
      continue;
    }
    const exceptionStats = isRecord(value.exception_stats) ? value.exception_stats : undefined;
    if (exceptionStats !== undefined) {
      return exceptionStats;
    }
  }
  return ;
}

function latestHarborResult(cwd: string, startedAtMs: number): { path: string; mtimeMs: number } | undefined {
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
    }
  }
  return latest;
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

function readHarborAdapterFailure(cwd: string, jsonPath: string, startedAtMs: number): HarborAdapterFailure | undefined {
  if (!jsonPath.includes("kestrel-harbor-cli-")) {
    return ;
  }
  let stats;
  try {
    stats = statSync(jsonPath);
  } catch {
    return ;
  }
  if (stats.mtimeMs + 1000 < startedAtMs) {
    return ;
  }
  const parsed = readJsonRecord(jsonPath);
  if (parsed === undefined) {
    return ;
  }
  const status = typeof parsed.status === "string" ? parsed.status : undefined;
  if (status === undefined || status === "completed") {
    return ;
  }
  return {
    path: path.relative(cwd, jsonPath),
    status,
    ...(typeof parsed.failure_kind === "string" ? { failureKind: parsed.failure_kind } : {}),
    ...(typeof parsed.task_id === "string" ? { taskId: parsed.task_id } : {}),
    ...(typeof parsed.notes === "string" ? { notes: parsed.notes } : {}),
  };
}

function readLatestHarborAdapterSummary(
  cwd: string,
  root: string,
  taskId?: string | undefined,
): { path?: string | undefined; status?: string | undefined; failureKind?: string | undefined } {
  let latest: { path: string; mtimeMs: number; parsed: Record<string, unknown> } | undefined;
  for (const jsonPath of listJsonFiles(root)) {
    if (!jsonPath.includes("kestrel-harbor-cli-")) {
      continue;
    }
    const parsed = readJsonRecord(jsonPath);
    if (parsed === undefined) {
      continue;
    }
    const parsedTaskId = typeof parsed.task_id === "string" ? parsed.task_id : undefined;
    if (taskId !== undefined && parsedTaskId !== undefined && parsedTaskId !== taskId) {
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(jsonPath).mtimeMs;
    } catch {
      continue;
    }
    if (latest === undefined || mtimeMs > latest.mtimeMs) {
      latest = { path: jsonPath, mtimeMs, parsed };
    }
  }
  if (latest === undefined) {
    return {};
  }
  return {
    path: path.relative(cwd, latest.path),
    ...(typeof latest.parsed.status === "string" ? { status: latest.parsed.status } : {}),
    ...(typeof latest.parsed.failure_kind === "string" ? { failureKind: latest.parsed.failure_kind } : {}),
  };
}

function readLatestProcessFailureSummary(root: string): HarborProcessFailureSummary | undefined {
  let latest: { mtimeMs: number; failure: Record<string, unknown> } | undefined;
  const preferred = ["kestrel-cli-result.json", "kestrel-harbor-cli-"];
  for (const jsonPath of listJsonFiles(root)) {
    if (!preferred.some((name) => path.basename(jsonPath).includes(name))) {
      continue;
    }
    const parsed = readJsonRecord(jsonPath);
    const failure = asProcessFailure(parsed);
    if (failure === undefined) {
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(jsonPath).mtimeMs;
    } catch {
      continue;
    }
    if (latest === undefined || mtimeMs > latest.mtimeMs) {
      latest = { mtimeMs, failure };
    }
  }
  if (latest === undefined) {
    return ;
  }
  const command = typeof latest.failure.command === "string" ? latest.failure.command : undefined;
  const exitCode = typeof latest.failure.exit_code === "number"
    ? Math.trunc(latest.failure.exit_code)
    : typeof latest.failure.exitCode === "number"
      ? Math.trunc(latest.failure.exitCode)
      : undefined;
  return {
    ...(command !== undefined ? { commandPreview: oneLinePreview(command, 180) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(typeof latest.failure.status === "string" ? { status: latest.failure.status } : {}),
  };
}

function asProcessFailure(parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const details = isRecord(parsed?.failure_details) ? parsed.failure_details : undefined;
  const processFailure = isRecord(details?.process_failure) ? details.process_failure : undefined;
  return processFailure;
}

function oneLinePreview(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
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

function harborBinaryCandidates(requestedBinary: string, env: NodeJS.ProcessEnv): string[] {
  const candidates = [requestedBinary];
  if (requestedBinary === "harbor" && env.HOME !== undefined && env.HOME.length > 0) {
    candidates.push(path.join(env.HOME, ".local", "bin", "harbor"));
  }
  return [...new Set(candidates)];
}

function buildAgentEnvArgs(env: NodeJS.ProcessEnv): string[] {
  const entries = new Map<string, string>([
    ["KESTREL_TBENCH_RESULT_ADAPTER", "harbor-cli"],
    ["KESTREL_TBENCH_RESULT_DATASET", "terminal-bench@2.0"],
  ]);
  for (const key of [
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "TAVILY_API_KEY",
    "KESTREL_BENCHMARK_MODEL_PROVIDER",
    "KESTREL_BENCHMARK_MODEL",
    "KESTREL_BENCHMARK_CREDENTIAL_ENV",
    "KESTREL_BENCHMARK_CREDENTIAL_FINGERPRINT",
    "KCHAT_MODEL_TIMEOUT_MS",
    "KCHAT_MODEL_RETRY_COUNT",
    "KESTREL_TBENCH_CLI_COMMAND_TIMEOUT_SEC",
    "KESTREL_TBENCH_RUN_TIMEOUT_SEC",
    "KESTREL_TBENCH_AGENT_TIMEOUT_SEC",
    "KESTREL_TBENCH_DEADLINE_RESERVE_SEC",
  ]) {
    if (env[key] !== undefined && env[key] !== "") {
      entries.set(key, `\${${key}}`);
    }
  }
  return [...entries].map(([key, value]) => `${key}=${value}`);
}

export function formatCommand(binary: string, args: string[]): string {
  return [binary, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@=-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function readHarborCommandTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.KESTREL_TBENCH_HARBOR_COMMAND_TIMEOUT_SEC ?? env.KESTREL_TBENCH_COMMAND_TIMEOUT_SEC;
  const seconds = raw !== undefined && raw.trim().length > 0 ? Number(raw) : 1800;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 1_800_000;
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
    return ;
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
  return `Usage: pnpm run bench:terminal:harbor -- <task-id> [options]
       pnpm run bench:terminal:harbor -- --full [options]

Runs Terminal-Bench 2.0 through Harbor with the Kestrel Harbor CLI adapter.

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
  loadBenchmarkDotEnv(process.cwd(), process.env);
  void runTerminalBenchHarbor(process.argv.slice(2), {
    spawn: spawnSync,
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((code) => {
    process.exitCode = code;
  });
}
