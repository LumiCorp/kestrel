import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  benchmarkProviderEnv,
  benchmarkProviderIssues,
  benchmarkProviderWarnings,
  loadBenchmarkDotEnv,
} from "./benchmark-provider-config.js";
import {
  buildKestrelTerminalBenchRepairPrompt,
} from "../src/runtime/KestrelAgentContextBuilder.js";
import {
  createHarnessEfficiencyLedgerV1,
  createHarnessEfficiencyResultV1,
  emptyHarnessEfficiencyEconomics,
  hashHarnessEfficiencyValue,
  readHarnessEfficiencyEconomicsFromLedger,
  readHarnessEfficiencyEconomicsFromReplayBundle,
} from "../src/economics/index.js";

type Adapter = "kestrel";
type LegacyAdapterSelection = "runtime" | "cli" | "both";
type AdapterSelection = Adapter | LegacyAdapterSelection;
type CommandMode = "bootstrap" | "preflight" | "run" | "improve" | "cleanup";
type ImproveExecutor = "codex";

export interface TerminalBenchOptions {
  mode: CommandMode;
  adapter: AdapterSelection;
  dataset: string;
  taskId?: string | undefined;
  dryRun: boolean;
  tbBin: string;
  maxIterations: number;
  executor: ImproveExecutor;
}

export interface TerminalBenchCommand {
  adapter: Adapter;
  args: string[];
}

export interface TerminalBenchBinaryResolution {
  binary: string;
  version: SpawnSyncReturns<Buffer>;
}

export interface BenchmarkOutcome {
  nResolved: number;
  nUnresolved: number;
  accuracy: number;
  failureMode?: string | undefined;
  unresolvedIds: string[];
  adapterFailures: AdapterResultFailure[];
  benchmarkSetupFailure?: BenchmarkSetupFailure | undefined;
  artifactPassedButAgentFailed: boolean;
  adapterCompletedButBenchmarkFailed: boolean;
}

export interface BenchmarkSetupFailure {
  kind: string;
  notes: string;
  runLogPath?: string | undefined;
}

export interface AdapterResultFailure {
  path: string;
  status: string;
  failureKind?: string | undefined;
  taskId?: string | undefined;
  notes?: string | undefined;
  failureDetails?: Record<string, unknown> | undefined;
}

export interface BenchmarkRunRecord {
  adapter: Adapter;
  runId: string;
  args: string[];
  runDir: string;
  status: number;
  outcome?: BenchmarkOutcome | undefined;
  failureKind?: string | undefined;
  failureNotes?: string | undefined;
}

export interface TerminalBenchRepairPolicyResult {
  passed: boolean;
  output: string;
  violations: string[];
  changedPaths: string[];
}

export type TerminalBenchQueueTaskStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface TerminalBenchQueueAdapterRun {
  status: TerminalBenchQueueTaskStatus;
  attempts: number;
  last_run_id: string | null;
  last_failure_kind: string | null;
}

export interface TerminalBenchQueueTask {
  task_id: string;
  status: TerminalBenchQueueTaskStatus;
  attempts: number;
  last_run_id: string | null;
  last_failure_kind: string | null;
  adapter_runs?: Partial<Record<Adapter, TerminalBenchQueueAdapterRun>>;
}

export interface TerminalBenchQueueState {
  dataset: string;
  adapter: AdapterSelection;
  created_at: string;
  tasks: TerminalBenchQueueTask[];
}

type DockerCleanupPhase = "pre" | "post";

interface DockerCleanupRun {
  adapter: Adapter;
  phase: DockerCleanupPhase;
  runId: string;
  command: "docker";
  args: string[];
  result: SpawnSyncReturns<Buffer>;
}

interface RuntimeDeps {
  spawn: typeof spawnSync;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform?: NodeJS.Platform;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const DEFAULT_DATASET = "terminal-bench-core==0.1.1";
const DEFAULT_PREFLIGHT_TASK_ID = "hello-world";
const KESTREL_AGENT = "benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent";
const KESTREL_ARTIFACT_PREFIX = "kestrel-terminal-bench";
const BOOTSTRAP_DOCKER_WAIT_MS = 120_000;
const BOOTSTRAP_DOCKER_POLL_MS = 2000;
const TERMINAL_BENCH_PYTHON = "3.13";
const TERMINAL_BENCH_BASE_IMAGE = "ghcr.io/laude-institute/t-bench/python-3-13:latest";
const DEFAULT_MAX_IMPROVE_ITERATIONS = 10;
const DEFAULT_CODEX_REPAIR_MODEL = "gpt-5.4";
const IMPROVE_ARTIFACT_ROOT = "runs/terminal-bench-improve";
const EVIDENCE_FILE_LIMIT = 12_000;

export function appendRunNote(input: {
  cwd: string;
  title: string;
  command: string;
  outcome: string;
  evidencePaths: string[];
  next: string;
}): void {
  const notesPath = path.join(input.cwd, "benchmarks", "terminal_bench", "term-bench-run-notes.md");
  mkdirSync(path.dirname(notesPath), { recursive: true });
  const header = existsSync(notesPath)
    ? ""
    : "# Terminal-Bench Run Notes\n\nLiving notes for Kestrel Terminal-Bench improvement work.\n\n";
  const evidence = input.evidencePaths.length === 0
    ? "- none recorded"
    : input.evidencePaths.map((evidencePath) => `- \`${evidencePath}\``).join("\n");
  const entry = [
    header,
    `## ${new Date().toISOString().slice(0, 10)} - ${input.title}`,
    "",
    "Command:",
    `\`${input.command}\``,
    "",
    "Outcome:",
    input.outcome,
    "",
    "Evidence:",
    evidence,
    "",
    "Next:",
    input.next,
    "",
  ].join("\n");
  writeFileSync(notesPath, entry, { encoding: "utf8", flag: "a" });
}

export function parseTerminalBenchArgs(argv: string[]): TerminalBenchOptions {
  let mode: CommandMode = "preflight";
  let adapter: Adapter | undefined;
  let dataset = DEFAULT_DATASET;
  let taskId: string | undefined;
  let explicitTaskId = false;
  let dryRun = false;
  let tbBin = "tb";
  let maxIterations = DEFAULT_MAX_IMPROVE_ITERATIONS;
  let executor: ImproveExecutor = "codex";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (
      arg === "bootstrap" ||
      arg === "preflight" ||
      arg === "run" ||
      arg === "improve" ||
      arg === "cleanup"
    ) {
      mode = arg;
      continue;
    }

    if (arg === "runtime" || arg === "cli") {
      mode = "run";
      adapter = "kestrel";
      continue;
    }

    if (arg === "both") {
      throw new Error("Terminal-Bench no longer supports the both adapter mode. Use: pnpm run bench:terminal -- run");
    }

    if (arg === "--adapter") {
      const value = readValue(argv, index, arg);
      if (value === "runtime" || value === "both") {
        throw new Error("--adapter runtime/both were removed. Use --adapter kestrel.");
      }
      if (value !== "kestrel" && value !== "cli") {
        throw new Error("--adapter must be kestrel");
      }
      adapter = "kestrel";
      index += 1;
      continue;
    }

    if (arg === "--dataset") {
      dataset = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--task-id") {
      taskId = readValue(argv, index, arg);
      explicitTaskId = true;
      index += 1;
      continue;
    }

    if (arg === "--full") {
      taskId = undefined;
      explicitTaskId = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--tb-bin") {
      tbBin = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--max-iterations") {
      maxIterations = readPositiveInteger(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === "--executor") {
      const value = readValue(argv, index, arg);
      if (value !== "codex") {
        throw new Error("--executor must be codex");
      }
      executor = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if ((mode === "preflight" || mode === "improve") && !explicitTaskId) {
    taskId = DEFAULT_PREFLIGHT_TASK_ID;
  }

  return {
    mode,
    adapter: adapter ?? adapterFromMode(mode),
    dataset,
    ...(taskId !== undefined ? { taskId } : {}),
    dryRun,
    tbBin,
    maxIterations,
    executor,
  };
}

export function buildTerminalBenchCommands(options: TerminalBenchOptions): TerminalBenchCommand[] {
  return selectedAdapters(options.adapter).map((adapterValue) => ({
    adapter: adapterValue,
    args: [
      "run",
      "--dataset",
      options.dataset,
      "--agent-import-path",
      KESTREL_AGENT,
      ...(options.taskId !== undefined ? ["--task-id", options.taskId] : []),
    ],
  }));
}

function selectedAdapters(adapter: AdapterSelection): Adapter[] {
  return ["kestrel"];
}

function createQueueAdapterRuns(adapter: AdapterSelection): Partial<Record<Adapter, TerminalBenchQueueAdapterRun>> {
  return Object.fromEntries(
    selectedAdapters(adapter).map((adapterValue) => [
      adapterValue,
      {
        status: "pending",
        attempts: 0,
        last_run_id: null,
        last_failure_kind: null,
      },
    ]),
  ) as Partial<Record<Adapter, TerminalBenchQueueAdapterRun>>;
}

export function buildDockerCleanupCommand(input: {
  taskId: string;
  runId: string;
  dataset: string;
  homeDir: string;
  removeImages: boolean;
}): { command: "docker"; args: string[]; env: Record<string, string> } {
  const parsed = parseDatasetSpec(input.dataset);
  assertSafeDatasetSegment(parsed.name);
  assertSafeDatasetSegment(parsed.version);
  assertSafeTaskId(input.taskId);
  assertSafeRunId(input.runId);
  const project = `${slugTaskId(input.taskId)}-1-of-1-${input.runId}`;
  const imagePrefix = `tb__${input.taskId.replace(/\./gu, "-")}`;
  const composePath = path.join(
    input.homeDir,
    ".cache",
    "terminal-bench",
    parsed.name,
    parsed.version,
    input.taskId,
    "docker-compose.yaml",
  );
  return {
    command: "docker",
    args: [
      "compose",
      "-p",
      project,
      "-f",
      composePath,
      "down",
      ...(input.removeImages ? ["--rmi", "all"] : []),
      "--volumes",
    ],
    env: {
      T_BENCH_TASK_DOCKER_CLIENT_CONTAINER_NAME: project,
      T_BENCH_TASK_DOCKER_CLIENT_IMAGE_NAME: `${imagePrefix}__client`,
      T_BENCH_TASK_DOCKER_NAME_PREFIX: imagePrefix,
      T_BENCH_CONTAINER_LOGS_PATH: "/logs",
      T_BENCH_CONTAINER_AGENT_LOGS_PATH: "/agent-logs",
      T_BENCH_TEST_DIR: "/tests",
      T_BENCH_TASK_LOGS_PATH: input.homeDir,
      T_BENCH_TASK_AGENT_LOGS_PATH: input.homeDir,
    },
  };
}

function runDockerCleanup(input: {
  taskId: string;
  runId: string;
  dataset: string;
  cacheHome: string;
  deps: RuntimeDeps;
  env: NodeJS.ProcessEnv;
  removeImages: boolean;
}): { command: "docker"; args: string[]; result: SpawnSyncReturns<Buffer> } {
  const cleanup = buildDockerCleanupCommand({
    taskId: input.taskId,
    runId: input.runId,
    dataset: input.dataset,
    homeDir: input.cacheHome,
    removeImages: input.removeImages,
  });
  return {
    ...cleanup,
    result: input.deps.spawn(cleanup.command, cleanup.args, {
      cwd: input.deps.cwd,
      env: {
        ...input.env,
        ...cleanup.env,
      },
    }),
  };
}

function runQueueDockerCleanup(input: {
  adapter: Adapter;
  phase: DockerCleanupPhase;
  taskId: string;
  runId: string;
  dataset: string;
  cacheHome: string;
  deps: RuntimeDeps;
  env: NodeJS.ProcessEnv;
}): DockerCleanupRun {
  const cleanup = runDockerCleanup({
    taskId: input.taskId,
    runId: input.runId,
    dataset: input.dataset,
    cacheHome: input.cacheHome,
    deps: input.deps,
    env: input.env,
    removeImages: false,
  });
  return {
    adapter: input.adapter,
    phase: input.phase,
    runId: input.runId,
    command: cleanup.command,
    args: cleanup.args,
    result: cleanup.result,
  };
}

export function discoverTerminalBenchTaskIds(input: {
  dataset: string;
  homeDir: string;
  cwd: string;
}): string[] {
  const parsed = parseDatasetSpec(input.dataset);
  const candidates = [
    path.join(input.homeDir, ".cache", "terminal-bench", parsed.name, parsed.version),
    path.join(input.cwd, ".cache", "terminal-bench", parsed.name, parsed.version),
  ];
  const taskIds = new Set<string>();
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    for (const entry of readdirSync(candidate)) {
      const fullPath = path.join(candidate, entry);
      if (statSync(fullPath).isDirectory() && existsSync(path.join(fullPath, "docker-compose.yaml"))) {
        taskIds.add(entry);
      }
    }
  }
  if (taskIds.size > 0) {
    return [...taskIds].sort();
  }
  throw new Error(`Unable to discover Terminal-Bench task ids for ${input.dataset}. Run a preflight task or provide --task-id.`);
}

function resolveTerminalBenchTaskCacheHome(input: {
  dataset: string;
  taskId: string;
  homeDir: string;
  cwd: string;
}): string {
  const parsed = parseDatasetSpec(input.dataset);
  const candidates = [input.homeDir, input.cwd];
  for (const candidate of candidates) {
    const composePath = path.join(
      candidate,
      ".cache",
      "terminal-bench",
      parsed.name,
      parsed.version,
      input.taskId,
      "docker-compose.yaml",
    );
    if (existsSync(composePath)) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve Terminal-Bench cache root for task ${input.taskId}.`);
}

export function createTerminalBenchQueue(input: {
  dataset: string;
  adapter: AdapterSelection;
  taskIds: string[];
  createdAt: string;
}): TerminalBenchQueueState {
  return {
    dataset: input.dataset,
    adapter: input.adapter,
    created_at: input.createdAt,
    tasks: input.taskIds.map((taskId) => ({
      task_id: taskId,
      status: "pending",
      attempts: 0,
      last_run_id: null,
      last_failure_kind: null,
      adapter_runs: createQueueAdapterRuns(input.adapter),
    })),
  };
}

export function markQueueTaskPassed(queue: TerminalBenchQueueState, taskId: string, runId: string): void {
  const task = requireQueueTask(queue, taskId);
  task.status = "passed";
  task.last_run_id = runId;
  task.last_failure_kind = null;
}

export function markQueueTaskFailed(
  queue: TerminalBenchQueueState,
  taskId: string,
  runId: string,
  failureKind: string,
): void {
  const task = requireQueueTask(queue, taskId);
  task.status = "failed";
  task.last_run_id = runId;
  task.last_failure_kind = failureKind;
}

export function collectPreflightIssues(input: {
  tbVersion: SpawnSyncReturns<Buffer>;
  uvVersion?: SpawnSyncReturns<Buffer> | undefined;
  dockerInfo: SpawnSyncReturns<Buffer>;
  env: NodeJS.ProcessEnv;
}): string[] {
  const issues: string[] = [];

  if (input.tbVersion.error !== undefined || input.tbVersion.status !== 0) {
    if (input.uvVersion?.error !== undefined || input.uvVersion?.status !== 0) {
      issues.push("Terminal-Bench CLI is not available, and uv is not installed. Run: pnpm run bench:terminal -- bootstrap");
    } else {
      issues.push("Terminal-Bench CLI is not available. Run: pnpm run bench:terminal -- bootstrap");
    }
  }

  if (input.dockerInfo.error !== undefined || input.dockerInfo.status !== 0) {
    issues.push("Docker is not available. Run: pnpm run bench:terminal -- bootstrap");
  }
  const buildxIssue = checkDockerBuildxActivityAccess(input.env);
  if (buildxIssue !== undefined) {
    issues.push(buildxIssue);
  }

  issues.push(...benchmarkProviderIssues(input.env));

  return issues;
}

function checkDockerBuildxActivityAccess(env: NodeJS.ProcessEnv): string | undefined {
  const home = readNonEmptyEnv(env, "HOME");
  const dockerConfig = readNonEmptyEnv(env, "DOCKER_CONFIG") ?? (home !== undefined ? path.join(home, ".docker") : undefined);
  if (dockerConfig === undefined) {
    return ;
  }
  const activityDir = path.join(dockerConfig, "buildx", "activity");
  if (!existsSync(activityDir)) {
    return ;
  }
  try {
    accessSync(activityDir, constants.W_OK);
    return ;
  } catch {
    return `Docker Buildx activity directory is not writable: ${activityDir}. Live Terminal-Bench Docker builds may fail before Kestrel starts; rerun with host approval/unsandboxed execution.`;
  }
}

function readNonEmptyEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveTerminalBenchBinary(input: {
  requestedBinary: string;
  spawn: typeof spawnSync;
  env: NodeJS.ProcessEnv;
}): TerminalBenchBinaryResolution {
  const requestedVersion = input.spawn(input.requestedBinary, ["--help"], { env: input.env });
  if (requestedVersion.status === 0 && requestedVersion.error === undefined) {
    return {
      binary: input.requestedBinary,
      version: requestedVersion,
    };
  }

  if (input.requestedBinary !== "tb") {
    return {
      binary: input.requestedBinary,
      version: requestedVersion,
    };
  }

  const uvBinDir = input.spawn("uv", ["tool", "dir", "--bin"], { env: input.env });
  const binDir = uvBinDir.status === 0 && uvBinDir.error === undefined
    ? uvBinDir.stdout.toString("utf8").trim()
    : "";
  if (binDir.length === 0) {
    return {
      binary: input.requestedBinary,
      version: requestedVersion,
    };
  }

  for (const candidateName of ["tb", "terminal-bench"]) {
    const candidate = path.join(binDir, candidateName);
    const candidateVersion = input.spawn(candidate, ["--help"], { env: input.env });
    if (candidateVersion.status === 0 && candidateVersion.error === undefined) {
      return {
        binary: candidate,
        version: candidateVersion,
      };
    }
  }

  return {
    binary: input.requestedBinary,
    version: requestedVersion,
  };
}

export function resolveDockerHost(input: {
  spawn: typeof spawnSync;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  if (hasEnvValue(input.env.DOCKER_HOST)) {
    return input.env.DOCKER_HOST;
  }

  const result = input.spawn("docker", [
    "context",
    "inspect",
    "--format",
    "{{json .Endpoints.docker.Host}}",
  ], { env: input.env });
  if (result.status !== 0 || result.error !== undefined) {
    return ;
  }

  const raw = result.stdout.toString("utf8").trim();
  if (raw.length === 0) {
    return ;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined;
  } catch {
    return raw;
  }
}

export function formatCommand(binary: string, args: string[]): string {
  return [binary, ...args].map(shellQuote).join(" ");
}

export async function runTerminalBench(argv: string[], deps: RuntimeDeps): Promise<number> {
  let options: TerminalBenchOptions;
  try {
    options = parseTerminalBenchArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      deps.stdout.write(helpText());
      return 0;
    }
    deps.stderr.write(`bench:terminal failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
    deps.stderr.write(helpText());
    return 1;
  }

  const initialEnv: NodeJS.ProcessEnv = {
    ...deps.env,
    KESTREL_TBENCH_REPO_ROOT: deps.env.KESTREL_TBENCH_REPO_ROOT ?? deps.cwd,
  };
  const providerWarnings = benchmarkProviderWarnings(initialEnv);
  const baseEnv: NodeJS.ProcessEnv = benchmarkProviderEnv(initialEnv);

  if (options.mode === "cleanup") {
    return runTerminalBenchCleanup({ options, deps, env: baseEnv });
  }

  const dockerHost = resolveDockerHost({ spawn: deps.spawn, env: baseEnv });
  const env = dockerHost === undefined
    ? baseEnv
    : {
        ...baseEnv,
        DOCKER_HOST: dockerHost,
      };

  if (options.mode === "bootstrap") {
    for (const warning of providerWarnings) {
      deps.stderr.write(`[bench:terminal] ${warning}\n`);
    }
    return runBootstrap(options, deps, env);
  }

  const tbResolution = options.dryRun
    ? { binary: options.tbBin, version: passedSpawnResult() }
    : resolveTerminalBenchBinary({
        requestedBinary: options.tbBin,
        spawn: deps.spawn,
        env,
      });

  const issues = options.dryRun
    ? []
    : collectPreflightIssues({
        tbVersion: tbResolution.version,
        uvVersion: deps.spawn("uv", ["--version"], { env }),
        dockerInfo: deps.spawn("docker", ["info"], { env }),
        env: initialEnv,
      });

  if (issues.length > 0) {
    for (const issue of issues) {
      deps.stderr.write(`[bench:terminal] ${issue}\n`);
    }
    return 1;
  }
  for (const warning of providerWarnings) {
    deps.stderr.write(`[bench:terminal] ${warning}\n`);
  }

  if (options.mode === "improve") {
    return runImproveLoop(options, deps, env, tbResolution.binary);
  }

  const commands = buildTerminalBenchCommands(options);
  deps.stdout.write(
    `[bench:terminal] dataset=${options.dataset} task=${options.taskId ?? "full"} adapters=${commands
      .map((command) => command.adapter)
      .join(",")}\n`,
  );

  for (const command of commands) {
    const benchmark = runBenchmarkCommand({
      command,
      tbBin: tbResolution.binary,
      deps,
      env,
      dryRun: options.dryRun,
    });
    if (options.dryRun) {
      continue;
    }
    if (benchmark.status !== 0) {
      if (benchmark.outcome?.benchmarkSetupFailure !== undefined) {
        deps.stderr.write(
          renderBenchmarkSetupFailure(command.adapter, benchmark.outcome.benchmarkSetupFailure),
        );
      } else if (benchmark.failureKind !== undefined) {
        deps.stderr.write(
          `[bench:terminal] ${command.adapter} failed: ${benchmark.failureKind}. ${benchmark.failureNotes ?? ""}\n`,
        );
      }
      return benchmark.status;
    }
    const outcome = benchmark.outcome;
    if (outcome !== undefined) {
      deps.stdout.write(
        `[bench:terminal] ${command.adapter}: resolved=${outcome.nResolved} unresolved=${outcome.nUnresolved} accuracy=${outcome.accuracy}\n`,
      );
      if (outcome.artifactPassedButAgentFailed) {
        deps.stderr.write(
          [
            `[bench:terminal] ${command.adapter} failed: artifact_passed_but_agent_failed.`,
            "Terminal-Bench resolved the artifact, but the Kestrel adapter result failed.",
            ...outcome.adapterFailures.map((failure) =>
              `- ${failure.path}: status=${failure.status} failure_kind=${failure.failureKind ?? "unknown"} task=${failure.taskId ?? "unknown"}`
            ),
            "",
          ].join("\n"),
        );
        return 1;
      }
      if (outcome.nUnresolved > 0) {
        if (outcome.benchmarkSetupFailure !== undefined) {
          deps.stderr.write(renderBenchmarkSetupFailure(command.adapter, outcome.benchmarkSetupFailure));
          return 1;
        }
        const primaryFailure = primaryAdapterFailure(outcome);
        if (primaryFailure !== undefined) {
          deps.stderr.write(
            [
              `[bench:terminal] ${command.adapter} failed: ${primaryFailure.failureKind ?? "adapter_failed"}.`,
              `Terminal-Bench reported unresolved tasks: ${outcome.unresolvedIds.join(", ")}`,
              `- ${primaryFailure.path}: status=${primaryFailure.status} task=${primaryFailure.taskId ?? "unknown"}`,
              "",
            ].join("\n"),
          );
          return 1;
        }
        if (outcome.adapterCompletedButBenchmarkFailed) {
          deps.stderr.write(
            [
              `[bench:terminal] ${command.adapter} failed: tb_verifier_failed_after_adapter_completed.`,
              `Kestrel adapter completed, but Terminal-Bench reported unresolved tasks: ${outcome.unresolvedIds.join(", ")}`,
              ...(outcome.failureMode !== undefined ? [`Terminal-Bench failure_mode=${outcome.failureMode}`] : []),
              "",
            ].join("\n"),
          );
          return 1;
        }
        deps.stderr.write(
          `[bench:terminal] ${command.adapter} failed: Terminal-Bench reported unresolved tasks: ${outcome.unresolvedIds.join(", ")}\n`,
        );
        return 1;
      }
    }
  }

  deps.stdout.write(
    options.dryRun
      ? "[bench:terminal] dry run complete. No Terminal-Bench tasks were started.\n"
      : "[bench:terminal] complete. Kestrel artifacts are written with the Terminal-Bench run logs.\n",
  );
  return 0;
}

function adapterFromMode(mode: CommandMode): AdapterSelection {
  return "kestrel";
}

function requireQueueTask(queue: TerminalBenchQueueState, taskId: string): TerminalBenchQueueTask {
  const task = queue.tasks.find((candidate) => candidate.task_id === taskId);
  if (task === undefined) {
    throw new Error(`Queue task not found: ${taskId}`);
  }
  return task;
}

function parseDatasetSpec(dataset: string): { name: string; version: string } {
  const parts = dataset.split("==");
  if (parts.length !== 2 || parts[0]?.length === 0 || parts[1]?.length === 0) {
    throw new Error(`Unsupported Terminal-Bench dataset format: ${dataset}`);
  }
  const [name, version] = parts as [string, string];
  return { name, version };
}

function slugTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]+/gu, "-").toLowerCase();
}

function assertSafeDatasetSegment(segment: string): void {
  if (!isSafePathSegment(segment, /^[a-zA-Z0-9._-]+$/u)) {
    throw new Error(`Unsafe Terminal-Bench dataset segment: ${segment}`);
  }
}

function assertSafeTaskId(taskId: string): void {
  if (!isSafePathSegment(taskId, /^[a-zA-Z0-9._-]+$/u)) {
    throw new Error(`Unsafe Terminal-Bench task id: ${taskId}`);
  }
}

function assertSafeRunId(runId: string): void {
  if (!isSafePathSegment(runId, /^[a-zA-Z0-9_-]+$/u)) {
    throw new Error(`Unsafe Terminal-Bench run id: ${runId}`);
  }
}

function isSafePathSegment(value: string, allowedPattern: RegExp): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    allowedPattern.test(value)
  );
}

function runImproveLoop(
  options: TerminalBenchOptions,
  deps: RuntimeDeps,
  env: NodeJS.ProcessEnv,
  tbBin: string,
): number {
  const commands = buildTerminalBenchCommands(options);
  const startedAt = runStamp();
  const artifactRoot = path.join(deps.cwd, IMPROVE_ARTIFACT_ROOT, startedAt);

  deps.stdout.write(
    `[bench:terminal] improve: dataset=${options.dataset} task=${options.taskId ?? "full"} adapters=${commands
      .map((command) => command.adapter)
      .join(",")} maxIterations=${options.maxIterations} executor=${options.executor}\n`,
  );

  if (options.dryRun) {
    for (const command of commands) {
      const args = buildRunArgs(command, `${KESTREL_ARTIFACT_PREFIX}-${runStamp()}`);
      deps.stdout.write(`[bench:terminal] improve dry-run: ${formatCommand(tbBin, args)}\n`);
    }
    deps.stdout.write(`[bench:terminal] improve dry-run: would write artifacts under ${path.relative(deps.cwd, artifactRoot)}\n`);
    deps.stdout.write(`[bench:terminal] improve dry-run: would invoke ${formatCommand("codex", buildCodexExecArgs(deps.cwd, env))}\n`);
    return 0;
  }

  const clean = checkCleanWorktree(deps);
  if (!clean.clean) {
    deps.stderr.write("[bench:terminal] improve requires a clean git worktree before it starts.\n");
    deps.stderr.write(clean.details);
    return 1;
  }

  mkdirSync(artifactRoot, { recursive: true });
  if (options.taskId === undefined) {
    return runImproveQueueLoop({
      options,
      deps,
      env,
      tbBin,
      artifactRoot,
      commands,
    });
  }

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    const iterationDir = path.join(artifactRoot, `iteration-${String(iteration).padStart(2, "0")}`);
    mkdirSync(iterationDir, { recursive: true });
    deps.stdout.write(`[bench:terminal] improve: iteration ${iteration}/${options.maxIterations}\n`);

    const benchmarkRuns = commands.map((command) =>
      runBenchmarkCommand({
        command,
        tbBin,
        deps,
        env,
        dryRun: false,
      }),
    );
    writeFileSync(
      path.join(iterationDir, "benchmark-command.txt"),
      benchmarkRuns.map((run) => formatCommand(tbBin, run.args)).join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(iterationDir, "benchmark-summary.json"),
      JSON.stringify({ iteration, benchmarkRuns }, null, 2) + "\n",
      "utf8",
    );

    const failedRuns = benchmarkRuns.filter((run) =>
      run.status !== 0 || run.outcome === undefined || run.outcome.nUnresolved > 0
    );
    if (failedRuns.length === 0) {
      writeFileSync(
        path.join(artifactRoot, "summary.json"),
        JSON.stringify({ status: "passed", iterations: iteration - 1, benchmarkRuns }, null, 2) + "\n",
        "utf8",
      );
      deps.stdout.write("[bench:terminal] improve: selected benchmark target passes.\n");
      return 0;
    }

    const repair = runImproveRepair({
      options,
      deps,
      env,
      tbBin,
      iteration,
      taskId: options.taskId,
      failedRuns,
      artifactRoot,
      iterationDir,
      commands,
    });
    if (repair.status === "failed") {
      return repair.code;
    }
  }

  writeFileSync(
    path.join(artifactRoot, "summary.json"),
    JSON.stringify({ status: "max_iterations_exhausted", maxIterations: options.maxIterations }, null, 2) + "\n",
    "utf8",
  );
  deps.stderr.write(`[bench:terminal] improve failed: target did not pass within ${options.maxIterations} iterations.\n`);
  return 1;
}

function runImproveQueueLoop(input: {
  options: TerminalBenchOptions;
  deps: RuntimeDeps;
  env: NodeJS.ProcessEnv;
  tbBin: string;
  artifactRoot: string;
  commands: TerminalBenchCommand[];
}): number {
  let taskIds: string[];
  try {
    taskIds = discoverTerminalBenchTaskIds({
      dataset: input.options.dataset,
      homeDir: input.env.HOME ?? input.deps.cwd,
      cwd: input.deps.cwd,
    });
  } catch (error) {
    input.deps.stderr.write(`[bench:terminal] improve failed: ${(error as Error).message}\n`);
    return 1;
  }

  const queue = createTerminalBenchQueue({
    dataset: input.options.dataset,
    adapter: input.options.adapter,
    taskIds,
    createdAt: new Date().toISOString(),
  });
  writeQueue(input.artifactRoot, queue);

  for (const [index, taskId] of taskIds.entries()) {
    const task = requireQueueTask(queue, taskId);
    task.status = "running";
    task.attempts += 1;
    writeQueue(input.artifactRoot, queue);

    const taskCommands = input.commands.map((command) => withTaskId(command, taskId));
    const iteration = index + 1;
    const iterationDir = path.join(input.artifactRoot, `task-${String(iteration).padStart(3, "0")}-${slugTaskId(taskId)}`);
    mkdirSync(iterationDir, { recursive: true });
    input.deps.stdout.write(`[bench:terminal] improve: queue task ${iteration}/${taskIds.length} ${taskId}\n`);

    const taskCacheHome = resolveTerminalBenchTaskCacheHome({
      dataset: input.options.dataset,
      taskId,
      homeDir: input.env.HOME ?? input.deps.cwd,
      cwd: input.deps.cwd,
    });
    const cleanupRuns: DockerCleanupRun[] = [];
    const benchmarkRuns = taskCommands.map((command, commandIndex) => {
      const runId = buildQueueRunId({
        command,
        taskId,
        taskIndex: iteration,
        commandIndex: commandIndex + 1,
        phase: "queue",
      });
      cleanupRuns.push(runQueueDockerCleanup({
        adapter: command.adapter,
        phase: "pre",
        taskId,
        runId,
        dataset: input.options.dataset,
        cacheHome: taskCacheHome,
        deps: input.deps,
        env: input.env,
      }));
      const run = runBenchmarkCommand({
        command,
        tbBin: input.tbBin,
        deps: input.deps,
        env: input.env,
        dryRun: false,
        runId,
      });
      cleanupRuns.push(runQueueDockerCleanup({
        adapter: command.adapter,
        phase: "post",
        taskId,
        runId,
        dataset: input.options.dataset,
        cacheHome: taskCacheHome,
        deps: input.deps,
        env: input.env,
      }));
      recordQueueAdapterRun({
        queue,
        taskId,
        run,
        status: run.status === 0 && run.outcome !== undefined && run.outcome.nUnresolved === 0 ? "passed" : "failed",
        failureKind: run.status === 0 && run.outcome !== undefined && run.outcome.nUnresolved === 0
          ? null
          : classifyBenchmarkFailure(run),
      });
      return run;
    });
    summarizeQueueTask(queue, taskId);
    writeQueue(input.artifactRoot, queue);
    writeFileSync(
      path.join(iterationDir, "benchmark-command.txt"),
      benchmarkRuns.map((run) => formatCommand(input.tbBin, run.args)).join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(iterationDir, "benchmark-summary.json"),
      JSON.stringify({ iteration, taskId, benchmarkRuns }, null, 2) + "\n",
      "utf8",
    );

    const failedRuns = benchmarkRuns.filter((run) =>
      run.status !== 0 || run.outcome === undefined || run.outcome.nUnresolved > 0
    );
    if (failedRuns.length === 0) {
      writeQueue(input.artifactRoot, queue);
      continue;
    }

    writeFileSync(
      path.join(iterationDir, "docker-cleanup.txt"),
      renderDockerCleanupRuns(cleanupRuns),
      "utf8",
    );

    const failedRun = failedRuns[0] as BenchmarkRunRecord;
    const failedAdapters = new Set(failedRuns.map((run) => run.adapter));
    const failedTaskCommands = taskCommands.filter((command) => failedAdapters.has(command.adapter));
    writeQueue(input.artifactRoot, queue);

    const repair = runImproveRepair({
      options: input.options,
      deps: input.deps,
      env: input.env,
      tbBin: input.tbBin,
      iteration,
      taskId,
      failedRuns,
      artifactRoot: input.artifactRoot,
      iterationDir,
      commands: failedTaskCommands,
      runIdForCommand: (command, commandIndex) => buildQueueRunId({
        command,
        taskId,
        taskIndex: iteration,
        commandIndex: commandIndex + 1,
        phase: "verify",
      }),
      queueCleanup: {
        taskId,
        dataset: input.options.dataset,
        cacheHome: taskCacheHome,
        record: (run) => cleanupRuns.push(run),
      },
    });
    writeFileSync(
      path.join(iterationDir, "docker-cleanup.txt"),
      renderDockerCleanupRuns(cleanupRuns),
      "utf8",
    );
    if (repair.status === "failed") {
      return repair.code;
    }
    for (const verificationRun of repair.verificationRuns) {
      recordQueueAdapterRun({
        queue,
        taskId,
        run: verificationRun,
        status: "passed",
        failureKind: null,
      });
    }
    summarizeQueueTask(queue, taskId);
    writeQueue(input.artifactRoot, queue);
    writeFileSync(
      path.join(input.artifactRoot, "summary.json"),
      JSON.stringify({ status: "repaired", taskId, queue }, null, 2) + "\n",
      "utf8",
    );
    input.deps.stdout.write(`[bench:terminal] improve: repaired ${taskId}; continuing queue.\n`);
  }

  writeFileSync(
    path.join(input.artifactRoot, "summary.json"),
    JSON.stringify({ status: "passed", taskCount: taskIds.length, queue }, null, 2) + "\n",
    "utf8",
  );
  input.deps.stdout.write("[bench:terminal] improve: full task queue passes.\n");
  return 0;
}

function writeQueue(artifactRoot: string, queue: TerminalBenchQueueState): void {
  writeFileSync(path.join(artifactRoot, "queue.json"), JSON.stringify(queue, null, 2) + "\n", "utf8");
}

function runTerminalBenchCleanup(input: {
  options: TerminalBenchOptions;
  deps: RuntimeDeps;
  env: NodeJS.ProcessEnv;
}): number {
  const queuePaths = discoverImproveQueueFiles(input.deps.cwd);
  if (queuePaths.length === 0) {
    input.deps.stdout.write("[bench:terminal] cleanup: no recorded improvement queues found; cleaned=0\n");
    return 0;
  }

  const targets = collectCleanupTargets(queuePaths);
  if (targets.length === 0) {
    input.deps.stdout.write(`[bench:terminal] cleanup: scanned ${queuePaths.length} queues; cleaned=0\n`);
    return 0;
  }

  const dockerHost = resolveDockerHost({ spawn: input.deps.spawn, env: input.env });
  const env = dockerHost === undefined
    ? input.env
    : {
        ...input.env,
        DOCKER_HOST: dockerHost,
      };
  const dockerInfo = input.options.dryRun ? passedSpawnResult() : input.deps.spawn("docker", ["info"], { env });
  if (dockerInfo.status !== 0 || dockerInfo.error !== undefined) {
    input.deps.stderr.write("[bench:terminal] Docker is not available. Run: pnpm run bench:terminal -- bootstrap\n");
    return 1;
  }

  let cleaned = 0;
  const failures: string[] = [];
  for (const target of targets) {
    try {
      const cacheHome = resolveTerminalBenchTaskCacheHome({
        dataset: target.dataset,
        taskId: target.taskId,
        homeDir: env.HOME ?? input.deps.cwd,
        cwd: input.deps.cwd,
      });
      const cleanup = buildDockerCleanupCommand({
        taskId: target.taskId,
        runId: target.runId,
        dataset: target.dataset,
        homeDir: cacheHome,
        removeImages: false,
      });
      input.deps.stdout.write(`[bench:terminal] cleanup: ${formatCommand(cleanup.command, cleanup.args)}\n`);
      if (input.options.dryRun) {
        cleaned += 1;
        continue;
      }
      const result = runDockerCleanup({
        taskId: target.taskId,
        runId: target.runId,
        dataset: target.dataset,
        cacheHome,
        deps: input.deps,
        env,
        removeImages: false,
      });
      if (result.result.status !== 0 || result.result.error !== undefined) {
        failures.push(`${target.taskId} ${target.runId}: ${renderSpawnOutput(result.result)}`);
        continue;
      }
      cleaned += 1;
    } catch (error) {
      failures.push(`${target.taskId} ${target.runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  input.deps.stdout.write(
    `[bench:terminal] cleanup: scanned ${queuePaths.length} queues; targets=${targets.length} cleaned=${cleaned} failed=${failures.length}\n`,
  );
  if (failures.length > 0) {
    input.deps.stderr.write("[bench:terminal] cleanup failed for scoped projects:\n");
    for (const failure of failures) {
      input.deps.stderr.write(`- ${failure.trim()}\n`);
    }
    return 1;
  }
  return 0;
}

function discoverImproveQueueFiles(cwd: string): string[] {
  const root = path.join(cwd, IMPROVE_ARTIFACT_ROOT);
  if (!existsSync(root)) {
    return [];
  }
  const queuePaths: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile() && entry === "queue.json") {
        queuePaths.push(fullPath);
      }
    }
  };
  visit(root);
  return queuePaths.sort();
}

function collectCleanupTargets(queuePaths: string[]): Array<{ dataset: string; taskId: string; runId: string }> {
  const targets = new Map<string, { dataset: string; taskId: string; runId: string }>();
  for (const queuePath of queuePaths) {
    const queue = readTerminalBenchQueue(queuePath);
    for (const task of queue.tasks) {
      addCleanupTarget(targets, queue.dataset, task.task_id, task.last_run_id);
      if (task.adapter_runs === undefined) {
        continue;
      }
      for (const adapterRun of Object.values(task.adapter_runs)) {
        if (adapterRun !== undefined) {
          addCleanupTarget(targets, queue.dataset, task.task_id, adapterRun.last_run_id);
        }
      }
    }
  }
  return [...targets.values()];
}

function addCleanupTarget(
  targets: Map<string, { dataset: string; taskId: string; runId: string }>,
  dataset: string,
  taskId: string,
  runId: string | null,
): void {
  if (runId === null) {
    return;
  }
  const key = `${dataset}|${taskId}|${runId}`;
  targets.set(key, { dataset, taskId, runId });
}

function readTerminalBenchQueue(queuePath: string): TerminalBenchQueueState {
  const parsed = JSON.parse(readFileSync(queuePath, "utf8")) as unknown;
  if (!isQueueState(parsed)) {
    throw new Error(`Invalid Terminal-Bench queue file: ${queuePath}`);
  }
  return parsed;
}

function isQueueState(value: unknown): value is TerminalBenchQueueState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.dataset === "string" &&
    (value.adapter === "kestrel" || value.adapter === "runtime" || value.adapter === "cli" || value.adapter === "both") &&
    typeof value.created_at === "string" &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isQueueTask)
  );
}

function isQueueTask(value: unknown): value is TerminalBenchQueueTask {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.task_id === "string" &&
    isQueueTaskStatus(value.status) &&
    typeof value.attempts === "number" &&
    (typeof value.last_run_id === "string" || value.last_run_id === null) &&
    (typeof value.last_failure_kind === "string" || value.last_failure_kind === null) &&
    (value.adapter_runs === undefined || isQueueAdapterRuns(value.adapter_runs))
  );
}

function isQueueAdapterRuns(value: unknown): value is Partial<Record<Adapter, TerminalBenchQueueAdapterRun>> {
  return isRecord(value) && Object.values(value).every((entry) => entry === undefined || isQueueAdapterRun(entry));
}

function isQueueAdapterRun(value: unknown): value is TerminalBenchQueueAdapterRun {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isQueueTaskStatus(value.status) &&
    typeof value.attempts === "number" &&
    (typeof value.last_run_id === "string" || value.last_run_id === null) &&
    (typeof value.last_failure_kind === "string" || value.last_failure_kind === null)
  );
}

function isQueueTaskStatus(value: unknown): value is TerminalBenchQueueTaskStatus {
  return value === "pending" || value === "running" || value === "passed" || value === "failed" || value === "skipped";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyBenchmarkFailure(run: BenchmarkRunRecord): string {
  if (run.outcome?.artifactPassedButAgentFailed === true) {
    return "artifact_passed_but_agent_failed";
  }
  if (run.outcome?.benchmarkSetupFailure !== undefined) {
    return run.outcome.benchmarkSetupFailure.kind;
  }
  if (run.outcome?.adapterCompletedButBenchmarkFailed === true) {
    return "tb_verifier_failed_after_adapter_completed";
  }
  const primaryFailure = run.outcome !== undefined ? primaryAdapterFailure(run.outcome) : undefined;
  if (primaryFailure?.failureKind !== undefined) {
    return primaryFailure.failureKind;
  }
  if (run.failureKind !== undefined) {
    return run.failureKind;
  }
  return run.outcome !== undefined && run.outcome.nUnresolved > 0 ? "tb_verifier_failed" : "tb_run_failed";
}

function primaryAdapterFailure(outcome: BenchmarkOutcome): AdapterResultFailure | undefined {
  return outcome.adapterFailures.find((failure) => failure.failureKind !== undefined)
    ?? outcome.adapterFailures[0];
}

function recordQueueAdapterRun(input: {
  queue: TerminalBenchQueueState;
  taskId: string;
  run: BenchmarkRunRecord;
  status: TerminalBenchQueueTaskStatus;
  failureKind: string | null;
}): void {
  const task = requireQueueTask(input.queue, input.taskId);
  task.adapter_runs ??= {};
  task.adapter_runs[input.run.adapter] ??= {
    status: "pending",
    attempts: 0,
    last_run_id: null,
    last_failure_kind: null,
  };
  const adapterRun = task.adapter_runs[input.run.adapter] as TerminalBenchQueueAdapterRun;
  adapterRun.status = input.status;
  adapterRun.attempts += 1;
  adapterRun.last_run_id = input.run.runId;
  adapterRun.last_failure_kind = input.failureKind;
}

function summarizeQueueTask(queue: TerminalBenchQueueState, taskId: string): void {
  const task = requireQueueTask(queue, taskId);
  const adapterRuns = selectedAdapters(queue.adapter)
    .map((adapter) => task.adapter_runs?.[adapter])
    .filter((run): run is TerminalBenchQueueAdapterRun => run !== undefined);
  const failedRun = adapterRuns.find((run) => run.status === "failed");
  if (failedRun !== undefined) {
    task.status = "failed";
    task.last_run_id = failedRun.last_run_id;
    task.last_failure_kind = failedRun.last_failure_kind;
    return;
  }
  const allPassed = adapterRuns.length === selectedAdapters(queue.adapter).length &&
    adapterRuns.every((run) => run.status === "passed");
  if (allPassed) {
    task.status = "passed";
    task.last_run_id = adapterRuns[adapterRuns.length - 1]?.last_run_id ?? null;
    task.last_failure_kind = null;
    return;
  }
  task.status = "running";
  task.last_failure_kind = null;
}

function buildQueueRunId(input: {
  command: TerminalBenchCommand;
  taskId: string;
  taskIndex: number;
  commandIndex: number;
  phase: "queue" | "verify";
}): string {
  assertSafeTaskId(input.taskId);
  return [
    KESTREL_ARTIFACT_PREFIX,
    slugTaskId(input.taskId),
    input.phase,
    runStamp(),
    String(input.taskIndex).padStart(3, "0"),
    String(input.commandIndex).padStart(2, "0"),
  ].join("-");
}

function withTaskId(command: TerminalBenchCommand, taskId: string): TerminalBenchCommand {
  assertSafeTaskId(taskId);
  const args = [...command.args];
  const existingIndex = args.indexOf("--task-id");
  if (existingIndex >= 0) {
    args[existingIndex + 1] = taskId;
  } else {
    args.push("--task-id", taskId);
  }
  return {
    adapter: command.adapter,
    args,
  };
}

function runImproveRepair(input: {
  options: TerminalBenchOptions;
  deps: RuntimeDeps;
  env: NodeJS.ProcessEnv;
  tbBin: string;
  iteration: number;
  taskId?: string | undefined;
  failedRuns: BenchmarkRunRecord[];
  artifactRoot: string;
  iterationDir: string;
  commands: TerminalBenchCommand[];
  runIdForCommand?: ((command: TerminalBenchCommand, commandIndex: number) => string) | undefined;
  queueCleanup?: {
    taskId: string;
    dataset: string;
    cacheHome: string;
    record: (run: DockerCleanupRun) => void;
  } | undefined;
}): { status: "repaired"; verificationRuns: BenchmarkRunRecord[] } | { status: "failed"; code: number } {
  const repairOptions = {
    ...input.options,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
  };
  const failurePacket = buildFailurePacket({
    iteration: input.iteration,
    dataset: input.options.dataset,
    taskId: input.taskId,
    runs: input.failedRuns,
    cwd: input.deps.cwd,
  });
  const failurePacketPath = path.join(input.iterationDir, "failure-packet.md");
  writeFileSync(failurePacketPath, failurePacket, "utf8");
  input.deps.stdout.write(`[bench:terminal] improve: failure packet written ${path.relative(input.deps.cwd, failurePacketPath)}\n`);

  const codexPrompt = buildCodexRepairPrompt({
    failurePacketPath,
    failurePacket,
    options: repairOptions,
  });
  const codexArgs = buildCodexExecArgs(input.deps.cwd, input.env);
  input.deps.stdout.write(`[bench:terminal] improve: Codex repair started: ${formatCommand("codex", codexArgs)}\n`);
  const codexResult = input.deps.spawn("codex", codexArgs, {
    cwd: input.deps.cwd,
    env: input.env,
    input: codexPrompt,
    stdio: ["pipe", "inherit", "inherit"],
  });
  const codexOutput = renderSpawnOutput(codexResult);
  writeFileSync(
    path.join(input.iterationDir, "codex-final.md"),
    codexOutput || `Codex output was streamed to the terminal.\nstatus=${codexResult.status ?? "unknown"}\n`,
    "utf8",
  );
  input.deps.stdout.write(`[bench:terminal] improve: Codex repair exited status=${codexResult.status ?? "unknown"}\n`);
  if (codexResult.status !== 0 || codexResult.error !== undefined) {
    writeFileSync(
      path.join(input.artifactRoot, "summary.json"),
      JSON.stringify({ status: "codex_failed", iteration: input.iteration, codexStatus: codexResult.status }, null, 2) + "\n",
      "utf8",
    );
    input.deps.stderr.write("[bench:terminal] improve failed: Codex repair command failed.\n");
    return { status: "failed", code: codexResult.status ?? 1 };
  }

  input.deps.stdout.write("[bench:terminal] improve: checking repair diff\n");
  const changed = checkCleanWorktree(input.deps);
  if (changed.clean) {
    writeFileSync(path.join(input.iterationDir, "verification.txt"), "No worktree changes after Codex repair.\n", "utf8");
    writeFileSync(
      path.join(input.artifactRoot, "summary.json"),
      JSON.stringify({ status: "no_repair_diff", iteration: input.iteration }, null, 2) + "\n",
      "utf8",
    );
    input.deps.stderr.write("[bench:terminal] improve failed: Codex completed without producing a diff.\n");
    return { status: "failed", code: 1 };
  }

  input.deps.stdout.write("[bench:terminal] improve: checking repair policy\n");
  const repairPolicy = checkTerminalBenchRepairPolicy(input.deps);
  writeFileSync(path.join(input.iterationDir, "repair-policy.txt"), repairPolicy.output, "utf8");
  if (!repairPolicy.passed) {
    writeFileSync(
      path.join(input.artifactRoot, "summary.json"),
      JSON.stringify({
        status: "repair_policy_failed",
        iteration: input.iteration,
        violations: repairPolicy.violations,
      }, null, 2) + "\n",
      "utf8",
    );
    input.deps.stderr.write("[bench:terminal] improve failed: Codex repair changed forbidden benchmark/artifact paths.\n");
    return { status: "failed", code: 1 };
  }
  input.deps.stdout.write("[bench:terminal] improve: repair policy passed\n");

  input.deps.stdout.write("[bench:terminal] improve: verification started\n");
  const verification = runImproveVerification({
    commands: input.commands,
    tbBin: input.tbBin,
    deps: input.deps,
    env: input.env,
    iterationDir: input.iterationDir,
    runIdForCommand: input.runIdForCommand,
    queueCleanup: input.queueCleanup,
  });
  writeFileSync(path.join(input.iterationDir, "verification.txt"), verification.output, "utf8");
  if (!verification.passed) {
    writeFileSync(
      path.join(input.artifactRoot, "summary.json"),
      JSON.stringify({ status: "verification_failed", iteration: input.iteration }, null, 2) + "\n",
      "utf8",
    );
    input.deps.stderr.write("[bench:terminal] improve failed: verification failed; leaving changes uncommitted.\n");
    return { status: "failed", code: 1 };
  }
  input.deps.stdout.write("[bench:terminal] improve: verification passed\n");

  input.deps.stdout.write("[bench:terminal] improve: committing verified repair\n");
  const commit = commitImproveIteration({
    deps: input.deps,
    adapterLabel: input.options.adapter,
    taskId: input.taskId,
    iteration: input.iteration,
    changedPaths: repairPolicy.changedPaths,
  });
  writeFileSync(path.join(input.iterationDir, "commit.json"), JSON.stringify(commit, null, 2) + "\n", "utf8");
  if (!commit.committed) {
    writeFileSync(
      path.join(input.artifactRoot, "summary.json"),
      JSON.stringify({ status: "commit_failed", iteration: input.iteration, commitStatus: commit.status }, null, 2) + "\n",
      "utf8",
    );
    input.deps.stderr.write("[bench:terminal] improve failed: commit step failed after verification.\n");
    return { status: "failed", code: commit.status ?? 1 };
  }
  input.deps.stdout.write(`[bench:terminal] improve: committed ${commit.sha ?? "iteration"}\n`);
  return { status: "repaired", verificationRuns: verification.reruns };
}

function runBootstrap(
  options: TerminalBenchOptions,
  deps: RuntimeDeps,
  env: NodeJS.ProcessEnv,
): number {
  deps.stdout.write("[bench:terminal] bootstrap: checking Terminal-Bench CLI\n");
  const tbResolution = resolveTerminalBenchBinary({
    requestedBinary: options.tbBin,
    spawn: deps.spawn,
    env,
  });
  const tbVersion = tbResolution.version;
  if (tbVersion.status === 0 && tbVersion.error === undefined) {
    deps.stdout.write(`[bench:terminal] bootstrap: tb is already installed at ${tbResolution.binary}\n`);
  } else {
    const uvVersion = deps.spawn("uv", ["--version"], { env });
    if (uvVersion.status !== 0 || uvVersion.error !== undefined) {
      deps.stdout.write("[bench:terminal] bootstrap: uv is missing\n");
      const brewVersion = deps.spawn("brew", ["--version"], { env });
      if (brewVersion.status !== 0 || brewVersion.error !== undefined) {
        deps.stderr.write("[bench:terminal] bootstrap failed: Homebrew is required to install uv automatically.\n");
        deps.stderr.write("[bench:terminal] Install uv manually, then rerun: pnpm run bench:terminal -- bootstrap\n");
        return 1;
      }
      if (options.dryRun) {
        deps.stdout.write("[bench:terminal] bootstrap: would run brew install uv\n");
      } else {
        deps.stdout.write("[bench:terminal] bootstrap: running brew install uv\n");
        const result = deps.spawn("brew", ["install", "uv"], { env, stdio: "inherit" });
        if (result.status !== 0) {
          return result.status ?? 1;
        }
      }
    } else {
      deps.stdout.write("[bench:terminal] bootstrap: uv is already installed\n");
    }

    if (options.dryRun) {
      deps.stdout.write(`[bench:terminal] bootstrap: would run ${formatCommand("uv", terminalBenchInstallArgs())}\n`);
    } else {
      deps.stdout.write(
        `[bench:terminal] bootstrap: running ${formatCommand("uv", terminalBenchInstallArgs())}\n`,
      );
      const result = deps.spawn("uv", terminalBenchInstallArgs(), { env, stdio: "inherit" });
      if (result.status !== 0) {
        return result.status ?? 1;
      }
      const repaired = resolveTerminalBenchBinary({
        requestedBinary: options.tbBin,
        spawn: deps.spawn,
        env,
      });
      if (repaired.version.status !== 0 || repaired.version.error !== undefined) {
        deps.stderr.write("[bench:terminal] bootstrap failed: Terminal-Bench was installed but still does not run.\n");
        deps.stderr.write(formatSpawnFailure(repaired.version));
        return 1;
      }
      deps.stdout.write(`[bench:terminal] bootstrap: tb is ready at ${repaired.binary}\n`);
    }
  }

  deps.stdout.write("[bench:terminal] bootstrap: checking Docker\n");
  const dockerInfo = deps.spawn("docker", ["info"], { env });
  if (dockerInfo.status === 0 && dockerInfo.error === undefined) {
    deps.stdout.write("[bench:terminal] bootstrap: Docker is running\n");
  } else if ((deps.platform ?? process.platform) === "darwin") {
    if (options.dryRun) {
      deps.stdout.write("[bench:terminal] bootstrap: would run open -a Docker and wait for docker info\n");
    } else {
      deps.stdout.write("[bench:terminal] bootstrap: starting Docker Desktop\n");
      const openResult = deps.spawn("open", ["-a", "Docker"], { env, stdio: "inherit" });
      if (openResult.status !== 0) {
        deps.stderr.write("[bench:terminal] bootstrap failed: could not start Docker Desktop with `open -a Docker`.\n");
        return openResult.status ?? 1;
      }
      const waitResult = waitForDocker(deps, env);
      if (waitResult !== 0) {
        return waitResult;
      }
    }
  } else {
    deps.stderr.write("[bench:terminal] bootstrap failed: Docker is not running. Start Docker, then rerun this command.\n");
    return 1;
  }

  if (options.dryRun) {
    deps.stdout.write(`[bench:terminal] bootstrap: would run docker pull ${TERMINAL_BENCH_BASE_IMAGE}\n`);
  } else {
    deps.stdout.write(`[bench:terminal] bootstrap: checking Terminal-Bench base image ${TERMINAL_BENCH_BASE_IMAGE}\n`);
    const pullResult = deps.spawn("docker", ["pull", TERMINAL_BENCH_BASE_IMAGE], { env });
    if (pullResult.status !== 0 || pullResult.error !== undefined) {
      deps.stderr.write("[bench:terminal] bootstrap failed: Docker cannot pull the Terminal-Bench base image.\n");
      deps.stderr.write(formatSpawnFailure(pullResult));
      deps.stderr.write(
        "[bench:terminal] If GHCR has stale credentials, run: docker logout ghcr.io\n",
      );
      return pullResult.status ?? 1;
    }
  }

  const providerIssues = benchmarkProviderIssues(env);
  if (providerIssues.length > 0) {
    for (const issue of providerIssues) {
      deps.stderr.write(`[bench:terminal] bootstrap warning: ${issue}\n`);
    }
  }

  deps.stdout.write("[bench:terminal] bootstrap complete. Run: pnpm run bench:terminal\n");
  return 0;
}

function waitForDocker(deps: RuntimeDeps, env: NodeJS.ProcessEnv): number {
  const startedAt = Date.now();
  while (Date.now() - startedAt < BOOTSTRAP_DOCKER_WAIT_MS) {
    const result = deps.spawn("docker", ["info"], { env });
    if (result.status === 0 && result.error === undefined) {
      deps.stdout.write("[bench:terminal] bootstrap: Docker is running\n");
      return 0;
    }
    deps.spawn("sleep", [String(BOOTSTRAP_DOCKER_POLL_MS / 1000)], { env });
  }

  deps.stderr.write("[bench:terminal] bootstrap failed: Docker Desktop did not become ready within 120 seconds.\n");
  return 1;
}

function terminalBenchInstallArgs(): string[] {
  return [
    "tool",
    "install",
    "--python",
    TERMINAL_BENCH_PYTHON,
    "--reinstall",
    "terminal-bench",
  ];
}

function runBenchmarkCommand(input: {
  command: TerminalBenchCommand;
  tbBin: string;
  deps: RuntimeDeps;
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
  runId?: string | undefined;
}): BenchmarkRunRecord {
  const runId = input.runId ?? `${KESTREL_ARTIFACT_PREFIX}-${runStamp()}`;
  const args = buildRunArgs(input.command, runId);
  input.deps.stdout.write(`[bench:terminal] ${input.command.adapter}: ${formatCommand(input.tbBin, args)}\n`);
  const runDir = path.join(input.deps.cwd, "runs", runId);
  if (input.dryRun) {
    return {
      adapter: input.command.adapter,
      runId,
      args,
      runDir,
      status: 0,
    };
  }
  const result = input.deps.spawn(input.tbBin, args, {
    cwd: input.deps.cwd,
    env: input.env,
    stdio: "inherit",
    timeout: readTerminalBenchCommandTimeoutMs(input.env),
  });
  const outcome = readTerminalBenchOutcome(path.join(runDir, "results.json"), runDir, input.command.adapter);
  const setupFailure = classifyTerminalBenchSetupFailure({
    result,
    runDir,
    adapter: input.command.adapter,
    outcome,
  });
  const run: BenchmarkRunRecord = {
    adapter: input.command.adapter,
    runId,
    args,
    runDir,
    status: result.status ?? 1,
    outcome,
    ...(setupFailure !== undefined
      ? {
          failureKind: setupFailure.kind,
          failureNotes: setupFailure.notes,
        }
      : {}),
  };
  writeTerminalBenchEfficiencyResults({
    run,
    command: input.command,
    dataset: readArgumentValue(input.command.args, "--dataset") ?? DEFAULT_DATASET,
    env: input.env,
  });
  return run;
}

export function writeTerminalBenchEfficiencyResults(input: {
  run: BenchmarkRunRecord;
  command: TerminalBenchCommand;
  dataset: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const adapterResults = readAdapterResultRecords(input.run.runDir, input.run.adapter);
  if (adapterResults.length === 0) return [];
  const outputDir = path.join(input.run.runDir, "harness-efficiency");
  mkdirSync(outputDir, { recursive: true });
  const outputs: string[] = [];
  for (const adapterResult of adapterResults) {
    const record = adapterResult.record;
    const taskId = readNonEmptyRecordString(record, "task_id") ?? "unknown";
    const adapterStatus = readNonEmptyRecordString(record, "status") ?? "failed";
    const explicitlyUnresolved = input.run.outcome?.unresolvedIds.includes(taskId) === true;
    const hasEvaluatorOutcome = input.run.outcome !== undefined &&
      (input.run.outcome.nResolved + input.run.outcome.nUnresolved > 0);
    const accepted = hasEvaluatorOutcome && explicitlyUnresolved === false && adapterStatus === "completed" &&
      input.run.outcome?.artifactPassedButAgentFailed !== true;
    const acceptance = hasEvaluatorOutcome === false ? "not_evaluated" : accepted ? "accepted" : "rejected";
    const recordedAt = new Date().toISOString();
    const outcome = {
      evaluatorId: "terminal-bench",
      evaluatorVersion: "1",
      independentlyEvaluated: hasEvaluatorOutcome,
      acceptance,
      failureClass: acceptance === "accepted"
        ? "none"
        : readNonEmptyRecordString(record, "failure_kind") ?? input.run.failureKind ?? "terminal_bench_unresolved",
    } as const;
    const replayBundlePath = resolveRecordedArtifactPath(input.run.runDir, record.runtime_replay_bundle_path);
    const replayBundle = replayBundlePath === undefined ? undefined : readJsonRecord(replayBundlePath);
    let economics = replayBundle === undefined
      ? emptyHarnessEfficiencyEconomics(["runtimeReplayBundle", "efficiencyLedger"])
      : readHarnessEfficiencyEconomicsFromReplayBundle(replayBundle, acceptance);
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_.-]+/gu, "_");
    const ledgerPath = path.join(outputDir, `${safeTaskId}.ledger.json`);
    let ledgerWritten = false;
    if (replayBundle !== undefined) {
      try {
        const ledger = createHarnessEfficiencyLedgerV1({
          replayBundle,
          recordedAt,
          runId: readNonEmptyRecordString(record, "kestrel_run_id"),
          sessionId: readNonEmptyRecordString(record, "kestrel_session_id"),
          outcome,
        });
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
        economics = readHarnessEfficiencyEconomicsFromLedger(ledger);
        ledgerWritten = true;
      } catch {
        economics = {
          ...economics,
          status: "incomplete",
          missingFields: [...new Set([...economics.missingFields, "efficiencyLedger"])],
          tokensPerAcceptedSuccess: null,
          costPerAcceptedSuccessUsd: null,
        };
      }
    }
    const harnessRevision = readNonEmptyRecordString(record, "harness_revision");
    if (harnessRevision === undefined) {
      economics = { ...economics, status: "incomplete", missingFields: [...new Set([...economics.missingFields, "frozen.harnessRevision"])] };
    }
    const jobInputPath = resolveRecordedArtifactPath(input.run.runDir, record.job_input_path);
    const jobInput = jobInputPath === undefined ? undefined : readJsonRecord(jobInputPath);
    const profile = isRecord(jobInput?.profile) ? jobInput.profile : undefined;
    const modelProvider = readNonEmptyRecordString(record, "model_provider") ?? "unknown";
    const model = readNonEmptyRecordString(record, "model") ?? "unknown";
    const trial = readTerminalBenchTrial(input.env.KESTREL_BENCHMARK_TRIAL);
    const taskInputHash = readHashRecordString(record, "job_input_sha256") ?? hashHarnessEfficiencyValue({ dataset: input.dataset, taskId });
    const result = createHarnessEfficiencyResultV1({
      pairId: input.env.KESTREL_BENCHMARK_PAIR_ID?.trim() || `terminal_bench:${input.dataset}:${taskId}:trial:${trial}`,
      lane: "terminal_bench",
      dataset: input.dataset,
      taskId,
      attemptId: input.run.runId,
      trial,
      recordedAt,
      durationMs: readNonNegativeRecordNumber(record, "duration_ms") ?? 0,
      frozen: {
        protocolHash: hashHarnessEfficiencyValue({ lane: "terminal_bench", version: 1, evaluator: "terminal-bench" }),
        taskInputHash,
        benchmarkConfigHash: hashHarnessEfficiencyValue({
          dataset: input.dataset,
          args: input.command.args,
          modelProvider,
          model,
          guardrails: profile?.guardrails,
          toolAllowlist: profile?.toolAllowlist,
          defaultInteractionMode: profile?.defaultInteractionMode,
          defaultActSubmode: profile?.defaultActSubmode,
        }),
        controlVariantHash: hashHarnessEfficiencyValue({
          harnessRevision,
          harnessEconomicsPolicy: profile?.harnessEconomicsPolicy,
          modelEconomicsProfile: profile?.modelEconomicsProfile,
        }),
        harnessRevision: harnessRevision ?? "unknown",
        modelProvider,
        model,
      },
      runtime: {
        ...(readNonEmptyRecordString(record, "kestrel_run_id") !== undefined ? { runId: readNonEmptyRecordString(record, "kestrel_run_id") } : {}),
        ...(readNonEmptyRecordString(record, "kestrel_session_id") !== undefined ? { sessionId: readNonEmptyRecordString(record, "kestrel_session_id") } : {}),
        ...(readNonEmptyRecordString(record, "kestrel_thread_id") !== undefined ? { threadId: readNonEmptyRecordString(record, "kestrel_thread_id") } : {}),
      },
      outcome,
      economics,
      artifacts: [
        terminalArtifactRef("adapter_result", adapterResult.path),
        ...(jobInputPath !== undefined ? [terminalArtifactRef("job_input", jobInputPath)] : []),
        ...(resolveRecordedArtifactPath(input.run.runDir, record.job_output_path) !== undefined
          ? [terminalArtifactRef("job_output", resolveRecordedArtifactPath(input.run.runDir, record.job_output_path) as string)]
          : []),
        ...(replayBundlePath !== undefined ? [terminalArtifactRef("runtime_replay_bundle", replayBundlePath)] : []),
        ...(ledgerWritten ? [terminalArtifactRef("efficiency_ledger", ledgerPath)] : []),
        ...(existsSync(path.join(input.run.runDir, "results.json")) ? [terminalArtifactRef("evaluator_results", path.join(input.run.runDir, "results.json"))] : []),
      ],
    });
    const outputPath = path.join(outputDir, `${safeTaskId}.json`);
    writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    outputs.push(outputPath);
  }
  return outputs;
}

function readAdapterResultRecords(runDir: string, adapter: Adapter): Array<{ path: string; record: Record<string, unknown> }> {
  if (existsSync(runDir) === false) return [];
  return listJsonFiles(runDir)
    .filter((jsonPath) => jsonPath.includes(`${path.sep}agent-logs${path.sep}${adapterResultPrefix(adapter)}-`))
    .map((jsonPath) => ({ path: jsonPath, record: readJsonRecord(jsonPath) }))
    .filter((entry): entry is { path: string; record: Record<string, unknown> } =>
      entry.record !== undefined &&
      typeof entry.record.task_id === "string" &&
      typeof entry.record.status === "string"
    );
}

function terminalArtifactRef(kind: string, filePath: string): { kind: string; path: string; sha256?: string | undefined } {
  return { kind, path: filePath, ...(existsSync(filePath) ? { sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex") } : {}) };
}

function resolveRecordedArtifactPath(runDir: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return ;
  return path.isAbsolute(value) ? value : path.join(runDir, value);
}

function readNonEmptyRecordString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readHashRecordString(record: Record<string, unknown>, field: string): string | undefined {
  const value = readNonEmptyRecordString(record, field);
  return value !== undefined && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function readNonNegativeRecordNumber(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readArgumentValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readTerminalBenchTrial(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return 1;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) === false || parsed <= 0) throw new Error("KESTREL_BENCHMARK_TRIAL must be a positive integer.");
  return parsed;
}

function readTerminalBenchCommandTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.KESTREL_TBENCH_COMMAND_TIMEOUT_SEC;
  const seconds = raw !== undefined && raw.trim().length > 0 ? Number(raw) : 1800;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 1_800_000;
}

function classifyTerminalBenchSetupFailure(input: {
  result: SpawnSyncReturns<Buffer>;
  runDir: string;
  adapter: Adapter;
  outcome: BenchmarkOutcome | undefined;
}): { kind: string; notes: string } | undefined {
  if (input.outcome?.benchmarkSetupFailure !== undefined) {
    return {
      kind: input.outcome.benchmarkSetupFailure.kind,
      notes: input.outcome.benchmarkSetupFailure.notes,
    };
  }
  if (input.outcome !== undefined || hasAdapterResultFile(input.runDir, input.adapter)) {
    return ;
  }
  const error = input.result.error;
  const message = error instanceof Error ? error.message : "";
  const code = error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code) : "";
  if (code === "ETIMEDOUT" || /timed out|timeout/u.test(message)) {
    return {
      kind: "benchmark_setup_timeout",
      notes: message || "Terminal-Bench command timed out before producing results.json or adapter result files.",
    };
  }
  if ((input.result.status ?? 1) !== 0) {
    return {
      kind: "benchmark_setup_failed",
      notes: message || "Terminal-Bench command exited before producing results.json or adapter result files.",
    };
  }
  return ;
}

function hasAdapterResultFile(runDir: string, adapter: Adapter): boolean {
  if (!existsSync(runDir)) {
    return false;
  }
  return listJsonFiles(runDir).some((jsonPath) =>
    jsonPath.includes(`${path.sep}agent-logs${path.sep}${adapterResultPrefix(adapter)}-`)
  );
}

function buildRunArgs(command: TerminalBenchCommand, runId: string): string[] {
  return [
    ...command.args,
    "--output-path",
    "runs",
    "--run-id",
    runId,
  ];
}

export function readTerminalBenchOutcome(
  resultPath: string,
  runDir?: string | undefined,
  adapter?: Adapter | undefined,
): BenchmarkOutcome | undefined {
  if (!existsSync(resultPath)) {
    return ;
  }
  const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as {
    n_resolved?: unknown;
    n_unresolved?: unknown;
    accuracy?: unknown;
    failure_mode?: unknown;
    results?: unknown;
    unresolved_ids?: unknown;
  };
  const adapterFailures = runDir !== undefined && adapter !== undefined
    ? readAdapterResultFailures(runDir, adapter)
    : [];
  const nResolved = typeof parsed.n_resolved === "number" ? parsed.n_resolved : 0;
  const nUnresolved = typeof parsed.n_unresolved === "number" ? parsed.n_unresolved : 0;
  const failureMode = readTerminalBenchFailureMode(parsed);
  const benchmarkSetupFailure = runDir !== undefined && adapter !== undefined
    ? readBenchmarkSetupFailure({
        runDir,
        adapter,
        parsed,
        nUnresolved,
        failureMode,
      })
    : undefined;
  return {
    nResolved,
    nUnresolved,
    accuracy: typeof parsed.accuracy === "number" ? parsed.accuracy : 0,
    ...(failureMode !== undefined ? { failureMode } : {}),
    unresolvedIds: Array.isArray(parsed.unresolved_ids)
      ? parsed.unresolved_ids.filter((value): value is string => typeof value === "string")
      : [],
    adapterFailures,
    ...(benchmarkSetupFailure !== undefined ? { benchmarkSetupFailure } : {}),
    artifactPassedButAgentFailed: nResolved > 0 && nUnresolved === 0 && adapterFailures.length > 0,
    adapterCompletedButBenchmarkFailed:
      nUnresolved > 0 && adapterFailures.length === 0 &&
      runDir !== undefined && adapter !== undefined &&
      hasCompletedAdapterResultFile(runDir, adapter),
  };
}

function readBenchmarkSetupFailure(input: {
  runDir: string;
  adapter: Adapter;
  parsed: { results?: unknown };
  nUnresolved: number;
  failureMode: string | undefined;
}): BenchmarkSetupFailure | undefined {
  if (input.nUnresolved === 0 || hasAdapterResultFile(input.runDir, input.adapter)) {
    return ;
  }
  if (!Array.isArray(input.parsed.results)) {
    return ;
  }
  const resultRows = input.parsed.results.filter(isRecord);
  if (resultRows.length === 0) {
    return ;
  }
  if (resultRows.some((row) => typeof row.agent_started_at === "string" && row.agent_started_at.length > 0)) {
    return ;
  }
  const runLog = path.join(input.runDir, "run.log");
  return {
    kind: "benchmark_setup_failed_before_adapter",
    notes: [
      "Terminal-Bench produced unresolved results before the Kestrel adapter started.",
      ...(input.failureMode !== undefined ? [`failure_mode=${input.failureMode}.`] : []),
    ].join(" "),
    ...(existsSync(runLog) ? { runLogPath: path.relative(input.runDir, runLog) } : {}),
  };
}

function renderBenchmarkSetupFailure(adapter: Adapter, failure: BenchmarkSetupFailure): string {
  return [
    `[bench:terminal] ${adapter} failed: ${failure.kind}.`,
    failure.notes,
    ...(failure.runLogPath !== undefined ? [`- ${failure.runLogPath}`] : []),
    "",
  ].join("\n");
}

function readTerminalBenchFailureMode(parsed: { failure_mode?: unknown; results?: unknown }): string | undefined {
  if (typeof parsed.failure_mode === "string") {
    return parsed.failure_mode;
  }
  if (!Array.isArray(parsed.results)) {
    return ;
  }
  for (const result of parsed.results) {
    if (isRecord(result) && typeof result.failure_mode === "string") {
      return result.failure_mode;
    }
  }
  return ;
}

export function readAdapterResultFailures(runDir: string, adapter: Adapter): AdapterResultFailure[] {
  if (!existsSync(runDir)) {
    return [];
  }
  const failures: AdapterResultFailure[] = [];
  for (const jsonPath of listJsonFiles(runDir)) {
    if (!jsonPath.includes(`${path.sep}agent-logs${path.sep}${adapterResultPrefix(adapter)}-`)) {
      continue;
    }
    const parsed = readJsonRecord(jsonPath);
    if (parsed === undefined) {
      continue;
    }
    const status = typeof parsed.status === "string" ? parsed.status : undefined;
    if (status === undefined || status === "completed") {
      continue;
    }
    failures.push({
      path: path.relative(runDir, jsonPath),
      status,
      ...(typeof parsed.failure_kind === "string" ? { failureKind: parsed.failure_kind } : {}),
      ...(typeof parsed.task_id === "string" ? { taskId: parsed.task_id } : {}),
      ...(typeof parsed.notes === "string" ? { notes: parsed.notes } : {}),
      ...(isRecord(parsed.failure_details) ? { failureDetails: parsed.failure_details } : {}),
    });
  }
  return failures;
}

function hasCompletedAdapterResultFile(runDir: string, adapter: Adapter): boolean {
  if (!existsSync(runDir)) {
    return false;
  }
  return listJsonFiles(runDir).some((jsonPath) => {
    if (!jsonPath.includes(`${path.sep}agent-logs${path.sep}${adapterResultPrefix(adapter)}-`)) {
      return false;
    }
    const parsed = readJsonRecord(jsonPath);
    return parsed?.status === "completed" && parsed.failure_kind === "none";
  });
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

function adapterResultPrefix(adapter: Adapter): string {
  return KESTREL_ARTIFACT_PREFIX;
}

export function checkCleanWorktree(deps: RuntimeDeps): { clean: true; details: "" } | { clean: false; details: string } {
  const result = deps.spawn("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: deps.cwd,
    env: deps.env,
  });
  if (result.status !== 0 || result.error !== undefined) {
    return {
      clean: false,
      details: `[bench:terminal] git status failed.\n${formatSpawnFailure(result)}`,
    };
  }
  const details = result.stdout.toString("utf8");
  if (details.trim().length === 0) {
    return { clean: true, details: "" };
  }
  return {
    clean: false,
    details,
  };
}

export function validateTerminalBenchRepairPolicy(statusPorcelain: string): TerminalBenchRepairPolicyResult {
  const paths = parseGitStatusPaths(statusPorcelain);
  const violations = paths
    .filter(isForbiddenTerminalBenchRepairPath)
    .map((filePath) => `Forbidden Terminal-Bench repair path: ${filePath}`);
  if (violations.length > 0) {
    return {
      passed: false,
      violations,
      changedPaths: paths,
      output: [
        "Terminal-Bench repair policy failed.",
        "",
        ...violations,
        "",
        "Repairs may harden Kestrel runtime, agent contracts, prompts, schemas, CLI/tool bridge logic, and tests.",
        "Repairs must not modify benchmark run artifacts, cached Terminal-Bench data, or Terminal-Bench result artifacts.",
        "",
      ].join("\n"),
    };
  }
  return {
    passed: true,
    violations: [],
    changedPaths: paths,
    output: [
      "Terminal-Bench repair policy passed.",
      "",
      "Changed paths:",
      ...(paths.length === 0 ? ["- none"] : paths.map((filePath) => `- ${filePath}`)),
      "",
    ].join("\n"),
  };
}

function checkTerminalBenchRepairPolicy(deps: RuntimeDeps): TerminalBenchRepairPolicyResult {
  const result = deps.spawn("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: deps.cwd,
    env: deps.env,
  });
  if (result.status !== 0 || result.error !== undefined) {
    return {
      passed: false,
      violations: ["git status failed while checking Terminal-Bench repair policy"],
      changedPaths: [],
      output: `[bench:terminal] git status failed during repair policy check.\n${formatSpawnFailure(result)}`,
    };
  }
  return validateTerminalBenchRepairPolicy(result.stdout.toString("utf8"));
}

function parseGitStatusPaths(statusPorcelain: string): string[] {
  const paths: string[] = [];
  for (const line of statusPorcelain.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    const rawPath = line.length > 3 ? line.slice(3).trim() : line.trim();
    for (const filePath of rawPath.split(" -> ")) {
      const normalized = normalizeGitStatusPath(filePath);
      if (normalized.length > 0) {
        paths.push(normalized);
      }
    }
  }
  return [...new Set(paths)];
}

function normalizeGitStatusPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isForbiddenTerminalBenchRepairPath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/");
  return (
    normalized.startsWith("runs/") ||
    normalized.startsWith(".cache/terminal-bench/") ||
    normalized.startsWith("benchmarks/terminal_bench/results/") ||
    normalized.startsWith("benchmarks/terminal_bench/__pycache__/") ||
    normalized === "benchmarks/terminal_bench/term-bench-run-notes.md" ||
    normalized.endsWith(".pyc")
  );
}

export function buildCodexExecArgs(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const model = env.KESTREL_TBENCH_CODEX_MODEL?.trim() || DEFAULT_CODEX_REPAIR_MODEL;
  return ["exec", "--full-auto", "-m", model, "--cd", cwd, "-"];
}

export function buildFailurePacket(input: {
  iteration: number;
  dataset: string;
  taskId?: string | undefined;
  runs: BenchmarkRunRecord[];
  cwd: string;
}): string {
  const lines: string[] = [
    "# Terminal-Bench Failure Packet",
    "",
    `- iteration: ${input.iteration}`,
    `- dataset: ${input.dataset}`,
    `- task: ${input.taskId ?? "full"}`,
    "",
    "## Failed Runs",
    "",
  ];

  for (const run of input.runs) {
    lines.push(`### ${run.adapter} ${run.runId}`);
    lines.push("");
    lines.push(`- status: ${run.status}`);
    lines.push(`- runDir: ${path.relative(input.cwd, run.runDir)}`);
    lines.push(`- command: ${formatCommand("tb", run.args)}`);
    if (run.outcome !== undefined) {
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(run.outcome, null, 2));
      lines.push("```");
    }
    lines.push("");
  }

  lines.push("## Evidence");
  lines.push("");
  lines.push("The following sections are raw benchmark artifacts. Do not infer cause from filenames alone.");
  lines.push("");

  for (const run of input.runs) {
    for (const evidencePath of collectEvidencePaths(run.runDir)) {
      const relative = path.relative(input.cwd, evidencePath);
      lines.push(`### ${relative}`);
      lines.push("");
      lines.push("```");
      lines.push(readEvidenceSnippet(evidencePath));
      lines.push("```");
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function collectEvidencePaths(runDir: string): string[] {
  if (!existsSync(runDir)) {
    return [];
  }
  const collected: string[] = [];
  for (const filePath of walkFiles(runDir, 6)) {
    const relative = path.relative(runDir, filePath);
    if (isEvidencePath(relative)) {
      collected.push(filePath);
    }
  }
  return collected.sort();
}

function isEvidencePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return (
    normalized === "results.json" ||
    normalized === "run.log" ||
    normalized === "run_metadata.json" ||
    normalized.endsWith("/results.json") ||
    normalized.endsWith("/commands.txt") ||
    normalized.endsWith("/agent-logs/kestrel-terminal-bench-hello-world.json") ||
    normalized.includes("/agent-logs/") && normalized.endsWith(".json") ||
    normalized.endsWith("/sessions/agent.log") ||
    normalized.endsWith("/sessions/tests.log") ||
    normalized.endsWith("/panes/post-agent.txt") ||
    normalized.endsWith("/panes/post-test.txt")
  );
}

function walkFiles(root: string, maxDepth: number): string[] {
  const results: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) {
      return;
    }
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        visit(fullPath, depth + 1);
      } else if (stat.isFile()) {
        results.push(fullPath);
      }
    }
  };
  visit(root, 0);
  return results;
}

function readEvidenceSnippet(filePath: string): string {
  const raw = readFileSync(filePath, "utf8");
  if (raw.length <= EVIDENCE_FILE_LIMIT) {
    return raw;
  }
  const half = Math.floor(EVIDENCE_FILE_LIMIT / 2);
  return `${raw.slice(0, half)}\n\n[...truncated ${raw.length - EVIDENCE_FILE_LIMIT} bytes...]\n\n${raw.slice(-half)}`;
}

function buildCodexRepairPrompt(input: {
  failurePacketPath: string;
  failurePacket: string;
  options: TerminalBenchOptions;
}): string {
  return buildKestrelTerminalBenchRepairPrompt({
    failurePacketPath: input.failurePacketPath,
    failurePacket: input.failurePacket,
    adapter: input.options.adapter,
    dataset: input.options.dataset,
    taskId: input.options.taskId,
  });
}

function runImproveVerification(input: {
  commands: TerminalBenchCommand[];
  tbBin: string;
  deps: RuntimeDeps;
  env: NodeJS.ProcessEnv;
  iterationDir: string;
  runIdForCommand?: ((command: TerminalBenchCommand, commandIndex: number) => string) | undefined;
  queueCleanup?: {
    taskId: string;
    dataset: string;
    cacheHome: string;
    record: (run: DockerCleanupRun) => void;
  } | undefined;
}): { passed: boolean; output: string; reruns: BenchmarkRunRecord[] } {
  const output: string[] = [];
  const reruns: BenchmarkRunRecord[] = [];
  const checks: Array<{ command: string; args: string[] }> = [
    { command: "python3", args: ["-m", "unittest", "benchmarks.terminal_bench.test_results"] },
    {
      command: "node",
      args: [
        "--import",
        "tsx",
        "--test",
        "tests/unit/terminal-bench-orchestrator.test.ts",
        "tests/unit/terminal-bench-dev-shell-service.test.ts",
        "tests/unit/openrouter-phase-schema-compat.test.ts",
        "tests/integration/shared-adapters.test.ts",
        "tests/scenario/runtime-scenarios.test.ts",
      ],
    },
  ];

  for (const check of checks) {
    output.push(`$ ${formatCommand(check.command, check.args)}`);
    input.deps.stdout.write(`[bench:terminal] improve: verification check started: ${formatCommand(check.command, check.args)}\n`);
    const result = input.deps.spawn(check.command, check.args, {
      cwd: input.deps.cwd,
      env: input.env,
    });
    output.push(renderSpawnOutput(result));
    if (result.status !== 0 || result.error !== undefined) {
      input.deps.stderr.write(`[bench:terminal] improve: verification check failed: ${formatCommand(check.command, check.args)}\n`);
      return { passed: false, output: output.join("\n"), reruns };
    }
    input.deps.stdout.write(`[bench:terminal] improve: verification check passed: ${formatCommand(check.command, check.args)}\n`);
  }

  for (const [commandIndex, command] of input.commands.entries()) {
    const runId = input.runIdForCommand?.(command, commandIndex);
    if (input.queueCleanup !== undefined && runId !== undefined) {
      input.queueCleanup.record(runQueueDockerCleanup({
        adapter: command.adapter,
        phase: "pre",
        taskId: input.queueCleanup.taskId,
        runId,
        dataset: input.queueCleanup.dataset,
        cacheHome: input.queueCleanup.cacheHome,
        deps: input.deps,
        env: input.env,
      }));
    }
    const run = runBenchmarkCommand({
      command,
      tbBin: input.tbBin,
      deps: input.deps,
      env: input.env,
      dryRun: false,
      runId,
    });
    if (input.queueCleanup !== undefined) {
      input.queueCleanup.record(runQueueDockerCleanup({
        adapter: command.adapter,
        phase: "post",
        taskId: input.queueCleanup.taskId,
        runId: run.runId,
        dataset: input.queueCleanup.dataset,
        cacheHome: input.queueCleanup.cacheHome,
        deps: input.deps,
        env: input.env,
      }));
    }
    reruns.push(run);
    output.push(`$ ${formatCommand(input.tbBin, run.args)}`);
    output.push(JSON.stringify(run, null, 2));
    if (run.status !== 0 || run.outcome === undefined || run.outcome.nUnresolved > 0) {
      input.deps.stderr.write(`[bench:terminal] improve: benchmark verification failed: ${command.adapter} ${run.runId}\n`);
      return { passed: false, output: output.join("\n"), reruns };
    }
    input.deps.stdout.write(`[bench:terminal] improve: benchmark verification passed: ${command.adapter} ${run.runId}\n`);
  }
  writeFileSync(
    path.join(input.iterationDir, "verification-benchmark-summary.json"),
    JSON.stringify({ reruns }, null, 2) + "\n",
    "utf8",
  );
  return { passed: true, output: output.join("\n"), reruns };
}

function commitImproveIteration(input: {
  deps: RuntimeDeps;
  adapterLabel: AdapterSelection;
  taskId?: string | undefined;
  iteration: number;
  changedPaths: string[];
}): { committed: boolean; status?: number | undefined; sha?: string | undefined; output: string } {
  if (input.changedPaths.length === 0) {
    return { committed: false, status: 1, output: "No validated repair paths to commit.\n" };
  }
  const label = `${input.adapterLabel} ${input.taskId ?? "full"}`;
  const add = input.deps.spawn("git", ["add", "--", ...input.changedPaths], {
    cwd: input.deps.cwd,
    env: input.deps.env,
  });
  if (add.status !== 0 || add.error !== undefined) {
    return { committed: false, status: add.status ?? 1, output: renderSpawnOutput(add) };
  }
  const message = `bench(terminal): improve ${label} iteration ${input.iteration}`;
  const commit = input.deps.spawn("git", ["commit", "-m", message], {
    cwd: input.deps.cwd,
    env: input.deps.env,
  });
  if (commit.status !== 0 || commit.error !== undefined) {
    return { committed: false, status: commit.status ?? 1, output: renderSpawnOutput(commit) };
  }
  const revParse = input.deps.spawn("git", ["rev-parse", "HEAD"], {
    cwd: input.deps.cwd,
    env: input.deps.env,
  });
  const sha = revParse.status === 0 && revParse.error === undefined
    ? revParse.stdout.toString("utf8").trim()
    : undefined;
  return {
    committed: true,
    ...(sha !== undefined && sha.length > 0 ? { sha } : {}),
    output: renderSpawnOutput(commit),
  };
}

function renderSpawnOutput(result: SpawnSyncReturns<Buffer>): string {
  const stdout = result.stdout?.toString("utf8") ?? "";
  const stderr = result.stderr?.toString("utf8") ?? "";
  const error = result.error === undefined ? "" : `${result.error.message}\n`;
  return [stdout, stderr, error].filter((part) => part.length > 0).join("\n");
}

function renderDockerCleanupRuns(runs: DockerCleanupRun[]): string {
  return runs.map((run) => {
    const output = renderSpawnOutput(run.result);
    return [
      `[${run.phase}] adapter=${run.adapter} runId=${run.runId}`,
      `$ ${formatCommand(run.command, run.args)}`,
      `status=${run.result.status ?? 1}`,
      output.length > 0 ? output : "(no output)",
    ].join("\n");
  }).join("\n\n") + "\n";
}

function runStamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
  const stderr = result.stderr.toString("utf8").trim();
  const stdout = result.stdout.toString("utf8").trim();
  const detail = stderr.length > 0 ? stderr : stdout;
  return detail.length > 0 ? `${detail}\n` : "";
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveBenchmarkModelProvider(
  env: NodeJS.ProcessEnv,
): "openrouter" | undefined {
  return benchmarkProviderIssues(env).length === 0 ? "openrouter" : undefined;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function passedSpawnResult(): SpawnSyncReturns<Buffer> {
  return {
    pid: 0,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
  };
}

function helpText(): string {
  return `Usage:
  pnpm run bench:terminal
  pnpm run bench:terminal -- preflight
  pnpm run bench:terminal -- bootstrap
  pnpm run bench:terminal -- run
  pnpm run bench:terminal -- improve

Options:
  --adapter kestrel           Override the adapter selection
  --dataset <dataset>         Default: ${DEFAULT_DATASET}
  --task-id <task-id>         Run one task instead of the full selected lane
  --full                      Clear the preflight task and run the full selected lane
  --max-iterations <n>        Improve mode safety stop. Default: ${DEFAULT_MAX_IMPROVE_ITERATIONS}
  --executor codex            Improve mode repair executor. Default: codex
  KESTREL_TBENCH_CODEX_MODEL  Codex repair model. Default: ${DEFAULT_CODEX_REPAIR_MODEL}
  --dry-run                   Print the tb commands without running them
  --tb-bin <path>             Default: tb
`;
}

class HelpRequested extends Error {}

const entryPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  loadBenchmarkDotEnv(process.cwd(), process.env);
  void runTerminalBench(process.argv.slice(2), {
    spawn: spawnSync,
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((code) => {
    process.exitCode = code;
  });
}
