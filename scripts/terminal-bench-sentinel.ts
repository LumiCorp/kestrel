import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

type Adapter = "kestrel";
type FailureDisposition = "retry" | "stop";

interface SentinelOptions {
  adapter: Adapter;
  full: boolean;
  taskId?: string | undefined;
  maxIterations: number;
  intervalSeconds: number;
  healDelaySeconds: number;
  maxHealAttempts: number;
  once: boolean;
  dryRun: boolean;
  skipBootstrap: boolean;
  skipCleanup: boolean;
}

interface FailureClassification {
  disposition: FailureDisposition;
  reason: string;
  summaryStatus?: string | undefined;
  summaryPath?: string | undefined;
}

const DEFAULT_INTERVAL_SECONDS = 60 * 60;
const DEFAULT_HEAL_DELAY_SECONDS = 30;
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_HEAL_ATTEMPTS = 3;
const IMPROVE_ROOT = path.join("runs", "terminal-bench-improve");
const STOP_SUMMARY_STATUSES = new Set([
  "repair_policy_failed",
  "verification_failed",
  "no_repair_diff",
  "max_iterations_exhausted",
  "commit_failed",
]);
const RETRY_SUMMARY_STATUSES = new Set(["codex_failed"]);

function parseArgs(argv: string[]): SentinelOptions {
  let adapter: Adapter = "kestrel";
  let full = true;
  let taskId: string | undefined;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let healDelaySeconds = DEFAULT_HEAL_DELAY_SECONDS;
  let maxHealAttempts = DEFAULT_MAX_HEAL_ATTEMPTS;
  let once = false;
  let dryRun = false;
  let skipBootstrap = false;
  let skipCleanup = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--adapter") {
      const value = readValue(argv, index, arg);
      if (value !== "kestrel" && value !== "cli") {
        throw new Error("--adapter must be kestrel");
      }
      adapter = "kestrel";
      index += 1;
      continue;
    }
    if (arg === "--task-id") {
      taskId = readValue(argv, index, arg);
      full = false;
      index += 1;
      continue;
    }
    if (arg === "--full") {
      taskId = undefined;
      full = true;
      continue;
    }
    if (arg === "--max-iterations") {
      maxIterations = readPositiveInteger(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--interval-seconds" || arg === "--interval") {
      intervalSeconds = readPositiveInteger(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--heal-delay-seconds") {
      healDelaySeconds = readPositiveInteger(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--max-heal-attempts") {
      maxHealAttempts = readPositiveInteger(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--skip-bootstrap") {
      skipBootstrap = true;
      continue;
    }
    if (arg === "--skip-cleanup") {
      skipCleanup = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    adapter,
    full,
    ...(taskId !== undefined ? { taskId } : {}),
    maxIterations,
    intervalSeconds,
    healDelaySeconds,
    maxHealAttempts,
    once,
    dryRun,
    skipBootstrap,
    skipCleanup,
  };
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function buildBenchArgs(options: SentinelOptions): string[] {
  return [
    "run",
    "bench:terminal",
    "--",
    "improve",
    ...(options.full ? ["--full"] : ["--task-id", options.taskId as string]),
    "--adapter",
    options.adapter,
    "--max-iterations",
    String(options.maxIterations),
  ];
}

function buildCleanupArgs(): string[] {
  return ["run", "bench:terminal", "--", "cleanup"];
}

function buildBootstrapArgs(): string[] {
  return ["run", "bench:terminal", "--", "bootstrap"];
}

function runPnpm(args: string[]): SpawnSyncReturns<Buffer> {
  return spawnSync("pnpm", args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
}

function runGitStatus(): string | undefined {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.status !== 0 || result.error !== undefined) {
    return ;
  }
  return result.stdout.toString("utf8");
}

function classifyFailure(startedAtMs: number): FailureClassification {
  const gitStatus = runGitStatus();
  if (gitStatus === undefined) {
    return {
      disposition: "stop",
      reason: "git status failed; cannot safely continue",
    };
  }
  if (gitStatus.trim().length > 0) {
    return {
      disposition: "stop",
      reason: "worktree has uncommitted changes after failure; preserving state for review",
    };
  }

  const summary = readLatestSummary(startedAtMs);
  if (summary === undefined) {
    return {
      disposition: "retry",
      reason: "no machine-readable improve summary was written; treating as preflight or infrastructure failure",
    };
  }

  if (STOP_SUMMARY_STATUSES.has(summary.status)) {
    return {
      disposition: "stop",
      reason: `non-recoverable improve status: ${summary.status}`,
      summaryStatus: summary.status,
      summaryPath: summary.path,
    };
  }
  if (RETRY_SUMMARY_STATUSES.has(summary.status)) {
    return {
      disposition: "retry",
      reason: `recoverable improve status: ${summary.status}`,
      summaryStatus: summary.status,
      summaryPath: summary.path,
    };
  }
  return {
    disposition: "retry",
    reason: `unrecognized clean-worktree improve status: ${summary.status}`,
    summaryStatus: summary.status,
    summaryPath: summary.path,
  };
}

function readLatestSummary(startedAtMs: number): { status: string; path: string } | undefined {
  const root = path.join(process.cwd(), IMPROVE_ROOT);
  if (!existsSync(root)) {
    return ;
  }
  const candidates = readdirSync(root)
    .map((entry) => path.join(root, entry, "summary.json"))
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ path: candidate, mtimeMs: statSync(candidate).mtimeMs }))
    .filter((candidate) => candidate.mtimeMs >= startedAtMs - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = candidates[0];
  if (latest === undefined) {
    return ;
  }
  try {
    const parsed = JSON.parse(readFileSync(latest.path, "utf8")) as { status?: unknown };
    return typeof parsed.status === "string"
      ? { status: parsed.status, path: path.relative(process.cwd(), latest.path) }
      : undefined;
  } catch {
    return ;
  }
}

function runHealingActions(options: SentinelOptions): boolean {
  let ok = true;
  if (!options.skipCleanup) {
    process.stdout.write(`[bench:terminal:sentinel] heal: ${formatCommand("pnpm", buildCleanupArgs())}\n`);
    const cleanup = runPnpm(buildCleanupArgs());
    ok = ok && cleanup.status === 0 && cleanup.error === undefined;
  }
  if (!options.skipBootstrap) {
    process.stdout.write(`[bench:terminal:sentinel] heal: ${formatCommand("pnpm", buildBootstrapArgs())}\n`);
    const bootstrap = runPnpm(buildBootstrapArgs());
    ok = ok && bootstrap.status === 0 && bootstrap.error === undefined;
  }
  return ok;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=@+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

function helpText(): string {
  return `Usage:
  pnpm run bench:terminal:sentinel
  pnpm run bench:terminal:sentinel -- --once
  pnpm run bench:terminal:sentinel -- --interval-seconds 1800
  pnpm run bench:terminal:sentinel -- --adapter kestrel --task-id hello-world --once

Runs the hardened Terminal-Bench improvement loop repeatedly. Clean failures are
self-healed with scoped Terminal-Bench cleanup and bootstrap before retrying.
Unsafe failures stop with artifacts preserved.

Options:
  --adapter kestrel             Adapter lane to run. Default: kestrel
  --full                       Run the full queued benchmark target. Default
  --task-id <id>               Run a single Terminal-Bench task instead of --full
  --max-iterations <n>         Codex repair iterations per failed target. Default: ${DEFAULT_MAX_ITERATIONS}
  --interval-seconds <n>       Sleep after a clean pass before rerunning. Default: ${DEFAULT_INTERVAL_SECONDS}
  --max-heal-attempts <n>      Cleanup/bootstrap retries before stopping. Default: ${DEFAULT_MAX_HEAL_ATTEMPTS}
  --heal-delay-seconds <n>     Sleep between healing and retry. Default: ${DEFAULT_HEAL_DELAY_SECONDS}
  --skip-bootstrap             Do not run bench:terminal bootstrap during healing
  --skip-cleanup               Do not run bench:terminal cleanup during healing
  --once                       Run one successful sentinel pass and exit
  --dry-run                    Print wrapped commands and exit
`;
}

class HelpRequested extends Error {}

async function main(): Promise<number> {
  let options: SentinelOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(helpText());
      return 0;
    }
    process.stderr.write(`bench:terminal:sentinel failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(helpText());
    return 1;
  }

  const args = buildBenchArgs(options);
  process.stdout.write(`[bench:terminal:sentinel] command: ${formatCommand("pnpm", args)}\n`);
  if (options.dryRun) {
    if (!options.skipCleanup) {
      process.stdout.write(`[bench:terminal:sentinel] heal command: ${formatCommand("pnpm", buildCleanupArgs())}\n`);
    }
    if (!options.skipBootstrap) {
      process.stdout.write(`[bench:terminal:sentinel] heal command: ${formatCommand("pnpm", buildBootstrapArgs())}\n`);
    }
    return 0;
  }

  let pass = 1;
  let healAttempts = 0;
  while (true) {
    const startedAtMs = Date.now();
    process.stdout.write(`[bench:terminal:sentinel] pass ${pass} started at ${new Date(startedAtMs).toISOString()}\n`);
    const result = runPnpm(args);
    if (result.error !== undefined || result.status !== 0) {
      const status = result.status ?? 1;
      const classification = classifyFailure(startedAtMs);
      process.stderr.write(`[bench:terminal:sentinel] pass ${pass} failed status=${status}; ${classification.reason}\n`);
      if (classification.summaryPath !== undefined) {
        process.stderr.write(`[bench:terminal:sentinel] summary=${classification.summaryPath} status=${classification.summaryStatus}\n`);
      }
      if (classification.disposition === "stop") {
        process.stderr.write("[bench:terminal:sentinel] stopped for human review\n");
        return status;
      }
      if (healAttempts >= options.maxHealAttempts) {
        process.stderr.write(`[bench:terminal:sentinel] stopped after ${healAttempts} heal attempts\n`);
        return status;
      }
      healAttempts += 1;
      process.stdout.write(`[bench:terminal:sentinel] heal attempt ${healAttempts}/${options.maxHealAttempts}\n`);
      if (!runHealingActions(options)) {
        process.stderr.write("[bench:terminal:sentinel] healing command failed; stopping\n");
        return 1;
      }
      process.stdout.write(`[bench:terminal:sentinel] sleeping ${options.healDelaySeconds}s before retry\n`);
      await sleep(options.healDelaySeconds);
      continue;
    }
    process.stdout.write(`[bench:terminal:sentinel] pass ${pass} completed cleanly\n`);
    healAttempts = 0;
    if (options.once) {
      return 0;
    }
    process.stdout.write(`[bench:terminal:sentinel] sleeping ${options.intervalSeconds}s before next pass\n`);
    await sleep(options.intervalSeconds);
    pass += 1;
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  process.stderr.write(`bench:terminal:sentinel crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
