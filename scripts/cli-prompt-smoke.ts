import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";

type SmokeStatus = "passed" | "failed";
type ArtifactStatus = "passed" | "failed" | "not_checked";
type PromptMode = "chat" | "plan" | "build";

type PromptAssertion =
  | {
      type: "file_exists";
      path: string;
    }
  | {
      type: "any_file_exists";
      paths: string[];
    }
  | {
      type: "file_contains";
      path: string;
      text: string;
      caseSensitive?: boolean | undefined;
    }
  | {
      type: "any_file_contains";
      paths: string[];
      text: string;
      caseSensitive?: boolean | undefined;
    }
  | {
      type: "file_not_contains";
      path: string;
      text: string;
      caseSensitive?: boolean | undefined;
    }
  | {
      type: "any_file_not_contains";
      paths: string[];
      text: string;
      caseSensitive?: boolean | undefined;
    }
  | {
      type: "json_array_min_length";
      path: string;
      minLength: number;
      arrayPath?: string | undefined;
    };

interface CliPromptSmokeOptions {
  list: boolean;
  prompt?: string | undefined;
  promptsDir: string;
  workRoot: string;
  profile: string;
  mode: PromptMode;
  timeoutSeconds: number;
  keepRuns: number;
}

interface PromptCase {
  id: string;
  filePath: string;
  text: string;
  assertions: PromptAssertion[];
}

interface PtyStep {
  pattern: string;
  regex: boolean;
  fromCursor?: boolean | undefined;
  timeoutSeconds?: number | undefined;
}

interface PtyPayload {
  command: string[];
  env: Record<string, string>;
  steps: PtyStep[];
  abortPatterns: Array<{
    pattern: string;
    regex: boolean;
    reason: string;
    fromCursor?: boolean | undefined;
  }>;
  timeoutSeconds: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface PromptRunReport {
  id: string;
  status: SmokeStatus;
  runtimeStatus: SmokeStatus;
  artifactStatus: ArtifactStatus;
  durationMs: number;
  promptPath: string;
  runDir: string;
  workspacePath: string;
  resolvedWorkspaceRoot?: string | undefined;
  kestrelHome: string;
  transcriptPath: string;
  driverStderrPath: string;
  historyPath: string;
  diagnosticsPath: string;
  reportPath: string;
  exitCode: number;
  badMatches: string[];
  assertionResults: AssertionResult[];
  createdFiles: string[];
  diagnostics: string[];
}

interface PromptRunPaths {
  runDir: string;
  workspacePath: string;
  kestrelHome: string;
  logsDir: string;
  transcriptPath: string;
  driverStderrPath: string;
  historyPath: string;
  diagnosticsPath: string;
  reportPath: string;
}

interface AssertionResult {
  type: PromptAssertion["type"];
  path: string;
  paths?: string[] | undefined;
  passed: boolean;
  detail: string;
}

const DEFAULT_PROMPTS_DIR = "tests/cli-prompts";
const PROMPT_ASSETS_DIRNAME = "assets";
const PROMPT_ASSETS_PLACEHOLDER = "{{CLI_PROMPT_ASSETS_DIR}}";
const WORKSPACE_PROMPT_ASSETS_DIRNAME = "prompt-assets";
const TUI_FINAL_ASSISTANT_PATTERN = "(?:^|\\n)\\s*>?\\s*<<\\s+AGENT\\s+·";
const DEFAULT_WORK_ROOT = "/private/tmp/kestrel-cli-prompt-smoke";
const DEFAULT_TIMEOUT_SECONDS = 420;
const DEFAULT_KEEP_RUNS = 10;
const DEFAULT_PROFILE = "reference";
const DEFAULT_MODE: PromptMode = "build";

const PREFERRED_DOT_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_NAME",
  "TAVILY_API_KEY",
  "KCHAT_MODEL_TIMEOUT_MS",
  "KCHAT_MODEL_RETRY_COUNT",
];

const BAD_HISTORY_PATTERNS = [
  "AGENT_VALIDATION_RETRY_EXHAUSTED",
  "validation failed five times",
  "LOOP_GUARD_TRIGGERED",
  "Waiting for 'user.message'",
  '"status":"WAITING"',
  "WAITING_FOR_EVENT",
  "cannotSatisfy",
  "unsatisfied_by_available_tools",
  '"completionState":"deferred"',
  '"completionState":"blocked"',
  '"artifactVerification":{"status":"inconclusive"',
];

const BLOCKED_CLOSEOUT_PATTERN = "I (?:can(?:not|'t|’t)|still can(?:not|'t|’t)) (?:complete|confirm)";
let activePtyDriver: ReturnType<typeof spawn> | undefined;
let currentAbortReportWriter: ((signal: NodeJS.Signals) => Promise<void>) | undefined;

installTerminationHandlers();

async function main(): Promise<void> {
  await loadShellAndDotEnv(process.cwd(), {
    preferDotEnvKeys: PREFERRED_DOT_ENV_KEYS,
  });

  const options = parseArgs(process.argv.slice(2));
  const prompts = await loadPrompts(options);

  if (options.list) {
    for (const prompt of prompts) {
      console.log(`${prompt.id}\t${path.relative(process.cwd(), prompt.filePath)}`);
    }
    return;
  }

  assertRunnableEnvironment();
  await mkdir(options.workRoot, { recursive: true });
  await pruneOldRuns(options.workRoot, options.keepRuns);

  const reports: PromptRunReport[] = [];
  for (const prompt of prompts) {
    const report = await runPrompt(prompt, options);
    reports.push(report);
    console.log(
      `[cli-prompt-smoke] prompt=${report.id} status=${report.status} workspace=${report.workspacePath}`,
    );
    console.log(`[cli-prompt-smoke] report=${report.reportPath}`);
  }

  const indexPath = path.join(options.workRoot, "latest-report.json");
  await writeFile(indexPath, `${JSON.stringify({ reports }, null, 2)}\n`, "utf8");
  console.log(`[cli-prompt-smoke] index=${indexPath}`);

  if (reports.some((report) => report.status === "failed")) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliPromptSmokeOptions {
  const options: CliPromptSmokeOptions = {
    list: false,
    promptsDir: path.resolve(process.cwd(), DEFAULT_PROMPTS_DIR),
    workRoot: path.resolve(process.cwd(), DEFAULT_WORK_ROOT),
    profile: DEFAULT_PROFILE,
    mode: DEFAULT_MODE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    keepRuns: DEFAULT_KEEP_RUNS,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--prompt") {
      options.prompt = readRequiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--prompts-dir") {
      options.promptsDir = path.resolve(process.cwd(), readRequiredValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--work-root") {
      options.workRoot = path.resolve(process.cwd(), readRequiredValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--profile") {
      options.profile = readRequiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      options.mode = parseMode(readRequiredValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--timeout-seconds") {
      options.timeoutSeconds = parsePositiveInteger(readRequiredValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--keep-runs") {
      options.keepRuns = parsePositiveInteger(readRequiredValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printUsage(): void {
  console.log(`Usage: pnpm run cli:prompt-smoke -- [options]

Options:
  --list                         List prompt files.
  --prompt <id-or-path>          Run one prompt by id, basename, or markdown path.
  --prompts-dir <path>           Markdown prompt directory. Default: ${DEFAULT_PROMPTS_DIR}
  --work-root <path>             Run artifact root. Default: ${DEFAULT_WORK_ROOT}
  --profile <id>                 CLI profile. Default: ${DEFAULT_PROFILE}
  --mode <chat|plan|build>       CLI mode command sent before the prompt. Default: ${DEFAULT_MODE}
  --timeout-seconds <seconds>    Per-prompt timeout. Default: ${DEFAULT_TIMEOUT_SECONDS}
  --keep-runs <count>            Old timestamped runs to keep. Default: ${DEFAULT_KEEP_RUNS}
`);
}

function readRequiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function parseMode(value: string): PromptMode {
  if (value === "chat" || value === "plan" || value === "build") {
    return value;
  }
  throw new Error(`Invalid --mode ${value}; expected chat, plan, or build.`);
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${option} value: ${value}`);
  }
  return parsed;
}

async function loadPrompts(options: CliPromptSmokeOptions): Promise<PromptCase[]> {
  const allPrompts = await loadPromptDirectory(options.promptsDir);
  if (options.prompt === undefined) {
    if (allPrompts.length === 0) {
      throw new Error(`No markdown prompts found in ${options.promptsDir}`);
    }
    return allPrompts;
  }

  const explicitPath = path.resolve(process.cwd(), options.prompt);
  if (await fileExists(explicitPath)) {
    return [await readPromptFile(explicitPath)];
  }

  const matching = allPrompts.find(
    (prompt) =>
      prompt.id === options.prompt ||
      path.basename(prompt.filePath) === options.prompt ||
      path.basename(prompt.filePath, ".md") === options.prompt,
  );
  if (matching === undefined) {
    throw new Error(`Prompt not found: ${options.prompt}`);
  }
  return [matching];
}

async function loadPromptDirectory(promptsDir: string): Promise<PromptCase[]> {
  const entries = await readdir(promptsDir, { withFileTypes: true });
  const promptFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(promptsDir, entry.name))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(promptFiles.map((filePath) => readPromptFile(filePath)));
}

async function readPromptFile(filePath: string): Promise<PromptCase> {
  const raw = await readFile(filePath, "utf8");
  const { text, assertions } = parsePromptMarkdown(raw, filePath);
  if (text.length === 0) {
    throw new Error(`Prompt file is empty: ${filePath}`);
  }
  return {
    id: sanitizeId(path.basename(filePath, ".md")),
    filePath,
    text,
    assertions,
  };
}

async function runPrompt(prompt: PromptCase, options: CliPromptSmokeOptions): Promise<PromptRunReport> {
  const paths = buildPromptRunPaths(prompt, options);

  await mkdir(paths.workspacePath, { recursive: true });
  await mkdir(paths.kestrelHome, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  const promptAssetsPath = await preparePromptAssets({
    prompt,
    promptsDir: options.promptsDir,
    workspacePath: paths.workspacePath,
  });

  currentAbortReportWriter = async (signal) => {
    await writeAbortedPromptReport({
      signal,
      prompt,
      paths,
    });
  };

  const payload = buildPtyPayload({
    prompt,
    options,
    workspacePath: paths.workspacePath,
    kestrelHome: paths.kestrelHome,
    promptAssetsPath,
  });
  let result: CommandResult;
  try {
    result = await runPtyDriver(payload, options.timeoutSeconds + 30);
  } catch (error) {
    result = {
      exitCode: 1,
      stdout: "",
      stderr: `PTY driver failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      durationMs: 0,
    };
  } finally {
    currentAbortReportWriter = undefined;
  }

  await writeFile(paths.transcriptPath, result.stdout, "utf8");
  await writeFile(paths.driverStderrPath, result.stderr, "utf8");

  const history = await readOptionalFile(paths.historyPath);
  const diagnosticsLog = await readOptionalFile(paths.diagnosticsPath);
  const resolvedWorkspaceRoot = await readResolvedWorkspaceRoot(paths.kestrelHome);
  const combinedEvidence = [result.stdout, result.stderr, history, diagnosticsLog].join("\n");
  const badMatches = findBadMatches(combinedEvidence);
  const completed = hasCompletionEvidence(combinedEvidence);
  const createdFiles = await listWorkspaceFiles(paths.workspacePath);
  const assertionResults = await runArtifactAssertions(paths.workspacePath, prompt.assertions);
  const runtimeStatus: SmokeStatus =
    completed && badMatches.length === 0 ? "passed" : "failed";
  const artifactStatus: ArtifactStatus =
    prompt.assertions.length === 0
      ? "not_checked"
      : assertionResults.every((assertion) => assertion.passed)
        ? "passed"
        : "failed";
  const diagnostics = buildDiagnostics({
    result,
    completed,
    badMatches,
    assertionResults,
    createdFiles,
    workspacePath: paths.workspacePath,
    resolvedWorkspaceRoot,
  });
  const status: SmokeStatus =
    runtimeStatus === "passed" && artifactStatus !== "failed" ? "passed" : "failed";

  const report: PromptRunReport = {
    id: prompt.id,
    status,
    runtimeStatus,
    artifactStatus,
    durationMs: result.durationMs,
    promptPath: prompt.filePath,
    runDir: paths.runDir,
    workspacePath: paths.workspacePath,
    resolvedWorkspaceRoot,
    kestrelHome: paths.kestrelHome,
    transcriptPath: paths.transcriptPath,
    driverStderrPath: paths.driverStderrPath,
    historyPath: paths.historyPath,
    diagnosticsPath: paths.diagnosticsPath,
    reportPath: paths.reportPath,
    exitCode: result.exitCode,
    badMatches,
    assertionResults,
    createdFiles,
    diagnostics,
  };
  await writeFile(paths.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function buildPromptRunPaths(prompt: PromptCase, options: CliPromptSmokeOptions): PromptRunPaths {
  const runDir = path.join(options.workRoot, `${timestampKey()}-${prompt.id}`);
  const workspacePath = path.join(runDir, "workspace");
  const kestrelHome = path.join(runDir, "home");
  const logsDir = path.join(runDir, "logs");
  return {
    runDir,
    workspacePath,
    kestrelHome,
    logsDir,
    transcriptPath: path.join(logsDir, "tui-transcript.txt"),
    driverStderrPath: path.join(logsDir, "pty-driver-stderr.txt"),
    historyPath: path.join(kestrelHome, "history.jsonl"),
    diagnosticsPath: path.join(kestrelHome, "logs", "tui-diagnostics.log"),
    reportPath: path.join(runDir, "report.json"),
  };
}

async function writeAbortedPromptReport(input: {
  signal: NodeJS.Signals;
  prompt: PromptCase;
  paths: PromptRunPaths;
}): Promise<void> {
  const history = await readOptionalFile(input.paths.historyPath);
  const diagnosticsLog = await readOptionalFile(input.paths.diagnosticsPath);
  const createdFiles = await listWorkspaceFiles(input.paths.workspacePath).catch(() => []);
  const assertionResults = await runArtifactAssertions(input.paths.workspacePath, input.prompt.assertions).catch(() => []);
  const resolvedWorkspaceRoot = await readResolvedWorkspaceRoot(input.paths.kestrelHome).catch(() => undefined);
  const badMatches = findBadMatches([history, diagnosticsLog].join("\n"));
  const artifactStatus: ArtifactStatus =
    input.prompt.assertions.length === 0
      ? "not_checked"
      : assertionResults.length > 0 && assertionResults.every((assertion) => assertion.passed)
        ? "passed"
        : "failed";
  const report: PromptRunReport = {
    id: input.prompt.id,
    status: "failed",
    runtimeStatus: "failed",
    artifactStatus,
    durationMs: 0,
    promptPath: input.prompt.filePath,
    runDir: input.paths.runDir,
    workspacePath: input.paths.workspacePath,
    resolvedWorkspaceRoot,
    kestrelHome: input.paths.kestrelHome,
    transcriptPath: input.paths.transcriptPath,
    driverStderrPath: input.paths.driverStderrPath,
    historyPath: input.paths.historyPath,
    diagnosticsPath: input.paths.diagnosticsPath,
    reportPath: input.paths.reportPath,
    exitCode: input.signal === "SIGINT" ? 130 : 143,
    badMatches,
    assertionResults,
    createdFiles,
    diagnostics: [
      `CLI prompt smoke terminated by ${input.signal} before a normal final report.`,
      "No completion marker found in transcript, history, or diagnostics.",
      ...badMatches.map((match) => `Matched failure marker: ${match}`),
    ],
  };
  await mkdir(input.paths.logsDir, { recursive: true });
  await writeFile(input.paths.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function buildPtyPayload(input: {
  prompt: PromptCase;
  options: CliPromptSmokeOptions;
  workspacePath: string;
  kestrelHome: string;
  promptAssetsPath: string;
}): PtyPayload {
  const tuiPath = path.resolve(process.cwd(), "cli/tui.ts");
  const tsxImportSpecifier = import.meta.resolve("tsx");
  const sessionName = `cli-prompt-smoke-${input.prompt.id}-${timestampKey()}`;
  const commandText = [
    `cd ${shellQuote(input.workspacePath)}`,
    `${shellQuote(process.execPath)} --import ${shellQuote(tsxImportSpecifier)} ${shellQuote(tuiPath)} --scripted --new-session ${shellQuote(sessionName)} --profile ${shellQuote(input.options.profile)}`,
  ].join(" && ");

  const scriptedLines = [
    `/mode ${input.options.mode}`,
    expandPromptText(input.prompt.text, input.promptAssetsPath),
  ];

  return {
    command: ["/bin/zsh", "-lc", commandText],
    env: {
      ...stringEnv(process.env),
      HOME: input.kestrelHome,
      KESTREL_CORE_HOME: input.kestrelHome,
      KESTREL_LOCAL_CORE_POSTGRES_BUNDLE: readEnvString("KESTREL_LOCAL_CORE_POSTGRES_BUNDLE")
        ?? path.resolve(process.cwd(), "apps/desktop/resources/postgres-bundle"),
      KESTREL_CORE_IDLE_TIMEOUT_MS: readEnvString("KESTREL_CORE_IDLE_TIMEOUT_MS") ?? "60000",
      KCHAT_SCRIPTED_INPUT_LINES_JSON: JSON.stringify(scriptedLines),
      KCHAT_MODEL_TIMEOUT_MS: readEnvString("KCHAT_MODEL_TIMEOUT_MS") ?? "120000",
      KCHAT_MODEL_RETRY_COUNT: readEnvString("KCHAT_MODEL_RETRY_COUNT") ?? "1",
      KESTREL_ENABLE_MANAGED_WORKTREES: "false",
      KESTREL_MANAGED_WORKTREE_ISOLATION: "session",
      NPM_CONFIG_WORKSPACE_DIR: input.workspacePath,
      FORCE_COLOR: "0",
      TERM: "xterm-256color",
    },
    steps: [
      {
        pattern: buildPromptSmokeReadyPattern(input.options.mode),
        regex: true,
        fromCursor: true,
        timeoutSeconds: 120,
      },
      {
        pattern: buildPromptSmokeCompletionPattern(),
        regex: true,
        fromCursor: true,
        timeoutSeconds: input.options.timeoutSeconds,
      },
    ],
    abortPatterns: [
      {
        pattern: "AGENT_VALIDATION_RETRY_EXHAUSTED",
        regex: false,
        reason: "validation_retry_exhausted",
        fromCursor: true,
      },
      {
        pattern: "LOOP_GUARD_TRIGGERED",
        regex: false,
        reason: "loop_guard",
        fromCursor: true,
      },
      {
        pattern: "Run failed:",
        regex: false,
        reason: "run_failed",
        fromCursor: true,
      },
      {
        pattern: BLOCKED_CLOSEOUT_PATTERN,
        regex: true,
        reason: "blocked_closeout",
        fromCursor: true,
      },
    ],
    timeoutSeconds: input.options.timeoutSeconds + 30,
  };
}

async function preparePromptAssets(input: {
  prompt: PromptCase;
  promptsDir: string;
  workspacePath: string;
}): Promise<string> {
  const workspaceAssetsPath = path.join(input.workspacePath, WORKSPACE_PROMPT_ASSETS_DIRNAME);
  if (!input.prompt.text.includes(PROMPT_ASSETS_PLACEHOLDER)) {
    return workspaceAssetsPath;
  }

  const sourceAssetsPath = path.join(input.promptsDir, PROMPT_ASSETS_DIRNAME);
  await cp(sourceAssetsPath, workspaceAssetsPath, { recursive: true });
  return workspaceAssetsPath;
}

function expandPromptText(text: string, promptAssetsPath: string): string {
  return text.replaceAll(PROMPT_ASSETS_PLACEHOLDER, promptAssetsPath);
}

function buildPromptSmokeCompletionPattern(): string {
  return [
    "(?:Run Completed)",
    "(?:Finalize provenance)",
    "(?:run\\.completed)",
    TUI_FINAL_ASSISTANT_PATTERN,
  ].join("|");
}

function buildPromptSmokeReadyPattern(mode: PromptMode): string {
  const modePattern = escapeRegExp(mode);
  return [
    "(?:Started fresh session)",
    "(?:·\\s+CHAT)",
    "(?:·\\s+BUILD)",
    "(?:build mode)",
    `(?:mode\\s*=\\s*${modePattern})`,
  ].join("|");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function runPtyDriver(payload: PtyPayload, timeoutSeconds: number): Promise<CommandResult> {
  const startedAt = Date.now();
  const driverPath = path.resolve(process.cwd(), "tests/ops/helpers/pty_driver.py");
  const child = spawn("python3", [driverPath], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  activePtyDriver = child;

  let stdout = "";
  let stderr = "";
  let settled = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.end(JSON.stringify(payload), "utf8");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      activePtyDriver = activePtyDriver === child ? undefined : activePtyDriver;
      resolve({
        exitCode: 124,
        stdout,
        stderr: `${stderr}\nTimed out after ${timeoutSeconds} seconds.`,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutSeconds * 1000);

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      activePtyDriver = activePtyDriver === child ? undefined : activePtyDriver;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      activePtyDriver = activePtyDriver === child ? undefined : activePtyDriver;
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function installTerminationHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void handleTermination(signal);
    });
  }
}

async function handleTermination(signal: NodeJS.Signals): Promise<void> {
  const driver = activePtyDriver;
  if (driver !== undefined && driver.exitCode === null && driver.signalCode === null) {
    driver.kill("SIGTERM");
  }
  const writer = currentAbortReportWriter;
  if (writer !== undefined) {
    await writer(signal).catch((error) => {
      process.stderr.write(
        `[cli-prompt-smoke] failed to write aborted report: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function assertRunnableEnvironment(): void {
  if (readEnvString("OPENROUTER_API_KEY") === undefined) {
    throw new Error("OPENROUTER_API_KEY is required for CLI prompt smoke runs.");
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return values;
}

function readEnvString(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function findBadMatches(text: string): string[] {
  return BAD_HISTORY_PATTERNS.filter((pattern) => text.includes(pattern));
}

function hasCompletionEvidence(text: string): boolean {
  return (
    text.includes("Run Completed") ||
    text.includes("Finalize provenance") ||
    text.includes("run.completed") ||
    new RegExp(TUI_FINAL_ASSISTANT_PATTERN, "u").test(text) ||
    text.includes('"status":"COMPLETED"')
  );
}

function buildDiagnostics(input: {
  result: CommandResult;
  completed: boolean;
  badMatches: string[];
  assertionResults: AssertionResult[];
  createdFiles: string[];
  workspacePath: string;
  resolvedWorkspaceRoot?: string | undefined;
}): string[] {
  const diagnostics: string[] = [];
  if (input.result.exitCode !== 0 && input.completed) {
    diagnostics.push(`PTY driver exited with code ${input.result.exitCode} after completion marker.`);
  } else if (input.result.exitCode !== 0) {
    diagnostics.push(`PTY driver exited with code ${input.result.exitCode}.`);
  }
  if (!input.completed) {
    diagnostics.push("No completion marker found in transcript, history, or diagnostics.");
  }
  for (const match of input.badMatches) {
    diagnostics.push(`Matched failure marker: ${match}`);
  }
  for (const assertion of input.assertionResults) {
    if (!assertion.passed) {
      diagnostics.push(`Artifact assertion failed: ${assertion.detail}`);
    }
  }
  if (input.createdFiles.length === 0) {
    diagnostics.push("Workspace is empty after run.");
  }
  if (
    input.resolvedWorkspaceRoot !== undefined &&
    path.resolve(input.resolvedWorkspaceRoot) !== path.resolve(input.workspacePath)
  ) {
    diagnostics.push(
      `Resolved workspace root differs from smoke workspace: ${input.resolvedWorkspaceRoot}`,
    );
  }
  return diagnostics;
}

function parsePromptMarkdown(
  raw: string,
  filePath: string,
): { text: string; assertions: PromptAssertion[] } {
  const configMatch = raw.match(/<!--\s*cli-prompt-smoke\s*([\s\S]*?)-->/u);
  if (configMatch === null) {
    return { text: raw.trim(), assertions: [] };
  }

  const configText = configMatch[1]?.trim() ?? "";
  const config = JSON.parse(configText) as { assertions?: unknown };
  return {
    text: raw.replace(configMatch[0], "").trim(),
    assertions: parseAssertions(config.assertions, filePath),
  };
}

function parseAssertions(value: unknown, filePath: string): PromptAssertion[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`cli-prompt-smoke assertions must be an array in ${filePath}`);
  }

  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.type !== "string") {
      throw new Error(`Invalid assertion ${index} in ${filePath}`);
    }
    if (entry.type === "file_exists" && typeof entry.path === "string") {
      return { type: "file_exists", path: entry.path };
    }
    if (
      entry.type === "any_file_exists" &&
      Array.isArray(entry.paths) &&
      entry.paths.every((item) => typeof item === "string")
    ) {
      return { type: "any_file_exists", paths: entry.paths };
    }
    if (
      (entry.type === "file_contains" || entry.type === "file_not_contains") &&
      typeof entry.path === "string" &&
      typeof entry.text === "string"
    ) {
      return {
        type: entry.type,
        path: entry.path,
        text: entry.text,
        ...(typeof entry.caseSensitive === "boolean" ? { caseSensitive: entry.caseSensitive } : {}),
      };
    }
    if (
      (entry.type === "any_file_contains" || entry.type === "any_file_not_contains") &&
      Array.isArray(entry.paths) &&
      entry.paths.every((item) => typeof item === "string") &&
      typeof entry.text === "string"
    ) {
      return {
        type: entry.type,
        paths: entry.paths,
        text: entry.text,
        ...(typeof entry.caseSensitive === "boolean" ? { caseSensitive: entry.caseSensitive } : {}),
      };
    }
    if (
      entry.type === "json_array_min_length" &&
      typeof entry.path === "string" &&
      typeof entry.minLength === "number" &&
      Number.isFinite(entry.minLength)
    ) {
      return {
        type: "json_array_min_length",
        path: entry.path,
        minLength: Math.max(0, Math.trunc(entry.minLength)),
        ...(typeof entry.arrayPath === "string" ? { arrayPath: entry.arrayPath } : {}),
      };
    }
    throw new Error(`Invalid assertion ${index} in ${filePath}`);
  });
}

async function runArtifactAssertions(
  workspacePath: string,
  assertions: PromptAssertion[],
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    const targetPaths = readAssertionPaths(workspacePath, assertion);
    const escapedPath = targetPaths.find((targetPath) => !isWorkspaceChild(workspacePath, targetPath));
    if (escapedPath !== undefined) {
      results.push({
        type: assertion.type,
        path: formatAssertionPath(assertion),
        ...(targetPaths.length > 1 ? { paths: targetPaths } : {}),
        passed: false,
        detail: `${path.relative(workspacePath, escapedPath)} escapes workspace`,
      });
      continue;
    }
    if (assertion.type === "file_exists") {
      const exists = await fileExists(targetPaths[0] as string);
      results.push({
        type: assertion.type,
        path: assertion.path,
        passed: exists,
        detail: exists ? `${assertion.path} exists` : `${assertion.path} does not exist`,
      });
      continue;
    }
    if (assertion.type === "any_file_exists") {
      const existingPaths = await readExistingAssertionPaths(targetPaths);
      results.push({
        type: assertion.type,
        path: assertion.paths.join(", "),
        paths: assertion.paths,
        passed: existingPaths.length > 0,
        detail: existingPaths.length > 0
          ? `found ${existingPaths.map((filePath) => path.relative(workspacePath, filePath)).join(", ")}`
          : `none of ${assertion.paths.join(", ")} exists`,
      });
      continue;
    }
    if (assertion.type === "json_array_min_length") {
      const raw = await readOptionalFile(targetPaths[0] as string);
      const result = evaluateJsonArrayMinLength(raw, assertion.arrayPath, assertion.minLength);
      results.push({
        type: assertion.type,
        path: assertion.path,
        passed: result.passed,
        detail: result.detail,
      });
      continue;
    }

    if (assertion.type === "file_contains" || assertion.type === "file_not_contains") {
      const content = await readOptionalFile(targetPaths[0] as string);
      const contains = textIncludes(content, assertion.text, assertion.caseSensitive);
      const passed = assertion.type === "file_contains" ? contains : !contains;
      results.push({
        type: assertion.type,
        path: assertion.path,
        passed,
        detail: passed
          ? `${assertion.path} satisfied ${assertion.type}`
          : `${assertion.path} ${assertion.type === "file_contains" ? "does not contain" : "contains"} ${JSON.stringify(assertion.text)}`,
      });
      continue;
    }

    const existingPaths = await readExistingAssertionPaths(targetPaths);
    const contentByPath = await Promise.all(
      existingPaths.map(async (filePath) => ({
        filePath,
        content: await readOptionalFile(filePath),
      })),
    );
    const matchingPaths = contentByPath
      .filter((entry) => textIncludes(entry.content, assertion.text, assertion.caseSensitive))
      .map((entry) => entry.filePath);
    const passed = assertion.type === "any_file_contains"
      ? matchingPaths.length > 0
      : matchingPaths.length === 0;
    results.push({
      type: assertion.type,
      path: assertion.paths.join(", "),
      paths: assertion.paths,
      passed,
      detail: passed
        ? `${assertion.paths.join(", ")} satisfied ${assertion.type}`
        : assertion.type === "any_file_contains"
          ? `none of ${assertion.paths.join(", ")} contains ${JSON.stringify(assertion.text)}`
          : `${matchingPaths.map((filePath) => path.relative(workspacePath, filePath)).join(", ")} contains ${JSON.stringify(assertion.text)}`,
    });
  }
  return results;
}

function evaluateJsonArrayMinLength(
  raw: string,
  arrayPath: string | undefined,
  minLength: number,
): { passed: boolean; detail: string } {
  if (raw.trim().length === 0) {
    return { passed: false, detail: "JSON file is missing or empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      passed: false,
      detail: `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const value = arrayPath === undefined || arrayPath.trim().length === 0
    ? parsed
    : readJsonPath(parsed, arrayPath);
  if (!Array.isArray(value)) {
    return {
      passed: false,
      detail: arrayPath === undefined
        ? "JSON root is not an array"
        : `JSON path ${arrayPath} is not an array`,
    };
  }
  return {
    passed: value.length >= minLength,
    detail: `JSON array${arrayPath === undefined ? "" : ` ${arrayPath}`} length ${value.length}; expected at least ${minLength}`,
  };
}

function readJsonPath(value: unknown, jsonPath: string): unknown {
  return jsonPath
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .reduce<unknown>((current, part) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[part];
    }, value);
}

function textIncludes(content: string, text: string, caseSensitive: boolean | undefined): boolean {
  if (caseSensitive === true) {
    return content.includes(text);
  }
  return content.toLowerCase().includes(text.toLowerCase());
}

function readAssertionPaths(workspacePath: string, assertion: PromptAssertion): string[] {
  if ("paths" in assertion) {
    return assertion.paths.map((assertionPath) => path.resolve(workspacePath, assertionPath));
  }
  return [path.resolve(workspacePath, assertion.path)];
}

function formatAssertionPath(assertion: PromptAssertion): string {
  return "paths" in assertion ? assertion.paths.join(", ") : assertion.path;
}

function isWorkspaceChild(workspacePath: string, targetPath: string): boolean {
  const resolvedWorkspace = path.resolve(workspacePath);
  return targetPath.startsWith(`${resolvedWorkspace}${path.sep}`) || targetPath === resolvedWorkspace;
}

async function readExistingAssertionPaths(targetPaths: string[]): Promise<string[]> {
  const existingPaths: string[] = [];
  for (const targetPath of targetPaths) {
    if (await fileExists(targetPath)) {
      existingPaths.push(targetPath);
    }
  }
  return existingPaths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readResolvedWorkspaceRoot(kestrelHome: string): Promise<string | undefined> {
  const raw = await readOptionalFile(path.join(kestrelHome, "workspaces.json"));
  if (raw.length === 0) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as {
    workspaces?: Array<{ rootPath?: unknown; launchCwd?: unknown }>;
  };
  const workspace = parsed.workspaces?.[0];
  return typeof workspace?.rootPath === "string" ? workspace.rootPath : undefined;
}

async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const files: string[] = [];
  await collectFiles(workspacePath, workspacePath, files);
  return files.sort((left, right) => left.localeCompare(right));
}

async function collectFiles(root: string, current: string, files: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      await collectFiles(root, entryPath, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(path.relative(root, entryPath));
    }
  }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function pruneOldRuns(workRoot: string, keepRuns: number): Promise<void> {
  const entries = await readdir(workRoot, { withFileTypes: true }).catch(() => []);
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}-/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  for (const staleRun of runDirs.slice(keepRuns)) {
    await rm(path.join(workRoot, staleRun), { recursive: true, force: true });
  }
}

function sanitizeId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (sanitized.length === 0) {
    throw new Error(`Could not derive prompt id from ${value}`);
  }
  return sanitized;
}

function timestampKey(date = new Date()): string {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
