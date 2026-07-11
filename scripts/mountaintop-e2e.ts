import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";
import { extractWaitPrompt } from "../cli/app/waitForPrompt.js";
import {
  buildEvidenceCompletionSummary,
  parseEvidenceLedger,
  summarizeToolEvidenceLedger,
} from "../agents/reference-react/src/evidenceLedger.js";
import { createOpenRouterModelGatewayFromEnv } from "../models/openrouter/createOpenRouterModelGateway.js";
import { buildDefaultKestrelDatabaseUrl } from "../src/config/localDev.js";
import type { ModelResponse } from "../src/kestrel/contracts/model-io.js";

import { createPostgresSessionStoreFromUrl } from "../src/store/createPostgresSessionStore.js";
import { MOUNTAINTOP_SCENARIOS, getMountaintopScenarioById } from "../tests/mountaintop/scenarios/index.js";
import type {
  MountaintopCompletionMode,
  MountaintopEngine,
  MountaintopEngineResult,
  MountaintopFailureBucket,
  MountaintopJsonArrayArtifactRequirement,
  MountaintopPromptEnvelope,
  MountaintopReport,
  MountaintopRunStatus,
  MountaintopScenario,
  MountaintopToolEvidenceRequirement,
} from "../tests/mountaintop/types.js";

interface MountaintopOptions {
  list: boolean;
  scenarioId: string;
  engine: MountaintopEngineMode;
  continueOnFailure: boolean;
  keepRuns: number;
  autoDb: boolean;
  openrouterModel?: string | undefined;
}

type MountaintopEngineMode = "both" | "cli" | "web";

interface CommandOutcome {
  status: MountaintopRunStatus;
  exitCode: number;
  durationMs: number;
  outputPath: string;
  diagnostics: string[];
}

interface PtyStep {
  pattern: string;
  regex: boolean;
  fromCursor?: boolean;
  timeoutSeconds?: number;
  send?: string;
  actions?: Array<{
    typeText?: string;
    key?: "enter" | "esc";
    settleMs?: number;
  }>;
}

interface PtyPayload {
  command: string[];
  env: Record<string, string>;
  steps: PtyStep[];
  abortPatterns?: Array<{
    pattern: string;
    regex: boolean;
    reason?: string;
    fromCursor?: boolean;
    maxMatches?: number;
  }>;
  timeoutSeconds: number;
}

interface PtyControlCommand {
  type: "send_text" | "terminate";
  text?: string;
}

interface ParityCheckResult {
  id: string;
  status: MountaintopRunStatus;
  diagnostics: string[];
}

export interface RuntimeRunContext {
  sessionId: string;
  runId?: string | undefined;
}

interface RuntimeRunCleanupResult {
  status: "closed" | "no_active_run" | "cleanup_failed";
  sessionId: string;
  runId?: string | undefined;
  reason?: string | undefined;
}

interface RuntimeRunEventRow {
  eventType: string;
  stepIndex: number | null;
  stepName: string | null;
  occurredAt: string;
}

interface RuntimeRunFailureEventRow {
  code?: string | undefined;
  message?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

interface RuntimeMarkerTimeoutEvidence {
  lastCommand?: string | undefined;
  completedExitCode?: number | undefined;
  remediationEvidenceToken?: string | undefined;
  recentCommands: string[];
}

interface RuntimeCompletionAttribution {
  runtimeCompletedAt?: string | undefined;
  markerObservedAt?: string | undefined;
  wrapperValidationDurationMs?: number | undefined;
  postMarkerRuntimeShellActions: number;
  postMarkerSettledTerminalPollingRedirects: number;
}

interface PersistedTuiSessionSnapshot {
  name: string;
  sessionId: string;
  lastRunStatus?: string | undefined;
  pendingWaitFor?: unknown;
}

interface RecentConversationMessage {
  role: "user" | "assistant";
  text: string;
}

interface SimulatedUserWaitDecision {
  kind: "none" | "reply" | "turn_cap_exhausted";
  fingerprint?: string | undefined;
  prompt?: string | undefined;
  diagnostics: string[];
}

export interface RuntimeQualityGateEvidence {
  successfulCommands: string[];
  verificationItems: string[];
  diagnostics: string[];
}

export interface RuntimeSessionStateEvidenceLookup {
  state?: unknown | undefined;
  diagnostics: string[];
}

interface CliAdapterSuccess {
  transcript: string;
  runtimeContext: RuntimeRunContext;
}

class CliAdapterFailure extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly failureCode: string;
  readonly timeoutPattern?: string | undefined;
  readonly runtimeSessionName: string;
  readonly runtimeSessionId: string;
  readonly runtimeRunId?: string | undefined;

  constructor(input: {
    message: string;
    stdout: string;
    stderr: string;
    failureCode: string;
    runtimeSessionName: string;
    runtimeSessionId: string;
    runtimeRunId?: string | undefined;
    timeoutPattern?: string | undefined;
  }) {
    super(input.message);
    this.name = "CliAdapterFailure";
    this.stdout = input.stdout;
    this.stderr = input.stderr;
    this.failureCode = input.failureCode;
    this.timeoutPattern = input.timeoutPattern;
    this.runtimeSessionName = input.runtimeSessionName;
    this.runtimeSessionId = input.runtimeSessionId;
    this.runtimeRunId = input.runtimeRunId;
  }
}

const DEFAULT_SCENARIO = "nextjs-template-dual-shell";
const DEFAULT_ENGINE_MODE: MountaintopEngineMode = "both";
const DEFAULT_KEEP_RUNS = 10;
const DEFAULT_WORKSPACES_ROOT_NAME = "kestrel-mountaintop-workspaces";
const DB_UP_COMMAND = ["pnpm", ["run", "db:up"]] as const;
const DB_MIGRATE_COMMAND = ["node", ["--import", "tsx", "scripts/migrate.ts"]] as const;
const MOUNTAINTOP_DOTENV_KEYS = [
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_NAME",
  "KCHAT_MODEL_TIMEOUT_MS",
  "KCHAT_MODEL_RETRY_COUNT",
];
const CLI_ABORT_PATTERNS: NonNullable<PtyPayload["abortPatterns"]> = [
  {
    pattern: "Run failed:",
    regex: false,
    reason: "kchat_run_failed",
    fromCursor: true,
  },
  {
    pattern: "The directory .* contains files that could conflict",
    regex: true,
    reason: "directory_conflict",
    fromCursor: true,
  },
];

const DEFAULT_SETUP_COMMAND_TIMEOUT_SECONDS = 120;
const TSX_IMPORT_SPECIFIER = import.meta.resolve("tsx");
const CLI_RUN_STARTED_PATTERN =
  "(?:Kestrel Chat · Run started for 'user\\.message'\\.)|(?:Run started\\.)|(?:Run started for 'user\\.message'\\.)|(?:Committed step 'react\\.[^']+' with status 'RUNNING'\\.)|(?:Saved react\\.[^\\s]+ \\(running\\)\\.)";
const CLI_FINALIZE_PATTERN = "The process has been finalized successfully";

export function buildCliRunStartedPattern(): string {
  return CLI_RUN_STARTED_PATTERN;
}

export function buildCliFinalizePattern(): string {
  return CLI_FINALIZE_PATTERN;
}

export function buildCliCompletionPattern(completionMarker: string): string {
  const marker = completionMarker.trim();
  if (marker.length === 0) {
    return CLI_FINALIZE_PATTERN;
  }
  return `(?:^|\\n)\\s*(?:<<\\s*)?${escapeRegex(marker)}\\s*(?:$|\\n)|${CLI_FINALIZE_PATTERN}`;
}

export function resolveMountaintopWorkspacesBaseRoot(): string {
  const override = readNonEmptyEnv("MOUNTAINTOP_WORKSPACES_ROOT");
  return path.resolve(override ?? path.join(os.tmpdir(), DEFAULT_WORKSPACES_ROOT_NAME));
}

export function resolveMountaintopWorkspacesRoot(runKey: string): string {
  return path.join(resolveMountaintopWorkspacesBaseRoot(), runKey);
}

function resolveScenarioPromptEnvelope(scenario: MountaintopScenario): MountaintopPromptEnvelope {
  return scenario.promptEnvelope ?? "benchmark";
}

function resolveScenarioCompletionMode(scenario: MountaintopScenario): MountaintopCompletionMode {
  return scenario.completionMode ?? "marker";
}

function resolveScenarioCompletionMarker(scenario: MountaintopScenario): string {
  return typeof scenario.completionMarker === "string" ? scenario.completionMarker.trim() : "";
}

function scenarioSupportsEngine(scenario: MountaintopScenario, engine: MountaintopEngine): boolean {
  return scenario.supportedEngines?.includes(engine) ?? true;
}

function buildScenarioCompletionPattern(scenario: MountaintopScenario): string {
  return resolveScenarioCompletionMode(scenario) === "runtime_finalize"
    ? buildCliFinalizePattern()
    : buildCliCompletionPattern(resolveScenarioCompletionMarker(scenario));
}

function isScenarioCompletionDetected(transcript: string, scenario: MountaintopScenario): boolean {
  if (resolveScenarioCompletionMode(scenario) === "runtime_finalize") {
    return new RegExp(buildCliFinalizePattern(), "u").test(transcript);
  }
  const marker = resolveScenarioCompletionMarker(scenario);
  return marker.length > 0 && transcript.includes(marker);
}

function describeMissingCompletionSignal(scenario: MountaintopScenario, engine: MountaintopEngine): string {
  if (resolveScenarioCompletionMode(scenario) === "runtime_finalize") {
    return `Runtime finalize signal not found in ${engine} transcript.`;
  }
  return `Completion marker '${resolveScenarioCompletionMarker(scenario)}' not found in ${engine} transcript.`;
}

async function main(): Promise<void> {
  await loadShellAndDotEnv(process.cwd(), {
    preferDotEnvKeys: MOUNTAINTOP_DOTENV_KEYS,
  });
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    renderScenarioList();
    return;
  }

  let scenario = getMountaintopScenarioById(options.scenarioId);
  if (scenario === undefined) {
    throw new Error(`Unknown scenario '${options.scenarioId}'. Run --list to see available scenarios.`);
  }

  if (options.openrouterModel !== undefined) {
    if (scenario.provider.provider !== "openrouter") {
      throw new Error("--openrouter-model can only be used with scenarios whose provider is openrouter.");
    }
    scenario = {
      ...scenario,
      provider: {
        ...scenario.provider,
        model: options.openrouterModel,
      },
    };
  }

  const scenarioValidation = validateMountaintopScenario(scenario);
  if (scenarioValidation.length > 0) {
    throw new Error(`Scenario '${scenario.id}' is invalid:\n${scenarioValidation.join("\n")}`);
  }

  const engineOrder = resolveScenarioEngineOrder(options.engine, scenario);
  const parityEngineMode: MountaintopEngineMode = engineOrder.length === 1 ? engineOrder[0]! : options.engine;

  const mountaintopRoot = path.join(process.cwd(), "tmp", "mountaintop");
  await mkdir(mountaintopRoot, { recursive: true });
  await pruneMountaintopRuns(mountaintopRoot, options.keepRuns);
  const workspacesBaseRoot = resolveMountaintopWorkspacesBaseRoot();
  if (workspacesBaseRoot !== mountaintopRoot) {
    await pruneMountaintopRuns(workspacesBaseRoot, options.keepRuns);
  }

  const runKey = `${timestampKey()}-${scenario.id}`;
  const runDir = path.join(mountaintopRoot, runKey);
  const logsDir = path.join(runDir, "logs");
  const workspacesRoot = resolveMountaintopWorkspacesRoot(runKey);
  await mkdir(logsDir, { recursive: true });
  await mkdir(workspacesRoot, { recursive: true });
  process.stdout.write(`[mountaintop] scenario=${scenario.id} logs=${runDir}\n`);
  process.stdout.write(`[mountaintop] provider=${scenario.provider.provider} model=${scenario.provider.model}\n`);
  process.stdout.write(`[mountaintop] workspaces=${workspacesRoot}\n`);

  const infraDiagnostics = validateInfraEnvironment(process.env, scenario);
  const reports: MountaintopEngineResult[] = [];
  if (infraDiagnostics.length > 0) {
    const report: MountaintopReport = buildReport({
      scenarioId: scenario.id,
      logsDir: runDir,
      startedAt: new Date(),
      endedAt: new Date(),
      engines: reports,
      parityChecks: [{ id: "infra.preflight", status: "infra_failed", diagnostics: infraDiagnostics }],
    });
    await writeReport(runDir, report);
    renderReportSummary(report);
    process.exitCode = 1;
    return;
  }

  const dbUrl = resolveOpsDatabaseUrl();
  const dbReady = await isPostgresReachable(dbUrl);
  if (!dbReady) {
    if (!options.autoDb) {
      const report: MountaintopReport = buildReport({
        scenarioId: scenario.id,
        logsDir: runDir,
        startedAt: new Date(),
        endedAt: new Date(),
        engines: reports,
        parityChecks: [{
          id: "infra.database",
          status: "infra_failed",
          diagnostics: [`Postgres is not reachable at ${dbUrl}. Start it with 'pnpm run db:up' or rerun with --auto-db.`],
        }],
      });
      await writeReport(runDir, report);
      renderReportSummary(report);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("[mountaintop] postgres not reachable; starting docker postgres via `pnpm run db:up`.\n");
    const dbUpLog = path.join(logsDir, "infra.db-up.log");
    const dbUp = await runCommand({
      id: "infra.db-up",
      command: DB_UP_COMMAND[0],
      args: [...DB_UP_COMMAND[1]],
      cwd: process.cwd(),
      env: process.env,
      outputPath: dbUpLog,
    });
    if (dbUp.status !== "passed") {
      const report: MountaintopReport = buildReport({
        scenarioId: scenario.id,
        logsDir: runDir,
        startedAt: new Date(),
        endedAt: new Date(),
        engines: reports,
        parityChecks: [{
          id: "infra.db-up",
          status: dbUp.status,
          diagnostics: dbUp.diagnostics,
        }],
      });
      await writeReport(runDir, report);
      renderReportSummary(report);
      process.exitCode = 1;
      return;
    }
  }

  const dbReadyLog = path.join(logsDir, "infra.db-ready.log");
  const dbReadiness = await waitForPostgresReady({
    databaseUrl: dbUrl,
  });
  await writeFile(
    dbReadyLog,
    buildPostgresReadyLog(dbReadiness),
    "utf8",
  );
  if (!dbReadiness.ready) {
    const report: MountaintopReport = buildReport({
      scenarioId: scenario.id,
      logsDir: runDir,
      startedAt: new Date(),
      endedAt: new Date(),
      engines: reports,
      parityChecks: [{
        id: "infra.db-ready",
        status: "failed",
        diagnostics: [
          `Postgres did not become query-ready for ${dbUrl} within ${dbReadiness.timeoutMs}ms.`,
          ...(dbReadiness.lastError === undefined ? [] : [`Last readiness error: ${dbReadiness.lastError}`]),
          `Readiness evidence: ${dbReadyLog}`,
        ],
      }],
    });
    await writeReport(runDir, report);
    renderReportSummary(report);
    process.exitCode = 1;
    return;
  }

  const dbMigrateLog = path.join(logsDir, "infra.db-migrate.log");
  const dbMigrate = await runCommand({
    id: "infra.db-migrate",
    command: DB_MIGRATE_COMMAND[0],
    args: [...DB_MIGRATE_COMMAND[1]],
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
    },
    outputPath: dbMigrateLog,
  });
  if (dbMigrate.status !== "passed") {
    const report: MountaintopReport = buildReport({
      scenarioId: scenario.id,
      logsDir: runDir,
      startedAt: new Date(),
      endedAt: new Date(),
      engines: reports,
      parityChecks: [{
        id: "infra.db-migrate",
        status: dbMigrate.status,
        diagnostics: dbMigrate.diagnostics,
      }],
    });
    await writeReport(runDir, report);
    renderReportSummary(report);
    process.exitCode = 1;
    return;
  }

  const startedAt = new Date();
  for (const engine of engineOrder) {
    const result = await runEngine({
      engine,
      scenario,
      runDir,
      logsDir,
      workspacesRoot,
      databaseUrl: dbUrl,
    });
    reports.push(result);
    process.stdout.write(
      `[mountaintop] ${result.engine} status=${result.status} durationMs=${result.durationMs} workspace=${result.workspacePath}\n`,
    );
    if (result.status !== "passed" && !options.continueOnFailure) {
      break;
    }
  }

  const parityChecks = buildParityChecksForMode(reports, parityEngineMode);
  const report = buildReport({
    scenarioId: scenario.id,
    logsDir: runDir,
    startedAt,
    endedAt: new Date(),
    engines: reports,
    parityChecks,
  });
  await writeReport(runDir, report);
  renderReportSummary(report);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

function parseArgs(rawArgs: string[]): MountaintopOptions {
  const args = rawArgs.filter((token) => token !== "--");
  const parsed: MountaintopOptions = {
    list: false,
    scenarioId: DEFAULT_SCENARIO,
    engine: DEFAULT_ENGINE_MODE,
    continueOnFailure: false,
    keepRuns: DEFAULT_KEEP_RUNS,
    autoDb: false,
    openrouterModel: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--help") {
      printUsage();
      process.exit(0);
    }
    if (token === "--list") {
      parsed.list = true;
      continue;
    }
    if (token === "--continue-on-failure") {
      parsed.continueOnFailure = true;
      continue;
    }
    if (token === "--auto-db") {
      parsed.autoDb = true;
      continue;
    }
    if (token === "--openrouter-model") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
        throw new Error("--openrouter-model requires a value");
      }
      parsed.openrouterModel = value.trim();
      index += 1;
      continue;
    }
    if (token === "--scenario") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--scenario requires a value");
      }
      parsed.scenarioId = value;
      index += 1;
      continue;
    }
    if (token === "--engine") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--engine requires a value");
      }
      if (value !== "both" && value !== "cli" && value !== "web") {
        throw new Error("--engine must be one of: both, cli, web");
      }
      parsed.engine = value;
      index += 1;
      continue;
    }
    if (token === "--keep-runs") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--keep-runs requires a positive integer");
      }
      parsed.keepRuns = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument '${token}'`);
  }
  return parsed;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: node --import tsx scripts/mountaintop-e2e.ts [options]",
      "",
      "Options:",
      "  --list                   List available Mountain Top scenarios.",
      "  --scenario <id>          Scenario id to run (default: nextjs-template-dual-shell).",
      "  --engine <mode>          Engine mode: both, cli, or web (default: both).",
      "  --continue-on-failure    Continue remaining engines after a failure.",
      "  --keep-runs <count>      Retention window for tmp/mountaintop runs (default: 10).",
      "  --auto-db                Start postgres via `pnpm run db:up` if DB preflight fails.",
      "  --openrouter-model <id>  Override the scenario OpenRouter model id (openrouter scenarios only).",
      "",
      "Examples:",
      "  pnpm run mountaintop:list",
      "  pnpm run mountaintop:run -- --scenario nextjs-template-dual-shell",
      "  pnpm run mountaintop:newsletter -- --openrouter-model qwen/qwen-2.5-7b-instruct",
    ].join("\n"),
  );
}

function renderScenarioList(): void {
  for (const scenario of MOUNTAINTOP_SCENARIOS) {
    process.stdout.write(`${scenario.id} :: ${scenario.title}\n`);
  }
}

export function validateMountaintopScenario(scenario: MountaintopScenario): string[] {
  const errors: string[] = [];
  if (scenario.id.trim().length === 0) {
    errors.push("id is required");
  }
  if (scenario.operatorPrompt !== undefined && scenario.operatorPrompt.trim().length === 0) {
    errors.push("operatorPrompt must not be blank when provided");
  }
  if (scenario.promptProgram.length === 0) {
    errors.push("promptProgram must include at least one step");
  }
  if (
    scenario.simulatedUser !== undefined &&
    (scenario.simulatedUser.mode !== "explicit_waits" || scenario.simulatedUser.maxTurns <= 0)
  ) {
    errors.push("simulatedUser must use mode 'explicit_waits' with a positive maxTurns");
  }
  if (scenario.requiredArtifacts.length === 0) {
    errors.push("requiredArtifacts must include at least one path");
  }
  if (scenario.requiredArtifactAlternatives?.some((group) => group.paths.length === 0)) {
    errors.push("requiredArtifactAlternatives entries must include at least one path");
  }
  if (scenario.requiredJsonArrayArtifacts?.some((requirement) => requirement.paths.length === 0)) {
    errors.push("requiredJsonArrayArtifacts entries must include at least one path");
  }
  if (
    scenario.requiredJsonArrayArtifacts?.some(
      (requirement) => requirement.arrayPath.trim().length === 0 || requirement.minLength <= 0,
    )
  ) {
    errors.push("requiredJsonArrayArtifacts entries must include a non-empty arrayPath and positive minLength");
  }
  if (
    scenario.requiredJsonArrayArtifacts?.some(
      (requirement) =>
        requirement.requiredAbsoluteUrlFields?.some((field) => field.trim().length === 0) === true ||
        requirement.forbiddenStringLiterals?.some((value) => value.trim().length === 0) === true,
    )
  ) {
    errors.push(
      "requiredJsonArrayArtifacts entries must not include blank requiredAbsoluteUrlFields or forbiddenStringLiterals",
    );
  }
  if (scenario.requiredToolEvidence?.some((requirement) => requirement.tools.length === 0)) {
    errors.push("requiredToolEvidence entries must include at least one tool name");
  }
  if (
    scenario.requiredToolEvidence?.some(
      (requirement) =>
        requirement.tools.some((tool) => tool.trim().length === 0) ||
        (requirement.minSuccessfulCalls !== undefined && requirement.minSuccessfulCalls <= 0),
    )
  ) {
    errors.push("requiredToolEvidence entries must not include blank tool names and must use a positive minSuccessfulCalls");
  }
  if (scenario.supportedEngines !== undefined && scenario.supportedEngines.length === 0) {
    errors.push("supportedEngines must include at least one engine when provided");
  }
  if (
    resolveScenarioCompletionMode(scenario) === "marker" &&
    resolveScenarioCompletionMarker(scenario).length === 0
  ) {
    errors.push("completionMarker is required when completionMode is 'marker'");
  }
  if (scenario.completionTimeoutSeconds <= 0) {
    errors.push("completionTimeoutSeconds must be positive");
  }
  return errors;
}

function resolveScenarioWorkspacePrecondition(scenario: MountaintopScenario): "package_json" | "none" {
  return scenario.workspacePrecondition ?? "package_json";
}

function validateInfraEnvironment(env: NodeJS.ProcessEnv, scenario: MountaintopScenario): string[] {
  const diagnostics: string[] = [];
  const key = env.OPENROUTER_API_KEY?.trim();
  if (key === undefined || key.length === 0) {
    diagnostics.push("Missing OPENROUTER_API_KEY for provider-backed Mountain Top run.");
  }
  if (scenario.provider.profileId.trim().length === 0) {
    diagnostics.push("Scenario provider profile id is empty.");
  }
  return diagnostics;
}

async function runEngine(input: {
  engine: MountaintopEngine;
  scenario: MountaintopScenario;
  runDir: string;
  logsDir: string;
  workspacesRoot: string;
  databaseUrl: string;
}): Promise<MountaintopEngineResult> {
  const started = Date.now();
  const workspacePath = path.join(input.workspacesRoot, input.engine);
  const homePath = path.join(input.runDir, "home", input.engine);
  const kestrelHomePath = path.join(homePath, ".kestrel");
  const transcriptPath = path.join(input.logsDir, `${input.engine}.transcript.log`);
  const transcriptStderrPath = path.join(input.logsDir, `${input.engine}.transcript.stderr.log`);
  const transcriptTailPath = path.join(input.logsDir, `${input.engine}.transcript.tail.log`);
  await mkdir(workspacePath, { recursive: true });
  await mkdir(kestrelHomePath, { recursive: true });
  await writeMountaintopModelPolicy(kestrelHomePath, input.scenario);

  if (!scenarioSupportsEngine(input.scenario, input.engine)) {
    const message = `Scenario '${input.scenario.id}' does not support engine '${input.engine}'.`;
    await writeFile(transcriptPath, `${message}\n`, "utf8");
    return {
      engine: input.engine,
      status: "infra_failed",
      failureBucket: "harness",
      failureBucketDiagnostics: [
        "Failure bucket=harness because the scenario does not support this engine.",
      ],
      durationMs: Date.now() - started,
      workspacePath,
      transcriptPath,
      diagnostics: [message],
      completionDetected: false,
      qualityGateResults: [],
      artifactChecks: [],
      toolEvidence: {
        successfulCalls: [],
        failedCalls: [],
        checks: [],
        diagnostics: [message],
      },
      modelEvidence: {
        requestedProvider: input.scenario.provider.provider,
        requestedModel: input.scenario.provider.model,
        observedProviders: [],
        observedModels: [],
        diagnostics: [message],
      },
      smokeChecks: [],
    };
  }

  let completionDetected = false;
  const diagnostics: string[] = [];
  const blockingDiagnostics: string[] = [];
  let runtimeContext: RuntimeRunContext | undefined;
  let runtimeFailureObserved = false;

  try {
    if (input.engine === "cli") {
      const adapterResult = await runCliAdapter({
        scenario: input.scenario,
        workspacePath,
        homePath,
        kestrelHomePath,
        databaseUrl: input.databaseUrl,
      });
      runtimeContext = adapterResult.runtimeContext;
      const transcript = adapterResult.transcript;
      await writeFile(transcriptPath, transcript, "utf8");
      completionDetected = isScenarioCompletionDetected(transcript, input.scenario);
      if (!completionDetected) {
        const message = describeMissingCompletionSignal(input.scenario, "cli");
        diagnostics.push(message);
        blockingDiagnostics.push(message);
      }
    } else {
      const transcript = await runWebAdapter({
        scenario: input.scenario,
        workspacePath,
        databaseUrl: input.databaseUrl,
        logsDir: input.logsDir,
      });
      await writeFile(transcriptPath, transcript, "utf8");
      completionDetected = isScenarioCompletionDetected(transcript, input.scenario);
      if (!completionDetected) {
        const message = describeMissingCompletionSignal(input.scenario, "web");
        diagnostics.push(message);
        blockingDiagnostics.push(message);
      }
    }
  } catch (error) {
    if (input.engine === "cli" && error instanceof CliAdapterFailure) {
      await writeFile(transcriptPath, error.stdout, "utf8");
      await writeFile(transcriptStderrPath, error.stderr, "utf8");
      const tailSource = error.stderr.trim().length > 0 ? error.stderr : error.stdout;
      const tail = extractTranscriptTail(tailSource);
      if (tail !== undefined) {
        await writeFile(transcriptTailPath, tail, "utf8");
      }
      const failureRuntimeContext =
        error.runtimeRunId !== undefined
          ? {
              sessionId: error.runtimeSessionId,
              runId: error.runtimeRunId,
            }
          : await resolveRuntimeRunContextForSession({
            databaseUrl: input.databaseUrl,
            sessionId: error.runtimeSessionId,
          });
      runtimeContext = failureRuntimeContext;
      const recoveredCompletion =
        error.failureCode === "marker_timeout" &&
        await detectRuntimeCompletionEvidence({
          databaseUrl: input.databaseUrl,
          runId: failureRuntimeContext.runId,
          scenario: input.scenario,
      });
      if (recoveredCompletion) {
        completionDetected = true;
      } else {
        const runtimeCleanup = await closeRuntimeRunAfterCliAdapterFailure({
          databaseUrl: input.databaseUrl,
          runtimeContext: failureRuntimeContext,
          failureCode: error.failureCode,
          timeoutPattern: error.timeoutPattern,
        });
        const runtimeMarkerTimeoutDiagnostics =
          error.failureCode === "marker_timeout"
            ? await collectRuntimeMarkerTimeoutDiagnostics({
                databaseUrl: input.databaseUrl,
                sessionId: runtimeCleanup.sessionId,
              })
            : [];
        const runtimeProgressDiagnostics = await collectRuntimeProgressGapDiagnostics({
          databaseUrl: input.databaseUrl,
          runId: runtimeCleanup.runId,
          focusStep: "react.observer",
        });
        const runtimeFailureDiagnostics = await collectRuntimeFailureDiagnostics({
          databaseUrl: input.databaseUrl,
          runId: runtimeCleanup.runId ?? error.runtimeRunId,
        });
        runtimeFailureObserved = runtimeFailureDiagnostics.length > 0;
        const failureDiagnostics = [
          ...buildCliAdapterFailureDiagnostics({
            failureCode: error.failureCode,
            timeoutPattern: error.timeoutPattern,
            transcriptStdoutPath: transcriptPath,
            transcriptStderrPath,
            runtimeSessionName: error.runtimeSessionName,
            runtimeSessionId: runtimeCleanup.sessionId,
            runtimeRunId: runtimeCleanup.runId,
            runtimeCleanupStatus: runtimeCleanup.status,
            ...(runtimeCleanup.reason !== undefined
              ? { runtimeCleanupReason: runtimeCleanup.reason }
              : {}),
            ...(tail !== undefined ? { transcriptTailPath } : {}),
          }),
          ...runtimeMarkerTimeoutDiagnostics,
          ...runtimeProgressDiagnostics,
          ...runtimeFailureDiagnostics,
        ];
        diagnostics.push(...failureDiagnostics);
        blockingDiagnostics.push(...failureDiagnostics);
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(message);
      blockingDiagnostics.push(message);
    }
  }

  const validationWorkspacePath =
    input.engine === "cli" && runtimeContext !== undefined
      ? await resolveRuntimeValidationWorkspacePath({
          databaseUrl: input.databaseUrl,
          runtimeContext,
          fallbackWorkspacePath: workspacePath,
          kestrelHomePath,
        })
      : workspacePath;
  if (validationWorkspacePath !== workspacePath) {
    diagnostics.push(`Validated managed worktree workspace: ${validationWorkspacePath}`);
  }

  const artifactChecks = await checkRequiredArtifacts(
    validationWorkspacePath,
    input.scenario.requiredArtifacts,
    input.scenario.requiredArtifactAlternatives ?? [],
    input.scenario.requiredJsonArrayArtifacts ?? [],
  );
  const toolEvidence = await collectToolEvidence({
    kestrelHomePath,
    databaseUrl: input.databaseUrl,
    runtimeContext,
    requiredToolEvidence: input.scenario.requiredToolEvidence ?? [],
  });
  const modelEvidence = await collectModelEvidence({
    kestrelHomePath,
    provider: input.scenario.provider,
  });
  const workspacePrecondition = resolveScenarioWorkspacePrecondition(input.scenario);
  const workspacePreconditionsMet =
    workspacePrecondition === "none"
      ? true
      : await checkWorkspaceValidationPreconditions(validationWorkspacePath);
  const gateResults = workspacePreconditionsMet
    ? await runQualityGates({
        kestrelHomePath,
        databaseUrl: input.databaseUrl,
        runtimeContext,
        logsDir: input.logsDir,
        engine: input.engine,
        gates: input.scenario.qualityGates,
      })
    : await buildSkippedQualityGateResults({
        logsDir: input.logsDir,
        engine: input.engine,
        gates: input.scenario.qualityGates,
        reason: "Skipped quality gates: workspace precondition missing package.json.",
      });
  const smokeChecks = workspacePreconditionsMet
    ? await runSmokeChecks({
        workspacePath: validationWorkspacePath,
        logsDir: input.logsDir,
        engine: input.engine,
        routes: input.scenario.smokeRoutes,
      })
    : await buildSkippedSmokeChecks({
        logsDir: input.logsDir,
        engine: input.engine,
        routes: input.scenario.smokeRoutes,
        reason: "Skipped smoke checks: workspace precondition missing package.json.",
      });
  if (!workspacePreconditionsMet) {
    const message = "Workspace validation precondition failed: package.json not found in benchmark workspace.";
    diagnostics.push(message);
    blockingDiagnostics.push(message);
  }
  const unsatisfiedToolEvidence = toolEvidence.checks.filter((check) => check.satisfied === false);
  if (unsatisfiedToolEvidence.length > 0) {
    const messages = unsatisfiedToolEvidence.flatMap((check) => check.diagnostics);
    diagnostics.push(...messages);
    blockingDiagnostics.push(...messages);
  }

  if (input.engine === "cli") {
    const runtimeCompletionDiagnostics = await collectRuntimeCompletionAttributionDiagnostics({
      databaseUrl: input.databaseUrl,
      runtimeContext,
      completionDetected,
      scenario: input.scenario,
      reportEndedAt: new Date(),
    });
    diagnostics.push(...runtimeCompletionDiagnostics);
  }

  const status = deriveEngineStatus({
    blockingDiagnostics,
    completionDetected,
    artifactChecks,
    toolEvidence,
    gateResults,
    smokeChecks,
  });
  const failureBucket = deriveFailureBucket({
    status,
    completionDetected,
    runtimeFailureObserved,
    artifactChecks,
    toolEvidence,
    gateResults,
    smokeChecks,
  });
  diagnostics.push(...failureBucket.diagnostics);

  return {
    engine: input.engine,
    status,
    failureBucket: failureBucket.bucket,
    failureBucketDiagnostics: failureBucket.diagnostics,
    durationMs: Date.now() - started,
    workspacePath,
    transcriptPath,
    diagnostics,
    completionDetected,
    qualityGateResults: gateResults,
    artifactChecks,
    toolEvidence,
    modelEvidence,
    smokeChecks,
  };
}

export function buildScenarioPrompt(scenario: MountaintopScenario): string {
  const numbered = scenario.promptProgram.map((step, index) => `${index + 1}. ${step.instruction}`).join("\n");
  if (resolveScenarioPromptEnvelope(scenario) === "operator") {
    const operatorPrompt = scenario.operatorPrompt?.trim();
    if (operatorPrompt !== undefined && operatorPrompt.length > 0) {
      return operatorPrompt;
    }
    return scenario.promptProgram.map((step) => step.instruction).join("\n");
  }
  return [
    `Run scenario '${scenario.id}'.`,
    "Use current directory only.",
    "Single pass; non-interactive commands only; do not rerun bootstrap after success.",
    "Use dev.shell.run commands only for edits/checks; do not call fs.read_text or fs.write_text.",
    `After printing '${resolveScenarioCompletionMarker(scenario)}', stop immediately and do not issue additional tool calls.`,
    numbered,
    `Final line must be exactly '${resolveScenarioCompletionMarker(scenario)}'.`,
  ].join("\n");
}

async function runCliAdapter(input: {
  scenario: MountaintopScenario;
  workspacePath: string;
  homePath: string;
  kestrelHomePath: string;
  databaseUrl: string;
}): Promise<CliAdapterSuccess> {
  const driverPath = path.resolve(process.cwd(), "tests/ops/helpers/pty_driver.py");
  const tuiPath = path.resolve(process.cwd(), "cli/tui.ts");
  const sessionName = `mountaintop-cli-${Date.now()}`;
  const prompt = buildScenarioPrompt(input.scenario);
  const scriptedInputLines = [...input.scenario.setupCommands, prompt];
  const command = [
    "/bin/zsh",
    "-lc",
    `cd ${shellQuote(input.workspacePath)} && ${process.execPath} --import ${shellQuote(TSX_IMPORT_SPECIFIER)} ${shellQuote(tuiPath)} --scripted --new-session ${shellQuote(sessionName)} --profile ${shellQuote(input.scenario.provider.profileId)}`,
  ];
  const payload: PtyPayload = {
    command,
    env: {
      ...readStringEnv(process.env),
      HOME: input.homePath,
      KESTREL_HOME: input.kestrelHomePath,
      DATABASE_URL: input.databaseUrl,
      ...buildProviderModelEnv(input.scenario.provider),
      KCHAT_MODEL_TIMEOUT_MS: resolveKchatModelTimeoutMs(),
      KCHAT_MODEL_RETRY_COUNT: resolveKchatModelRetryCount(),
      KESTREL_ENABLE_MANAGED_WORKTREES: "false",
      KESTREL_MANAGED_WORKTREE_ISOLATION: "session",
      KCHAT_SCRIPTED_INPUT_LINES_JSON: JSON.stringify(scriptedInputLines),
      NPM_CONFIG_WORKSPACE_DIR: input.workspacePath,
      FORCE_COLOR: "0",
      TERM: "xterm-256color",
    },
    steps: [
      {
        pattern: "(?:·\\s+CHAT)|(?:Started fresh session)|(?:No workspace bound to the active session\\.)",
        regex: true,
        fromCursor: true,
        timeoutSeconds: DEFAULT_SETUP_COMMAND_TIMEOUT_SECONDS,
      },
      {
        pattern: buildCliRunStartedPattern(),
        regex: true,
        fromCursor: true,
        timeoutSeconds: 180,
      },
    ],
    abortPatterns: CLI_ABORT_PATTERNS,
    timeoutSeconds: input.scenario.completionTimeoutSeconds,
  };
  const result = await runPythonDriverUntilScenarioCompletion({
    scriptPath: driverPath,
    payload: JSON.stringify(payload),
    kestrelHomePath: input.kestrelHomePath,
    sessionName,
    databaseUrl: input.databaseUrl,
    scenario: input.scenario,
  });
  if (result.exitCode !== 0) {
    const combined = `${result.stderr}\n${result.stdout}`.trim();
    const failureCode = classifyCliAdapterFailure(combined);
    const timeoutPattern = extractTimeoutPattern(combined);
    const persistedSessionId = await resolvePersistedSessionIdFromKestrelHome({
      kestrelHomePath: input.kestrelHomePath,
      sessionName,
    });
    const runtimeContext = await resolveRuntimeRunContextForSession({
      databaseUrl: input.databaseUrl,
      sessionId: persistedSessionId ?? sessionName,
    });
    throw new CliAdapterFailure({
      message:
        timeoutPattern === undefined
          ? `CLI adapter failed: ${failureCode}`
          : `CLI adapter failed: ${failureCode}:${timeoutPattern}`,
      stdout: result.stdout,
      stderr: result.stderr,
      failureCode,
      runtimeSessionName: sessionName,
      runtimeSessionId: runtimeContext.sessionId,
      runtimeRunId: runtimeContext.runId,
      timeoutPattern,
    });
  }
  const persistedSessionId = await resolvePersistedSessionIdFromKestrelHome({
    kestrelHomePath: input.kestrelHomePath,
    sessionName,
  });
  const runtimeContext = await resolveRuntimeRunContextForSession({
    databaseUrl: input.databaseUrl,
    sessionId: persistedSessionId ?? sessionName,
  });
  const completionMarker = resolveScenarioCompletionMarker(input.scenario);
  const transcript =
    resolveScenarioCompletionMode(input.scenario) === "marker"
      ? (
          runtimeContext.runId !== undefined &&
            completionMarker.length > 0 &&
            result.stdout.includes(completionMarker) === false &&
            await detectRuntimeCompletionEvidence({
              databaseUrl: input.databaseUrl,
              runId: runtimeContext.runId,
              scenario: input.scenario,
            })
            ? `${result.stdout}\n${completionMarker}\n`
            : result.stdout
        )
      : (
          "runtimeCompletionObserved" in result &&
            result.runtimeCompletionObserved === true &&
            new RegExp(buildCliFinalizePattern(), "u").test(result.stdout) === false
            ? `${result.stdout}\nThe process has been finalized successfully.\n`
            : result.stdout
        );
  return {
    transcript,
    runtimeContext,
  };
}

function resolveKchatModelTimeoutMs(): string {
  return readNonEmptyEnv("KCHAT_MODEL_TIMEOUT_MS") ?? "120000";
}

function resolveKchatModelRetryCount(): string {
  return readNonEmptyEnv("KCHAT_MODEL_RETRY_COUNT") ?? "1";
}

function readNonEmptyEnv(key: string): string | undefined {
  const value = process.env[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

export async function resolvePersistedSessionIdFromKestrelHome(input: {
  kestrelHomePath: string;
  sessionName: string;
}): Promise<string | undefined> {
  const sessionsPath = path.join(input.kestrelHomePath, "sessions.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sessionsPath, "utf8"));
  } catch {
    return undefined;
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { sessions?: unknown }).sessions)
  ) {
    return undefined;
  }

  const sessions = (parsed as { sessions: unknown[] }).sessions;
  for (const entry of sessions) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as { name?: unknown; sessionId?: unknown };
    if (record.name !== input.sessionName) {
      continue;
    }
    if (typeof record.sessionId === "string" && record.sessionId.trim().length > 0) {
      return record.sessionId;
    }
  }
  return undefined;
}

async function readPersistedSessionSnapshotFromKestrelHome(input: {
  kestrelHomePath: string;
  sessionName: string;
}): Promise<PersistedTuiSessionSnapshot | undefined> {
  const sessionsPath = path.join(input.kestrelHomePath, "sessions.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sessionsPath, "utf8"));
  } catch {
    return undefined;
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { sessions?: unknown }).sessions)
  ) {
    return undefined;
  }

  const sessions = (parsed as { sessions: unknown[] }).sessions;
  for (const entry of sessions) {
    const record = asRecord(entry);
    if (record?.name !== input.sessionName) {
      continue;
    }
    const sessionId = readStringValue(record.sessionId)?.trim();
    if (sessionId === undefined || sessionId.length === 0) {
      continue;
    }
    return {
      name: input.sessionName,
      sessionId,
      lastRunStatus: readStringValue(record.lastRunStatus),
      ...(record.pendingWaitFor !== undefined ? { pendingWaitFor: record.pendingWaitFor } : {}),
    };
  }
  return undefined;
}

export function buildSimulatedUserWaitFingerprint(input: {
  sessionId: string;
  waitFor: unknown;
}): string {
  return JSON.stringify({
    sessionId: input.sessionId,
    waitFor: input.waitFor,
  });
}

export function evaluateSimulatedUserWaitDecision(input: {
  sessionSnapshot: PersistedTuiSessionSnapshot | undefined;
  seenWaitFingerprints: ReadonlySet<string>;
  maxTurns: number;
}): SimulatedUserWaitDecision {
  const sessionSnapshot = input.sessionSnapshot;
  if (sessionSnapshot === undefined) {
    return { kind: "none", diagnostics: [] };
  }
  if (sessionSnapshot.lastRunStatus !== "WAITING" || sessionSnapshot.pendingWaitFor === undefined) {
    return { kind: "none", diagnostics: [] };
  }
  const prompt = extractWaitPrompt(sessionSnapshot.pendingWaitFor as never)?.trim();
  if (prompt === undefined || prompt.length === 0) {
    return { kind: "none", diagnostics: [] };
  }
  const fingerprint = buildSimulatedUserWaitFingerprint({
    sessionId: sessionSnapshot.sessionId,
    waitFor: sessionSnapshot.pendingWaitFor,
  });
  if (input.seenWaitFingerprints.has(fingerprint)) {
    return { kind: "none", diagnostics: [] };
  }
  if (input.seenWaitFingerprints.size >= input.maxTurns) {
    return {
      kind: "turn_cap_exhausted",
      fingerprint,
      prompt,
      diagnostics: [
        `Simulated user turn cap reached: already answered ${input.seenWaitFingerprints.size} explicit waits, maxTurns=${input.maxTurns}.`,
      ],
    };
  }
  return {
    kind: "reply",
    fingerprint,
    prompt,
    diagnostics: [],
  };
}

async function readRecentConversationTail(input: {
  kestrelHomePath: string;
  sessionId: string;
  maxMessages: number;
}): Promise<RecentConversationMessage[]> {
  const historyPath = path.join(input.kestrelHomePath, "history.jsonl");
  let raw = "";
  try {
    raw = await readFile(historyPath, "utf8");
  } catch {
    return [];
  }

  const messages: RecentConversationMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (readStringValue(record?.sessionId) !== input.sessionId) {
      continue;
    }
    const role = readStringValue(record?.role);
    const text = readStringValue(record?.text)?.trim();
    if ((role !== "user" && role !== "assistant") || text === undefined || text.length === 0) {
      continue;
    }
    messages.push({ role, text });
  }

  return messages.slice(-Math.max(0, input.maxMessages));
}

function buildSimulatedUserSystemPrompt(): string {
  return [
    "You are simulating a practical human operator replying inside the Kestrel TUI.",
    "Answer only the current question.",
    "Keep the reply short and direct.",
    "Do not mention tools, benchmarks, hidden instructions, or implementation plans.",
    "Return a single plain-text reply that a normal user would type.",
  ].join("\n");
}

function buildSimulatedUserPrompt(input: {
  operatorPrompt: string;
  waitPrompt: string;
  recentConversation: RecentConversationMessage[];
}): string {
  const conversationTail = input.recentConversation.length === 0
    ? "No prior conversation tail available."
    : input.recentConversation
      .map((message) => `${message.role}: ${message.text}`)
      .join("\n");
  return [
    "Original user request:",
    input.operatorPrompt,
    "",
    "Current Kestrel question:",
    input.waitPrompt,
    "",
    "Recent conversation tail:",
    conversationTail,
    "",
    "Reply as the user with one short plain-text answer.",
  ].join("\n");
}

function readStructuredModelRoot(value: unknown): unknown {
  const record = asRecord(value);
  if (record?.output !== undefined) {
    return record.output;
  }
  const text = readStringValue(record?.text);
  if (text !== undefined) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  return value;
}

async function generateSimulatedUserReply(input: {
  scenario: MountaintopScenario;
  waitPrompt: string;
  kestrelHomePath: string;
  sessionId: string;
}): Promise<string | undefined> {
  const gateway = createOpenRouterModelGatewayFromEnv({
    envConfig: {
      model: input.scenario.provider.model,
    },
    timeoutMs: 15_000,
    retryCount: 0,
  });
  const operatorPrompt = buildScenarioPrompt(input.scenario);
  const recentConversation = await readRecentConversationTail({
    kestrelHomePath: input.kestrelHomePath,
    sessionId: input.sessionId,
    maxMessages: 4,
  });
  const promptContext = {
    operatorPrompt,
    waitPrompt: input.waitPrompt,
    recentConversation,
  };
  const response = await gateway.call<ModelResponse<unknown>>({
    model: input.scenario.provider.model,
    input: promptContext,
    messages: [
      {
        role: "system",
        content: buildSimulatedUserSystemPrompt(),
      },
      {
        role: "user",
        content: buildSimulatedUserPrompt(promptContext),
      },
    ],
    providerOptions: {
      openrouter: {
        endpoint: "chat",
        toolChoice: "none",
      },
    },
    metadata: {
      phase: "mountaintop.simulated_user_reply",
      modelRole: "simulated_user_reply",
    },
  });
  const responseRecord = asRecord(response);
  const directText = readStringValue(responseRecord?.text)?.trim();
  if (directText !== undefined && directText.length > 0) {
    return directText;
  }
  const root = readStructuredModelRoot(response);
  const structuredReply =
    (typeof root === "string" ? root : readStringValue(asRecord(root)?.reply))?.trim();
  return structuredReply !== undefined && structuredReply.length > 0 ? structuredReply : undefined;
}

export function resolveManagedWorktreeValidationWorkspacePath(
  fallbackWorkspacePath: string,
  sessionState: Record<string, unknown> | undefined,
): string {
  const agent = asRecord(sessionState?.agent);
  const exec = asRecord(agent?.exec);
  const binding = asRecord(exec?.managedWorktreeBinding);
  const worktreeRoot = typeof binding?.worktreeRoot === "string" ? binding.worktreeRoot.trim() : "";
  if (binding?.status === "bound" && worktreeRoot.length > 0) {
    return worktreeRoot;
  }
  return fallbackWorkspacePath;
}

async function runWebAdapter(input: {
  scenario: MountaintopScenario;
  workspacePath: string;
  databaseUrl: string;
  logsDir: string;
}): Promise<string> {
  const webAppDir = path.resolve(process.cwd(), "apps/web");
  const port = 3320;
  const webLogPath = path.join(input.logsDir, "web.server.log");
  const webBuildLog = path.join(input.logsDir, "web.build.log");

  const build = await runCommand({
    id: "web.build",
    command: "pnpm",
    args: ["exec", "next", "build"],
    cwd: webAppDir,
    env: {
      ...process.env,
      DATABASE_URL: input.databaseUrl,
      KCHAT_OPS_CONSOLE_ENABLED: "true",
    },
    outputPath: webBuildLog,
  });
  if (build.status !== "passed") {
    throw new Error(`Web adapter build failed. See ${webBuildLog}`);
  }

  const webServer = spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: webAppDir,
    env: {
      ...process.env,
      DATABASE_URL: input.databaseUrl,
      KCHAT_OPS_CONSOLE_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let webLogs = "";
  webServer.stdout.on("data", (chunk) => {
    webLogs += chunk.toString("utf8");
  });
  webServer.stderr.on("data", (chunk) => {
    webLogs += chunk.toString("utf8");
  });

  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 30_000);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const transcript: string[] = [];
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.waitForSelector("#kchat-input:not([disabled])", { timeout: 60_000 });

    for (const commandText of input.scenario.setupCommands) {
      await page.fill("#kchat-input", commandText);
      await page.press("#kchat-input", "Enter");
      transcript.push(`> ${commandText}`);
      await page.waitForTimeout(600);
    }

    const prompt = buildScenarioPrompt(input.scenario);
    await page.fill("#kchat-input", prompt);
    await page.press("#kchat-input", "Enter");
    transcript.push(`> ${prompt}`);
    if (resolveScenarioCompletionMode(input.scenario) === "runtime_finalize") {
      await page.getByText(new RegExp(buildCliFinalizePattern(), "u")).waitFor({
        timeout: input.scenario.completionTimeoutSeconds * 1000,
      });
      transcript.push("The process has been finalized successfully.");
    } else {
      const marker = resolveScenarioCompletionMarker(input.scenario);
      await page.getByText(marker).waitFor({
        timeout: input.scenario.completionTimeoutSeconds * 1000,
      });
      transcript.push(marker);
    }

    await browser.close();
    return transcript.join("\n");
  } finally {
    await writeFile(webLogPath, webLogs, "utf8");
    terminateProcess(webServer);
  }
}

export async function runQualityGates(input: {
  kestrelHomePath: string;
  databaseUrl?: string | undefined;
  runtimeContext?: RuntimeRunContext | undefined;
  logsDir: string;
  engine: MountaintopEngine;
  gates: MountaintopScenario["qualityGates"];
}): Promise<MountaintopEngineResult["qualityGateResults"]> {
  const results: MountaintopEngineResult["qualityGateResults"] = [];
  const evidence = await collectRuntimeQualityGateEvidence({
    kestrelHomePath: input.kestrelHomePath,
    databaseUrl: input.databaseUrl,
    runtimeContext: input.runtimeContext,
  });
  for (const gate of input.gates) {
    const outputPath = path.join(input.logsDir, `${input.engine}.gate.${gate.id}.log`);
    const expectedCommand = formatGateCommand(gate.command, gate.args);
    const gateEvidence = deriveQualityGateEvidence({
      expectedCommand,
      evidence,
    });
    await writeFile(outputPath, formatQualityGateEvidenceLog({
      gateId: gate.id,
      expectedCommand,
      required: gate.required,
      gateEvidence,
      evidence,
    }), "utf8");
    results.push({
      id: gate.id,
      label: gate.label,
      required: gate.required,
      status: gateEvidence.status,
      durationMs: 0,
      outputPath,
      diagnostics: gateEvidence.diagnostics,
    });
  }
  return results;
}

export async function collectRuntimeQualityGateEvidence(input: {
  kestrelHomePath: string;
  databaseUrl?: string | undefined;
  runtimeContext?: RuntimeRunContext | undefined;
}): Promise<RuntimeQualityGateEvidence> {
  const sessionStateLookup = await readRuntimeSessionStateForEvidence({
    databaseUrl: input.databaseUrl,
    runtimeContext: input.runtimeContext,
  });
  if (sessionStateLookup.state !== undefined) {
    const ledgerEvidence = collectRuntimeQualityGateEvidenceFromSessionStateForTests(sessionStateLookup.state);
    if (ledgerEvidence.successfulCommands.length > 0 || ledgerEvidence.verificationItems.length > 0) {
      return ledgerEvidence;
    }
  }

  const historyPath = path.join(input.kestrelHomePath, "history.jsonl");
  const successfulCommands = new Set<string>();
  const verificationItems = new Set<string>();
  const diagnostics: string[] = [...sessionStateLookup.diagnostics];
  let raw = "";
  try {
    raw = await readFile(historyPath, "utf8");
  } catch {
    diagnostics.push(`Runtime quality-gate evidence unavailable: ${historyPath} not found.`);
  }

  if (raw.length > 0) {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      collectRuntimeQualityGateEvidenceFromHistoryRecord(parsed, successfulCommands, verificationItems);
    }
  }

  return {
    successfulCommands: [...successfulCommands].sort((left, right) => left.localeCompare(right)),
    verificationItems: [...verificationItems].sort((left, right) => left.localeCompare(right)),
    diagnostics,
  };
}

export function collectRuntimeQualityGateEvidenceFromSessionStateForTests(
  sessionState: unknown,
): RuntimeQualityGateEvidence {
  const ledger = readRuntimeEvidenceLedgerFromSessionState(sessionState);
  const completion = buildEvidenceCompletionSummary({ ledger });
  const successfulCommands = new Set<string>();
  const verificationItems = new Set<string>();
  for (const token of completion.supportedTokens) {
    if (token.startsWith("check:") === false) {
      continue;
    }
    const normalized = normalizeGateEvidenceCommand(token.slice("check:".length));
    if (normalized !== undefined) {
      successfulCommands.add(normalized);
      verificationItems.add(normalized);
    }
  }
  return {
    successfulCommands: [...successfulCommands].sort((left, right) => left.localeCompare(right)),
    verificationItems: [...verificationItems].sort((left, right) => left.localeCompare(right)),
    diagnostics: [],
  };
}

function collectRuntimeQualityGateEvidenceFromHistoryRecord(
  record: unknown,
  successfulCommands: Set<string>,
  verificationItems: Set<string>,
): void {
  const root = asRecord(record);
  const data = asRecord(root?.data);
  if (data === undefined) {
    return;
  }

  const finalizeData = asRecord(asRecord(data?.finalizeInput)?.data);
  collectDecisionVerificationItems(asRecord(data?.decisionVerification)?.verificationSteps, verificationItems);
  collectDecisionVerificationItems(asRecord(finalizeData?.decisionVerification)?.verificationSteps, verificationItems);
  collectRuntimeEvidenceSummaryChecks(data?.runtimeEvidenceSummary, successfulCommands);
  collectRuntimeEvidenceSummaryChecks(finalizeData?.runtimeEvidenceSummary, successfulCommands);

  const lastActionResult = asRecord(data?.lastActionResult);
  if (readStringValue(lastActionResult?.kind) !== "tool") {
    return;
  }
  const toolName = readStringValue(lastActionResult?.name);
  if (toolName !== "dev.shell.run" && toolName !== "dev.process.start") {
    return;
  }
  const output = asRecord(lastActionResult?.output);
  const status = readStringValue(output?.status);
  const exitCode = readIntegerValue(output?.exitCode);
  if (status !== "COMPLETED" || exitCode !== 0) {
    return;
  }
  const command = readStringValue(output?.command) ?? readStringValue(asRecord(lastActionResult?.input)?.command);
  if (command === undefined) {
    return;
  }
  for (const segment of splitShellAndChainCommands(command)) {
    const normalized = normalizeGateEvidenceCommand(segment);
    if (normalized !== undefined) {
      successfulCommands.add(normalized);
    }
  }
}

function collectRuntimeEvidenceSummaryChecks(value: unknown, target: Set<string>): void {
  const summary = asRecord(value);
  for (const token of readQualityGateStringArray(summary?.supportedTokens)) {
    const trimmed = token.trim();
    if (trimmed.startsWith("check:") === false) {
      continue;
    }
    const normalized = normalizeGateEvidenceCommand(trimmed.slice("check:".length));
    if (normalized !== undefined) {
      target.add(normalized);
    }
  }
}

function collectDecisionVerificationItems(value: unknown, target: Set<string>): void {
  for (const item of readQualityGateStringArray(value)) {
    const trimmed = item.trim();
    const command = trimmed.startsWith("check:") ? trimmed.slice("check:".length) : trimmed;
    const normalized = normalizeGateEvidenceCommand(command);
    if (normalized !== undefined) {
      target.add(normalized);
    }
  }
}

function readQualityGateStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function deriveQualityGateEvidence(input: {
  expectedCommand: string;
  evidence: RuntimeQualityGateEvidence;
}): { status: MountaintopRunStatus; diagnostics: string[] } {
  const expectedCommand = normalizeGateEvidenceCommand(input.expectedCommand);
  if (expectedCommand === undefined) {
    return {
      status: "failed",
      diagnostics: ["Quality gate command is empty."],
    };
  }
  const hasVerificationItem = input.evidence.verificationItems.includes(expectedCommand);
  const hasSuccessfulCommand = input.evidence.successfulCommands.includes(expectedCommand);
  if (hasVerificationItem && hasSuccessfulCommand) {
    return {
      status: "passed",
      diagnostics: [],
    };
  }
  return {
    status: "failed",
    diagnostics: [
      `Runtime quality-gate evidence missing for '${expectedCommand}': verificationItem=${hasVerificationItem ? "present" : "missing"}, successfulCommand=${hasSuccessfulCommand ? "present" : "missing"}.`,
      ...input.evidence.diagnostics,
    ],
  };
}

function formatQualityGateEvidenceLog(input: {
  gateId: string;
  expectedCommand: string;
  required: boolean;
  gateEvidence: { status: MountaintopRunStatus; diagnostics: string[] };
  evidence: RuntimeQualityGateEvidence;
}): string {
  return JSON.stringify(
    {
      gateId: input.gateId,
      expectedCommand: input.expectedCommand,
      required: input.required,
      status: input.gateEvidence.status,
      diagnostics: input.gateEvidence.diagnostics,
      evidence: input.evidence,
    },
    null,
    2,
  );
}

function formatGateCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export function splitShellAndChainCommands(command: string): string[] {
  const commands: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaping = true;
      continue;
    }
    if (quote !== undefined) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      current += char;
      quote = char;
      continue;
    }
    if (char === "&" && next === "&") {
      const normalized = normalizeGateEvidenceCommand(current);
      if (normalized !== undefined) {
        commands.push(normalized);
      }
      current = "";
      index += 1;
      continue;
    }
    current += char;
  }
  const normalized = normalizeGateEvidenceCommand(current);
  if (normalized !== undefined) {
    commands.push(normalized);
  }
  return commands;
}

function normalizeGateEvidenceCommand(command: string): string | undefined {
  const normalized = command.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : undefined;
}

export async function checkWorkspaceValidationPreconditions(workspacePath: string): Promise<boolean> {
  const packageJsonPath = path.join(workspacePath, "package.json");
  try {
    const fileStat = await stat(packageJsonPath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function buildSkippedQualityGateResults(input: {
  logsDir: string;
  engine: MountaintopEngine;
  gates: MountaintopScenario["qualityGates"];
  reason: string;
}): Promise<MountaintopEngineResult["qualityGateResults"]> {
  const results: MountaintopEngineResult["qualityGateResults"] = [];
  for (const gate of input.gates) {
    const outputPath = path.join(input.logsDir, `${input.engine}.gate.${gate.id}.log`);
    await writeFile(outputPath, input.reason, "utf8");
    results.push({
      id: gate.id,
      label: gate.label,
      required: gate.required,
      status: "infra_failed",
      durationMs: 0,
      outputPath,
      diagnostics: [input.reason],
    });
  }
  return results;
}

async function runSmokeChecks(input: {
  workspacePath: string;
  logsDir: string;
  engine: MountaintopEngine;
  routes: MountaintopScenario["smokeRoutes"];
}): Promise<MountaintopEngineResult["smokeChecks"]> {
  if (input.routes.length === 0) {
    return [];
  }
  const port = input.engine === "cli" ? 4301 : 4302;
  const outputPath = path.join(input.logsDir, `${input.engine}.smoke.server.log`);
  const commandEnv = await buildWorkspaceCommandEnv({
    workspacePath: input.workspacePath,
    logsDir: input.logsDir,
  });
  const server = spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: input.workspacePath,
    env: commandEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLogs = "";
  server.stdout.on("data", (chunk) => {
    serverLogs += chunk.toString("utf8");
  });
  server.stderr.on("data", (chunk) => {
    serverLogs += chunk.toString("utf8");
  });

  const checks: MountaintopEngineResult["smokeChecks"] = [];
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 45_000);
    for (const route of input.routes) {
      const response = await fetch(`http://127.0.0.1:${port}${route.path}`);
      const body = normalizeSmokeCheckBody(await response.text());
      const missing = route.contains.filter((needle) => !body.includes(needle));
      if (!response.ok || missing.length > 0) {
        checks.push({
          route: route.path,
          status: "failed",
          diagnostics: [
            !response.ok ? `HTTP ${response.status}` : "",
            ...missing.map((needle) => `Missing marker '${needle}'`),
          ].filter((line) => line.length > 0),
        });
      } else {
        checks.push({
          route: route.path,
          status: "passed",
          diagnostics: [],
        });
      }
    }
  } catch (error) {
    checks.push({
      route: "/",
      status: "infra_failed",
      diagnostics: [error instanceof Error ? error.message : String(error)],
    });
  } finally {
    await writeFile(outputPath, serverLogs, "utf8");
    terminateProcess(server);
  }
  return checks;
}

export function normalizeSmokeCheckBody(body: string): string {
  return decodeHtmlEntities(body);
}

export async function collectToolEvidence(input: {
  kestrelHomePath: string;
  databaseUrl?: string | undefined;
  runtimeContext?: RuntimeRunContext | undefined;
  requiredToolEvidence: MountaintopToolEvidenceRequirement[];
}): Promise<MountaintopEngineResult["toolEvidence"]> {
  const sessionStateLookup = await readRuntimeSessionStateForEvidence({
    databaseUrl: input.databaseUrl,
    runtimeContext: input.runtimeContext,
  });
  if (sessionStateLookup.state !== undefined) {
    const ledgerEvidence = collectToolEvidenceFromSessionStateForTests({
      sessionState: sessionStateLookup.state,
      requiredToolEvidence: input.requiredToolEvidence,
    });
    if (ledgerEvidence.successfulCalls.length > 0 || ledgerEvidence.failedCalls.length > 0) {
      return ledgerEvidence;
    }
  }

  const historyPath = path.join(input.kestrelHomePath, "history.jsonl");
  const sessionsPath = path.join(input.kestrelHomePath, "sessions.json");
  const successfulCounts = new Map<string, number>();
  const failedCounts = new Map<string, number>();
  const diagnostics: string[] = [...sessionStateLookup.diagnostics];
  let raw = "";
  try {
    raw = await readFile(historyPath, "utf8");
  } catch {
    diagnostics.push(`Structured tool evidence unavailable: ${historyPath} not found.`);
  }

  if (raw.length > 0) {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      collectStructuredToolEvidenceFromHistoryRecord(parsed, successfulCounts, failedCounts);
    }
  }

  let sessionsRaw = "";
  try {
    sessionsRaw = await readFile(sessionsPath, "utf8");
  } catch {}
  if (sessionsRaw.length > 0) {
    try {
      collectStructuredToolEvidenceFromSessionsSnapshot(
        JSON.parse(sessionsRaw),
        successfulCounts,
      );
    } catch {
      diagnostics.push(`Structured tool evidence supplement unreadable: ${sessionsPath}.`);
    }
  }

  return buildToolEvidenceResult({
    successfulCounts,
    failedCounts,
    diagnostics,
    requiredToolEvidence: input.requiredToolEvidence,
  });
}

export function collectToolEvidenceFromSessionStateForTests(input: {
  sessionState: unknown;
  requiredToolEvidence: MountaintopToolEvidenceRequirement[];
}): MountaintopEngineResult["toolEvidence"] {
  const ledger = readRuntimeEvidenceLedgerFromSessionState(input.sessionState);
  const summary = summarizeToolEvidenceLedger({ ledger }) ?? {
    successfulCalls: [],
    failedCalls: [],
  };
  return buildToolEvidenceResult({
    successfulCounts: countToolEvidenceRows(summary.successfulCalls),
    failedCounts: countToolEvidenceRows(summary.failedCalls),
    diagnostics: [],
    requiredToolEvidence: input.requiredToolEvidence,
  });
}

function buildToolEvidenceResult(input: {
  successfulCounts: Map<string, number>;
  failedCounts: Map<string, number>;
  diagnostics: string[];
  requiredToolEvidence: MountaintopToolEvidenceRequirement[];
}): MountaintopEngineResult["toolEvidence"] {
  const checks = input.requiredToolEvidence.map((requirement) => {
    const minSuccessfulCalls = requirement.minSuccessfulCalls ?? 1;
    const matchedSuccessfulCalls = requirement.tools.reduce(
      (sum, toolName) => sum + (input.successfulCounts.get(toolName) ?? 0),
      0,
    );
    const satisfied = matchedSuccessfulCalls >= minSuccessfulCalls;
    return {
      tools: requirement.tools,
      minSuccessfulCalls,
      matchedSuccessfulCalls,
      satisfied,
      diagnostics: satisfied
        ? []
        : [
            `Required structured tool evidence not satisfied for [${requirement.tools.join(", ")}]: expected at least ${minSuccessfulCalls} successful call(s), observed ${matchedSuccessfulCalls}.`,
          ],
    };
  });

  return {
    successfulCalls: [...input.successfulCounts.entries()]
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((left, right) => left.toolName.localeCompare(right.toolName)),
    failedCalls: [...input.failedCounts.entries()]
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((left, right) => left.toolName.localeCompare(right.toolName)),
    checks,
    diagnostics: input.diagnostics,
  };
}

export async function collectModelEvidence(input: {
  kestrelHomePath: string;
  provider: MountaintopScenario["provider"];
}): Promise<MountaintopEngineResult["modelEvidence"]> {
  const historyPath = path.join(input.kestrelHomePath, "history.jsonl");
  const observedProviders = new Set<string>();
  const observedModels = new Set<string>();
  const diagnostics: string[] = [];
  let raw = "";
  try {
    raw = await readFile(historyPath, "utf8");
  } catch {
    diagnostics.push(`Structured model evidence unavailable: ${historyPath} not found.`);
  }

  if (raw.length > 0) {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      collectStructuredModelEvidenceFromHistoryRecord(parsed, observedProviders, observedModels);
    }
  }

  return {
    requestedProvider: input.provider.provider,
    requestedModel: input.provider.model,
    observedProviders: [...observedProviders].sort((left, right) => left.localeCompare(right)),
    observedModels: [...observedModels].sort((left, right) => left.localeCompare(right)),
    diagnostics,
  };
}

function collectStructuredToolEvidenceFromHistoryRecord(
  record: unknown,
  successfulCounts: Map<string, number>,
  failedCounts: Map<string, number>,
): void {
  const root = asRecord(record);
  if (root === undefined) {
    return;
  }
  const data = asRecord(root.data);
  const toolEvidenceSummary = asRecord(data?.toolEvidenceSummary);
  if (toolEvidenceSummary !== undefined) {
    collectStructuredToolCountSummary(toolEvidenceSummary, successfulCounts, failedCounts);
    return;
  }
  collectRuntimeEvidenceSummaryTools(data?.runtimeEvidenceSummary, successfulCounts);
  const lastActionResult = asRecord(data?.lastActionResult);
  if (readStringValue(lastActionResult?.kind) === "tool") {
    const toolName = readStringValue(lastActionResult?.name);
    if (toolName !== undefined) {
      const output = asRecord(lastActionResult?.output);
      const status = readStringValue(output?.status);
      if (status === undefined || status === "ok" || status === "passed") {
        incrementToolCount(successfulCounts, toolName);
      } else {
        incrementToolCount(failedCounts, toolName);
      }
    }
  }

  const guardToolName = readStringValue(data?.guardToolName);
  if (guardToolName !== undefined) {
    incrementToolCount(successfulCounts, guardToolName);
  }
  const artifactRecovery = asRecord(data?.artifactRecovery);
  collectToolNamesFromArtifactIds(artifactRecovery?.artifactIds, successfulCounts);
  collectToolNamesFromArtifactIds(artifactRecovery?.digestArtifactIds, successfulCounts);

  const run = asRecord(root.run);
  const errors = Array.isArray(run?.errors) ? run.errors : [];
  for (const error of errors) {
    const details = asRecord(asRecord(error)?.details);
    const toolName = readStringValue(details?.toolName);
    if (toolName !== undefined) {
      incrementToolCount(failedCounts, toolName);
    }
  }
}

function countToolEvidenceRows(
  rows: Array<{ toolName: string; count: number }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.count <= 0) {
      continue;
    }
    counts.set(row.toolName, (counts.get(row.toolName) ?? 0) + row.count);
  }
  return counts;
}

export async function readRuntimeSessionStateForEvidence(input: {
  databaseUrl?: string | undefined;
  runtimeContext?: RuntimeRunContext | undefined;
  loadSessionState?: ((sessionId: string) => Promise<unknown | undefined>) | undefined;
}): Promise<RuntimeSessionStateEvidenceLookup> {
  const diagnostics: string[] = [];
  const sessionId = input.runtimeContext?.sessionId?.trim();
  if (input.runtimeContext === undefined) {
    return { diagnostics };
  }
  if (sessionId === undefined || sessionId.length === 0) {
    diagnostics.push("Runtime session evidence unavailable: runtime context missing session id.");
    return { diagnostics };
  }
  if (input.loadSessionState !== undefined) {
    try {
      const state = await input.loadSessionState(sessionId);
      if (state === undefined) {
        diagnostics.push(`Runtime session evidence unavailable: session '${sessionId}' not found in database.`);
        return { diagnostics };
      }
      return { state, diagnostics };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`Runtime session evidence unavailable: ${message}`);
      return { diagnostics };
    }
  }
  if (input.databaseUrl === undefined || input.databaseUrl.trim().length === 0) {
    diagnostics.push("Runtime session evidence unavailable: database URL missing.");
    return { diagnostics };
  }
  const { store, pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    const session = await store.getSession(sessionId);
    if (session?.state === undefined) {
      diagnostics.push(`Runtime session evidence unavailable: session '${sessionId}' not found in database.`);
      return { diagnostics };
    }
    return { state: session.state, diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(`Runtime session evidence unavailable: ${message}`);
    return { diagnostics };
  } finally {
    await pool.end();
  }
}

function readRuntimeEvidenceLedgerFromSessionState(sessionState: unknown) {
  const root = asRecord(sessionState);
  const rootLedger = parseEvidenceLedger(root?.evidenceLedger);
  if (rootLedger.length > 0) {
    return rootLedger;
  }
  const agent = asRecord(root?.agent);
  const react = asRecord(root?.react);
  const agentLedger = parseEvidenceLedger(agent?.evidenceLedger);
  if (agentLedger.length > 0) {
    return agentLedger;
  }
  return parseEvidenceLedger(react?.evidenceLedger);
}

function collectRuntimeEvidenceSummaryTools(
  value: unknown,
  successfulCounts: Map<string, number>,
): void {
  const summary = asRecord(value);
  for (const token of readQualityGateStringArray(summary?.supportedTokens)) {
    const trimmed = token.trim();
    if (trimmed.startsWith("tool:") === false) {
      continue;
    }
    const toolName = trimmed.slice("tool:".length).trim();
    if (toolName.length > 0) {
      incrementToolCount(successfulCounts, toolName);
    }
  }
}

export async function buildWorkspaceCommandEnv(input: {
  workspacePath: string;
  logsDir: string;
}): Promise<NodeJS.ProcessEnv> {
  const corepackHome = path.join(input.logsDir, "corepack", path.basename(input.workspacePath));
  await mkdir(corepackHome, { recursive: true });
  return {
    ...process.env,
    CI: "true",
    COREPACK_HOME: corepackHome,
    npm_config_confirmModulesPurge: "false",
  };
}

function collectStructuredToolCountSummary(
  summary: Record<string, unknown>,
  successfulCounts: Map<string, number>,
  failedCounts: Map<string, number>,
): void {
  collectStructuredToolCountList(summary.successfulCalls, successfulCounts);
  collectStructuredToolCountList(summary.failedCalls, failedCounts);
}

function collectStructuredToolCountList(
  value: unknown,
  target: Map<string, number>,
): void {
  const items = Array.isArray(value) ? value : [];
  for (const item of items) {
    const record = asRecord(item);
    const toolName = readStringValue(record?.toolName);
    const count = typeof record?.count === "number" && Number.isFinite(record.count)
      ? Math.max(0, Math.trunc(record.count))
      : 0;
    if (toolName === undefined || count <= 0) {
      continue;
    }
    target.set(toolName, (target.get(toolName) ?? 0) + count);
  }
}

function collectStructuredModelEvidenceFromHistoryRecord(
  record: unknown,
  observedProviders: Set<string>,
  observedModels: Set<string>,
): void {
  const root = asRecord(record);
  if (root === undefined) {
    return;
  }
  const data = asRecord(root.data);
  const dataModel = asRecord(data?.model);
  const rootProvider = asRecord(root.provider);
  const provider = readStringValue(rootProvider?.name) ??
    readStringValue(data?.provider) ??
    readStringValue(dataModel?.provider);
  const model = readStringValue(rootProvider?.model) ??
    readStringValue(data?.model) ??
    readStringValue(dataModel?.model);
  if (provider !== undefined) {
    observedProviders.add(provider);
  }
  if (model !== undefined) {
    observedModels.add(model);
  }
}

function collectStructuredToolEvidenceFromSessionsSnapshot(
  snapshot: unknown,
  successfulCounts: Map<string, number>,
): void {
  const root = asRecord(snapshot);
  const sessions = Array.isArray(root?.sessions) ? root.sessions : [];
  for (const session of sessions) {
    const runtimePlan = asRecord(asRecord(asRecord(session)?.state)?.runtimePlan);
    const commandNames = Array.isArray(runtimePlan?.commandNames) ? runtimePlan.commandNames : [];
    for (const commandName of commandNames) {
      const toolName = readStringValue(commandName);
      if (toolName !== undefined) {
        incrementToolCount(successfulCounts, toolName);
      }
    }
  }
}

function collectToolNamesFromArtifactIds(
  value: unknown,
  successfulCounts: Map<string, number>,
): void {
  const artifactIds = Array.isArray(value) ? value : [];
  for (const artifactId of artifactIds) {
    const artifactIdValue = readStringValue(artifactId);
    if (artifactIdValue === undefined) {
      continue;
    }
    const toolName = readToolNameFromArtifactId(artifactIdValue);
    if (toolName !== undefined) {
      incrementToolCount(successfulCounts, toolName);
    }
  }
}

function readToolNameFromArtifactId(artifactId: string): string | undefined {
  const segments = artifactId.split(":");
  if (segments.length < 4) {
    return undefined;
  }
  const markerIndex = segments.findIndex((segment) => segment === "tool-output" || segment === "tool-output-digest");
  if (markerIndex === -1) {
    return undefined;
  }
  const toolName = segments[markerIndex + 2];
  return typeof toolName === "string" && toolName.trim().length > 0 ? toolName.trim() : undefined;
}

function incrementToolCount(target: Map<string, number>, toolName: string): void {
  target.set(toolName, (target.get(toolName) ?? 0) + 1);
}

async function buildSkippedSmokeChecks(input: {
  logsDir: string;
  engine: MountaintopEngine;
  routes: MountaintopScenario["smokeRoutes"];
  reason: string;
}): Promise<MountaintopEngineResult["smokeChecks"]> {
  const outputPath = path.join(input.logsDir, `${input.engine}.smoke.server.log`);
  await writeFile(outputPath, input.reason, "utf8");
  return input.routes.map((route) => ({
    route: route.path,
    status: "infra_failed" as const,
    diagnostics: [input.reason],
  }));
}

export async function checkRequiredArtifacts(
  workspacePath: string,
  requiredArtifacts: string[],
  requiredArtifactAlternatives: Array<{ paths: string[] }>,
  requiredJsonArrayArtifacts: MountaintopJsonArrayArtifactRequirement[],
): Promise<MountaintopEngineResult["artifactChecks"]> {
  const checks: MountaintopEngineResult["artifactChecks"] = [];
  for (const relativePath of requiredArtifacts) {
    const target = path.join(workspacePath, relativePath);
    let exists = false;
    try {
      const fileStat = await stat(target);
      exists = fileStat.isFile();
    } catch {
      exists = false;
    }
    checks.push({ path: relativePath, exists });
  }
  for (const alternative of requiredArtifactAlternatives) {
    let exists = false;
    for (const candidate of alternative.paths) {
      try {
        const fileStat = await stat(path.join(workspacePath, candidate));
        if (fileStat.isFile()) {
          exists = true;
          break;
        }
      } catch {
        // Continue checking the remaining acceptable artifact paths.
      }
    }
    checks.push({
      path: alternative.paths.join(" | "),
      exists,
    });
  }
  for (const requirement of requiredJsonArrayArtifacts) {
    checks.push(await validateRequiredJsonArrayArtifact(workspacePath, requirement));
  }
  return checks;
}

async function validateRequiredJsonArrayArtifact(
  workspacePath: string,
  requirement: MountaintopJsonArrayArtifactRequirement,
): Promise<MountaintopEngineResult["artifactChecks"][number]> {
  const diagnostics: string[] = [];
  for (const relativePath of requirement.paths) {
    const target = path.join(workspacePath, relativePath);
    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch {
      diagnostics.push(`${relativePath}: file not found`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      diagnostics.push(`${relativePath}: invalid JSON`);
      continue;
    }

    const arrayValue = resolveJsonPathValue(parsed, requirement.arrayPath);
    if (Array.isArray(arrayValue) === false) {
      diagnostics.push(`${relativePath}: ${requirement.arrayPath} is not an array`);
      continue;
    }
    if (arrayValue.length < requirement.minLength) {
      diagnostics.push(
        `${relativePath}: ${requirement.arrayPath} length ${arrayValue.length} is below required minimum ${requirement.minLength}`,
      );
      continue;
    }

    const requiredFields = requirement.requiredStringFields ?? [];
    const requiredUrlFields = requirement.requiredAbsoluteUrlFields ?? [];
    const forbiddenStringLiterals = new Set(
      (requirement.forbiddenStringLiterals ?? []).map((value) => value.trim().toLowerCase()),
    );
    const missingFieldDiagnostic = arrayValue
      .slice(0, requirement.minLength)
      .flatMap((entry, index) => {
        const record = asRecord(entry);
        if (record === undefined) {
          return [`${relativePath}: ${requirement.arrayPath}[${index}] is not an object`];
        }
        const blankFieldDiagnostics = requiredFields
          .filter((field) => readStringValue(record[field]) === undefined)
          .map((field) => `${relativePath}: ${requirement.arrayPath}[${index}].${field} is missing or blank`);
        const invalidUrlDiagnostics = requiredUrlFields
          .filter((field) => readAbsoluteHttpUrl(record[field]) === undefined)
          .map((field) => `${relativePath}: ${requirement.arrayPath}[${index}].${field} is not an absolute http(s) URL`);
        const forbiddenLiteralDiagnostics =
          forbiddenStringLiterals.size === 0
            ? []
            : [...new Set([...requiredFields, ...requiredUrlFields])]
                .map((field) => ({
                  field,
                  value: readStringValue(record[field]),
                }))
                .filter(
                  ({ value }) => value !== undefined && forbiddenStringLiterals.has(value.trim().toLowerCase()),
                )
                .map(
                  ({ field, value }) =>
                    `${relativePath}: ${requirement.arrayPath}[${index}].${field} uses forbidden placeholder '${value}'`,
                );
        return [...blankFieldDiagnostics, ...invalidUrlDiagnostics, ...forbiddenLiteralDiagnostics];
      });
    if (missingFieldDiagnostic.length > 0) {
      diagnostics.push(...missingFieldDiagnostic);
      continue;
    }

    return {
      path: `${relativePath}::${requirement.arrayPath}[0..${requirement.minLength - 1}]`,
      exists: true,
    };
  }

  return {
    path: `${requirement.paths.join(" | ")}::${requirement.arrayPath}`,
    exists: false,
    diagnostics,
  };
}

function resolveJsonPathValue(input: unknown, jsonPath: string): unknown {
  const segments = jsonPath
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  let current: unknown = input;
  for (const segment of segments) {
    const record = asRecord(current);
    if (record === undefined) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/giu, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") {
      return "&";
    }
    if (normalized === "lt") {
      return "<";
    }
    if (normalized === "gt") {
      return ">";
    }
    if (normalized === "quot") {
      return '"';
    }
    if (normalized === "apos") {
      return "'";
    }
    const isHex = normalized.startsWith("#x");
    const isDecimal = normalized.startsWith("#");
    if (!isHex && !isDecimal) {
      return match;
    }
    const numeric = Number.parseInt(normalized.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    if (!Number.isFinite(numeric)) {
      return match;
    }
    return String.fromCodePoint(numeric);
  });
}

function readAbsoluteHttpUrl(input: unknown): string | undefined {
  const value = readStringValue(input);
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function deriveEngineStatus(input: {
  blockingDiagnostics: string[];
  completionDetected: boolean;
  artifactChecks: MountaintopEngineResult["artifactChecks"];
  toolEvidence: MountaintopEngineResult["toolEvidence"];
  gateResults: MountaintopEngineResult["qualityGateResults"];
  smokeChecks: MountaintopEngineResult["smokeChecks"];
}): MountaintopRunStatus {
  if (input.blockingDiagnostics.length > 0 || !input.completionDetected) {
    return "failed";
  }
  if (input.artifactChecks.some((check) => !check.exists)) {
    return "build_failed";
  }
  if (input.toolEvidence.checks.some((check) => check.satisfied === false)) {
    return "failed";
  }
  if (input.gateResults.some((gate) => gate.required && gate.status !== "passed")) {
    return "build_failed";
  }
  if (input.smokeChecks.some((check) => check.status !== "passed")) {
    return "failed";
  }
  return "passed";
}

export function deriveFailureBucket(input: {
  status: MountaintopRunStatus;
  completionDetected: boolean;
  runtimeFailureObserved?: boolean | undefined;
  artifactChecks: MountaintopEngineResult["artifactChecks"];
  toolEvidence: MountaintopEngineResult["toolEvidence"];
  gateResults: MountaintopEngineResult["qualityGateResults"];
  smokeChecks: MountaintopEngineResult["smokeChecks"];
}): {
  bucket?: MountaintopFailureBucket | undefined;
  diagnostics: string[];
} {
  if (input.status === "passed") {
    return { diagnostics: [] };
  }
  if (input.status === "infra_failed") {
    return {
      bucket: "harness",
      diagnostics: [
        "Failure bucket=harness because the benchmark infrastructure failed before a meaningful runtime result.",
      ],
    };
  }
  if (input.runtimeFailureObserved === true) {
    return {
      bucket: "agent_runtime",
      diagnostics: [
        "Failure bucket=agent_runtime because the runtime reported an explicit run failure before completion.",
      ],
    };
  }
  if (input.completionDetected === false) {
    return {
      bucket: "harness",
      diagnostics: [
        "Failure bucket=harness because runtime completion was not observed.",
      ],
    };
  }
  if (input.artifactChecks.some((check) => check.exists === false)) {
    return {
      bucket: "agent_runtime",
      diagnostics: [
        "Failure bucket=agent_runtime because the run completed without producing all required artifacts.",
      ],
    };
  }
  if (input.toolEvidence.checks.some((check) => check.satisfied === false)) {
    return {
      bucket: "agent_runtime",
      diagnostics: [
        "Failure bucket=agent_runtime because the run completed without the required tool evidence.",
      ],
    };
  }
  if (
    input.gateResults.some((gate) => gate.required && gate.status !== "passed") ||
    input.smokeChecks.some((check) => check.status !== "passed")
  ) {
    return {
      bucket: "product_output",
      diagnostics: [
        "Failure bucket=product_output because the app shape was produced but quality gates or smoke checks failed.",
      ],
    };
  }
  return {
    bucket: "agent_runtime",
    diagnostics: [
      "Failure bucket=agent_runtime because the run finalized incorrectly after a meaningful runtime completion.",
    ],
  };
}

export function buildParityChecksForMode(
  engineResults: MountaintopEngineResult[],
  engineMode: MountaintopEngineMode,
): ParityCheckResult[] {
  if (engineMode !== "both") {
    return [];
  }
  if (engineResults.length < 2) {
    return [{
      id: "parity.dual-engine-required",
      status: "failed",
      diagnostics: ["Both cli and web engine results are required."],
    }];
  }

  const cli = engineResults.find((result) => result.engine === "cli");
  const web = engineResults.find((result) => result.engine === "web");
  if (cli === undefined || web === undefined) {
    return [{
      id: "parity.dual-engine-required",
      status: "failed",
      diagnostics: ["Missing cli or web engine result."],
    }];
  }

  const checks: ParityCheckResult[] = [
    {
      id: "parity.engine-status",
      status: cli.status === "passed" && web.status === "passed" ? "passed" : "failed",
      diagnostics:
        cli.status === "passed" && web.status === "passed"
          ? []
          : [`cli=${cli.status}`, `web=${web.status}`],
    },
    {
      id: "parity.completion-contract",
      status: cli.completionDetected && web.completionDetected ? "passed" : "failed",
      diagnostics:
        cli.completionDetected && web.completionDetected
          ? []
          : ["Completion contract missing from one or more engines."],
    },
    {
      id: "parity.required-artifacts",
      status:
        cli.artifactChecks.every((item) => item.exists) &&
        web.artifactChecks.every((item) => item.exists)
          ? "passed"
          : "failed",
      diagnostics: [
        ...cli.artifactChecks.filter((item) => !item.exists).map((item) => `cli missing ${item.path}`),
        ...web.artifactChecks.filter((item) => !item.exists).map((item) => `web missing ${item.path}`),
      ],
    },
  ];
  return checks;
}

function buildParityChecks(engineResults: MountaintopEngineResult[]): ParityCheckResult[] {
  return buildParityChecksForMode(engineResults, "both");
}

export function resolveEngineOrder(engineMode: MountaintopEngineMode): MountaintopEngine[] {
  if (engineMode === "cli" || engineMode === "web") {
    return [engineMode];
  }
  return ["cli", "web"];
}

export function resolveScenarioEngineOrder(
  engineMode: MountaintopEngineMode,
  scenario: Pick<MountaintopScenario, "supportedEngines">,
): MountaintopEngine[] {
  const requested = resolveEngineOrder(engineMode);
  if (engineMode !== "both") {
    return requested;
  }
  const supported = scenario.supportedEngines;
  return supported === undefined ? requested : requested.filter((engine) => supported.includes(engine));
}

function buildReport(input: {
  scenarioId: string;
  logsDir: string;
  startedAt: Date;
  endedAt: Date;
  engines: MountaintopEngineResult[];
  parityChecks: ParityCheckResult[];
}): MountaintopReport {
  const hasFailedEngine = input.engines.some((engine) => engine.status !== "passed");
  const hasParityFailure = input.parityChecks.some((check) => check.status !== "passed");
  return {
    scenarioId: input.scenarioId,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: Math.max(0, input.endedAt.getTime() - input.startedAt.getTime()),
    status: hasFailedEngine || hasParityFailure ? "failed" : "passed",
    logsDir: input.logsDir,
    engines: input.engines,
    parityChecks: input.parityChecks,
  };
}

async function writeReport(runDir: string, report: MountaintopReport): Promise<void> {
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
}

function renderReportSummary(report: MountaintopReport): void {
  process.stdout.write(`[mountaintop] summary status=${report.status} scenario=${report.scenarioId}\n`);
  for (const engine of report.engines) {
    process.stdout.write(
      `${engine.engine.toUpperCase()} status=${engine.status} durationMs=${engine.durationMs} completion=${engine.completionDetected ? "yes" : "no"}\n`,
    );
  }
  for (const check of report.parityChecks) {
    process.stdout.write(`PARITY ${check.id} status=${check.status}${check.diagnostics.length > 0 ? ` diagnostics=${check.diagnostics.join("; ")}` : ""}\n`);
  }
  process.stdout.write(`[mountaintop] report=${path.join(report.logsDir, "report.json")}\n`);
}

async function runCommand(input: {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputPath: string;
}): Promise<CommandOutcome> {
  const started = Date.now();
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });

  const output = `${result.stdout}\n${result.stderr}`.trim();
  await writeFile(input.outputPath, output, "utf8");
  const status = classifyMountaintopStatus({
    exitCode: result.exitCode,
    output,
  });
  return {
    status,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    outputPath: input.outputPath,
    diagnostics: status === "passed" ? [] : [`Command ${input.command} ${input.args.join(" ")} failed.`],
  };
}

export function classifyMountaintopStatus(input: {
  exitCode: number;
  output: string;
}): MountaintopRunStatus {
  if (input.exitCode === 0) {
    return "passed";
  }
  const normalized = input.output.toLowerCase();
  if (
    normalized.includes("econnrefused") ||
    normalized.includes("not reachable") ||
    normalized.includes("missing openrouter_api_key") ||
    normalized.includes("missing required")
  ) {
    return "infra_failed";
  }
  if (
    normalized.includes("failed to compile") ||
    normalized.includes("type error") ||
    normalized.includes("missing script")
  ) {
    return "build_failed";
  }
  return "failed";
}

export function classifyCliAdapterFailure(output: string): string {
  const failFast = extractFailFastReason(output);
  if (failFast !== undefined) {
    return `fail_fast:${failFast}`;
  }
  if (/timed out waiting for/iu.test(output)) {
    return "marker_timeout";
  }
  if (/startup failed/iu.test(output)) {
    return "startup_failure";
  }
  return "runner_error";
}

export function buildCliAdapterFailureDiagnostics(input: {
  failureCode: string;
  timeoutPattern?: string | undefined;
  transcriptStdoutPath: string;
  transcriptStderrPath: string;
  runtimeSessionName?: string | undefined;
  runtimeSessionId?: string | undefined;
  runtimeRunId?: string | undefined;
  runtimeCleanupStatus?: RuntimeRunCleanupResult["status"] | undefined;
  runtimeCleanupReason?: string | undefined;
  transcriptTailPath?: string | undefined;
}): string[] {
  const diagnostics = [
    input.timeoutPattern === undefined
      ? `CLI adapter failed: ${input.failureCode}`
      : `CLI adapter failed: ${input.failureCode}:${input.timeoutPattern}`,
    `CLI adapter transcript stdout: ${input.transcriptStdoutPath}`,
    `CLI adapter transcript stderr: ${input.transcriptStderrPath}`,
  ];
  if (input.runtimeSessionName !== undefined) {
    diagnostics.push(`CLI adapter runtime session_name: ${input.runtimeSessionName}`);
  }
  if (input.runtimeSessionId !== undefined) {
    diagnostics.push(`CLI adapter runtime session_id: ${input.runtimeSessionId}`);
    diagnostics.push(
      `CLI adapter runtime run_id: ${input.runtimeRunId ?? "unresolved"}`,
    );
  }
  if (input.runtimeCleanupStatus !== undefined) {
    diagnostics.push(`CLI adapter runtime cleanup: ${input.runtimeCleanupStatus}`);
  }
  if (input.runtimeCleanupReason !== undefined) {
    diagnostics.push(`CLI adapter runtime cleanup reason: ${input.runtimeCleanupReason}`);
  }
  if (input.transcriptTailPath !== undefined) {
    diagnostics.push(`CLI adapter transcript tail: ${input.transcriptTailPath}`);
  }
  return diagnostics;
}

export function deriveRuntimeRunFailureDiagnostics(
  input: RuntimeRunFailureEventRow,
): string[] {
  const diagnostics: string[] = [];
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (code.length > 0) {
    diagnostics.push(`Runtime run failed code: ${code}`);
  }
  if (message.length > 0) {
    diagnostics.push(`Runtime run failed message: ${message}`);
  }
  return diagnostics;
}

export function deriveRuntimeMarkerTimeoutDiagnostics(
  input: RuntimeMarkerTimeoutEvidence,
): string[] {
  const diagnostics: string[] = [];
  const recentCommands = input.recentCommands
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
  if (recentCommands.length === 0) {
    return diagnostics;
  }

  const commandCounts = new Map<string, number>();
  for (const command of recentCommands) {
    commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1);
  }

  const repeatedCandidates = [...commandCounts.entries()]
    .filter((entry) => entry[1] > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (repeatedCandidates[0] !== undefined) {
    const [command, count] = repeatedCandidates[0];
    diagnostics.push(
      `Runtime marker-timeout replay context: repeated_command='${command}' repeat_count=${count}`,
    );
  }

  const firstFailingGateCommand = resolveFirstFailingGateCommand({
    lastCommand: input.lastCommand,
    completedExitCode: input.completedExitCode,
    recentCommands,
  });
  if (firstFailingGateCommand !== undefined) {
    diagnostics.push(
      `Runtime marker-timeout first failing gate command: ${firstFailingGateCommand}`,
    );
  }

  if (typeof input.completedExitCode === "number") {
    diagnostics.push(
      `Runtime marker-timeout settled exit code: ${input.completedExitCode}`,
    );
  }
  if (
    typeof input.remediationEvidenceToken === "string" &&
    input.remediationEvidenceToken.trim().length > 0
  ) {
    diagnostics.push(
      `Runtime marker-timeout remediation token: ${input.remediationEvidenceToken.trim()}`,
    );
  }

  return diagnostics;
}

export function deriveRuntimeProgressGapDiagnostics(input: {
  events: RuntimeRunEventRow[];
  focusStep?: string | undefined;
}): string[] {
  if (input.events.length === 0) {
    return [];
  }
  const lastEvent = input.events[0];
  if (lastEvent === undefined) {
    return [];
  }

  const focusStep = input.focusStep?.trim();
  const selectedCandidate = input.events.find((event) => {
    if (event.eventType !== "step.selected") {
      return false;
    }
    if (focusStep === undefined || focusStep.length === 0) {
      return true;
    }
    return event.stepName === focusStep;
  });
  if (selectedCandidate === undefined || selectedCandidate.stepIndex === null) {
    return [];
  }

  const startedForSelected = input.events.some(
    (event) =>
      event.eventType === "step.started" &&
      event.stepIndex === selectedCandidate.stepIndex,
  );
  if (startedForSelected) {
    return [];
  }

  const stepLabel = selectedCandidate.stepName ?? "unknown";
  const stepIndex = selectedCandidate.stepIndex;
  return [
    `Runtime progress gap: step.selected_without_step.started step='${stepLabel}' step_index=${stepIndex}`,
    `Runtime progress gap context: last_event='${lastEvent.eventType}' last_step_index=${lastEvent.stepIndex ?? "n/a"} last_step='${lastEvent.stepName ?? "n/a"}'`,
  ];
}

export function deriveRuntimeCompletionAttributionDiagnostics(
  input: RuntimeCompletionAttribution,
): string[] {
  const diagnostics: string[] = [];
  const runtimeCompletedAt = readStringValue(input.runtimeCompletedAt);
  if (runtimeCompletedAt !== undefined) {
    diagnostics.push(`Runtime completed at: ${runtimeCompletedAt}`);
  }
  if (
    typeof input.wrapperValidationDurationMs === "number" &&
    Number.isFinite(input.wrapperValidationDurationMs)
  ) {
    diagnostics.push(
      `Wrapper validation duration: ${Math.max(0, Math.trunc(input.wrapperValidationDurationMs))} ms`,
    );
  }
  diagnostics.push(
    `Post-completion runtime shell actions: ${Math.max(0, Math.trunc(input.postMarkerRuntimeShellActions))}`,
  );
  diagnostics.push(
    `Post-completion settled-terminal polling redirects: ${Math.max(
      0,
      Math.trunc(input.postMarkerSettledTerminalPollingRedirects),
    )}`,
  );
  return diagnostics;
}

async function collectRuntimeCompletionAttributionDiagnostics(input: {
  databaseUrl: string;
  runtimeContext?: RuntimeRunContext | undefined;
  completionDetected: boolean;
  scenario: MountaintopScenario;
  reportEndedAt: Date;
}): Promise<string[]> {
  if (input.completionDetected !== true) {
    return [];
  }
  const runId = input.runtimeContext?.runId?.trim();
  if (runId === undefined || runId.length === 0) {
    return [];
  }
  const attribution = await collectRuntimeCompletionAttribution({
    databaseUrl: input.databaseUrl,
    runId,
    completionMarker:
      resolveScenarioCompletionMode(input.scenario) === "marker"
        ? resolveScenarioCompletionMarker(input.scenario)
        : undefined,
    reportEndedAt: input.reportEndedAt,
  });
  if (attribution === undefined) {
    return [];
  }
  return deriveRuntimeCompletionAttributionDiagnostics(attribution);
}

async function collectRuntimeProgressGapDiagnostics(input: {
  databaseUrl: string;
  runId?: string | undefined;
  focusStep?: string | undefined;
}): Promise<string[]> {
  if (input.runId === undefined || input.runId.trim().length === 0) {
    return [];
  }
  const { pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    const result = await pool.query<{
      event_type: string;
      step_index: number | null;
      step_name: string | null;
      occurred_at: Date;
    }>(
      `SELECT event_type, step_index, metadata_json->>'step' AS step_name, occurred_at
         FROM run_events
        WHERE run_id = $1
        ORDER BY id DESC
        LIMIT 400`,
      [input.runId],
    );
    const events: RuntimeRunEventRow[] = result.rows.map((row) => ({
      eventType: row.event_type,
      stepIndex: row.step_index,
      stepName: row.step_name,
      occurredAt: row.occurred_at.toISOString(),
    }));
    return deriveRuntimeProgressGapDiagnostics({
      events,
      focusStep: input.focusStep,
    });
  } catch {
    return [];
  } finally {
    await pool.end();
  }
}

async function collectRuntimeFailureDiagnostics(input: {
  databaseUrl: string;
  runId?: string | undefined;
}): Promise<string[]> {
  if (input.runId === undefined || input.runId.trim().length === 0) {
    return [];
  }
  const { pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    const result = await pool.query<{ metadata_json: unknown }>(
      `SELECT metadata_json
         FROM run_events
        WHERE run_id = $1
          AND event_type = 'run.failed'
        ORDER BY id DESC
        LIMIT 5`,
      [input.runId],
    );
    const diagnostics: string[] = [];
    for (const row of result.rows) {
      const failure = readRuntimeRunFailureEvent(row.metadata_json);
      if (failure === undefined) {
        continue;
      }
      diagnostics.push(...deriveRuntimeRunFailureDiagnostics(failure));
    }
    return dedupeDiagnostics(diagnostics);
  } catch {
    return [];
  } finally {
    await pool.end();
  }
}

async function collectRuntimeMarkerTimeoutDiagnostics(input: {
  databaseUrl: string;
  sessionId?: string | undefined;
}): Promise<string[]> {
  const sessionId = input.sessionId?.trim();
  if (sessionId === undefined || sessionId.length === 0) {
    return [];
  }
  const { store, pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    const session = await store.getSession(sessionId);
    const state = readObjectRecord(session?.state);
    const reactState = readObjectRecord(state?.react);
    const postToolVerification = readObjectRecord(reactState?.postToolVerification);
    const devShellVerification = readObjectRecord(postToolVerification?.devShell);
    const exec = readObjectRecord(reactState?.exec);
    const execDevShell = readObjectRecord(exec?.devShell);
    const lastCommandRecord =
      readObjectRecord(devShellVerification?.lastCommand) ??
      readObjectRecord(execDevShell?.lastCommand);
    const lastCommand = readStringValue(lastCommandRecord?.command);
    const completedExitCode = readIntegerValue(devShellVerification?.completedExitCode);
    const remediationEvidenceToken = readStringValue(devShellVerification?.remediationEvidenceToken);
    const recentCommands = dedupeInOrder([
      ...readCommandList(devShellVerification?.recentCommands),
      ...readCommandList(execDevShell?.recentCommands),
      ...(lastCommand !== undefined ? [lastCommand] : []),
    ]);
    return deriveRuntimeMarkerTimeoutDiagnostics({
      ...(lastCommand !== undefined ? { lastCommand } : {}),
      ...(completedExitCode !== undefined ? { completedExitCode } : {}),
      ...(remediationEvidenceToken !== undefined ? { remediationEvidenceToken } : {}),
      recentCommands,
    });
  } catch {
    return [];
  } finally {
    await pool.end();
  }
}

async function collectRuntimeCompletionAttribution(input: {
  databaseUrl: string;
  runId: string;
  completionMarker?: string | undefined;
  reportEndedAt: Date;
}): Promise<RuntimeCompletionAttribution | undefined> {
  const { pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    const runCompletedResult = await pool.query<{ occurred_at: Date }>(
      `SELECT occurred_at
         FROM run_events
        WHERE run_id = $1
          AND event_type = 'run.completed'
        ORDER BY id DESC
        LIMIT 1`,
      [input.runId],
    );
    const runtimeCompletedAt = runCompletedResult.rows[0]?.occurred_at;
    if (runtimeCompletedAt === undefined) {
      return undefined;
    }

    const marker = input.completionMarker?.trim();
    const markerObservedAt =
      marker === undefined || marker.length === 0
        ? undefined
        : (await pool.query<{ created_at: Date }>(
            `SELECT er.created_at
               FROM effects e
               JOIN effect_results er
                 ON er.idempotency_key = e.idempotency_key
              WHERE e.run_id = $1
                AND e.payload_json->>'toolName' = 'dev.shell.run'
                AND POSITION($2 IN COALESCE(e.payload_json->'toolInput'->>'command', '')) > 0
              ORDER BY er.created_at DESC
              LIMIT 1`,
            [input.runId, marker],
          )).rows[0]?.created_at;
    const markerBoundary = markerObservedAt ?? runtimeCompletedAt;

    const postMarkerShellActionsResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM effects e
        WHERE e.run_id = $1
          AND e.payload_json->>'toolName' LIKE 'dev.shell.%'
          AND e.created_at > $2
          AND e.created_at <= $3`,
      [input.runId, markerBoundary.toISOString(), runtimeCompletedAt.toISOString()],
    );

    const postMarkerRedirectsResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM run_events
        WHERE run_id = $1
          AND event_type = 'decision.redirected'
          AND metadata_json->>'decisionCode' = 'settled_dev_shell_polling_redirect'
          AND COALESCE(metadata_json->>'commandLifecycle', '') = 'settled_terminal'
          AND occurred_at > $2
          AND occurred_at <= $3`,
      [input.runId, markerBoundary.toISOString(), runtimeCompletedAt.toISOString()],
    );

    return {
      runtimeCompletedAt: runtimeCompletedAt.toISOString(),
      ...(markerObservedAt !== undefined ? { markerObservedAt: markerObservedAt.toISOString() } : {}),
      wrapperValidationDurationMs: Math.max(0, input.reportEndedAt.getTime() - runtimeCompletedAt.getTime()),
      postMarkerRuntimeShellActions: Number.parseInt(
        postMarkerShellActionsResult.rows[0]?.count ?? "0",
        10,
      ) || 0,
      postMarkerSettledTerminalPollingRedirects: Number.parseInt(
        postMarkerRedirectsResult.rows[0]?.count ?? "0",
        10,
      ) || 0,
    };
  } catch {
    return undefined;
  } finally {
    await pool.end();
  }
}

function readRuntimeRunFailureEvent(value: unknown): RuntimeRunFailureEventRow | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const details =
    record.details !== null && typeof record.details === "object"
      ? (record.details as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function resolveFirstFailingGateCommand(input: {
  lastCommand?: string | undefined;
  completedExitCode?: number | undefined;
  recentCommands: string[];
}): string | undefined {
  const normalizedGateCommands = [
    "pnpm lint",
    "pnpm exec tsc --noemit",
    "pnpm build",
  ];
  const isGateCommand = (command: string): boolean => {
    const normalized = normalizeCommandToken(command);
    return normalizedGateCommands.some((gateCommand) => normalized.startsWith(gateCommand));
  };

  if (
    typeof input.completedExitCode === "number" &&
    input.completedExitCode !== 0 &&
    typeof input.lastCommand === "string" &&
    isGateCommand(input.lastCommand)
  ) {
    return input.lastCommand.trim();
  }

  return input.recentCommands.find((command) => isGateCommand(command));
}

function normalizeCommandToken(command: string): string {
  return command.trim().replace(/\s+/gu, " ").toLowerCase();
}

function dedupeInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
}

function readObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readIntegerValue(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return undefined;
  }
  return Math.trunc(value);
}

function readCommandList(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  const commands: string[] = [];
  for (const item of value) {
    const command = readStringValue(item);
    if (command !== undefined) {
      commands.push(command);
    }
  }
  return commands;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function dedupeDiagnostics(input: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of input) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    deduped.push(line);
  }
  return deduped;
}

async function detectRuntimeCompletionEvidence(input: {
  databaseUrl: string;
  runId?: string | undefined;
  scenario: MountaintopScenario;
}): Promise<boolean> {
  if (input.runId === undefined || input.runId.trim().length === 0) {
    return false;
  }
  if (resolveScenarioCompletionMode(input.scenario) === "runtime_finalize") {
    return detectRuntimeRunCompletedEvidence({
      databaseUrl: input.databaseUrl,
      runId: input.runId,
    });
  }
  const marker = resolveScenarioCompletionMarker(input.scenario);
  if (marker.length === 0) {
    return false;
  }
  const { pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    const result = await pool.query<{ detected: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM effects
          WHERE run_id = $1
            AND status = 'DONE'
            AND payload_json->>'toolName' = 'dev.shell.run'
            AND POSITION($2 IN COALESCE(payload_json->'toolInput'->>'command', '')) > 0
       ) AS detected`,
      [input.runId, marker],
    );
    return result.rows[0]?.detected === true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

async function detectRuntimeRunCompletedEvidence(input: {
  databaseUrl: string;
  runId: string;
}): Promise<boolean> {
  const { pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    const result = await pool.query<{ detected: boolean }>(
      `SELECT COALESCE((
         SELECT event_type = 'run.completed'
           FROM run_events
          WHERE run_id = $1
            AND event_type IN ('run.completed', 'run.waiting', 'run.failed', 'run.cancelled')
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1
       ), FALSE) AS detected`,
      [input.runId],
    );
    return result.rows[0]?.detected === true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

async function resolveRuntimeRunContextForSession(input: {
  databaseUrl: string;
  sessionId: string;
}): Promise<RuntimeRunContext> {
  const { store, pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    const running = await store.listRuns({
      sessionId: input.sessionId,
      status: "RUNNING",
      limit: 1,
    });
    if (running[0] !== undefined) {
      return {
        sessionId: input.sessionId,
        runId: running[0].runId,
      };
    }
    const latest = await store.listRuns({
      sessionId: input.sessionId,
      limit: 1,
    });
    return {
      sessionId: input.sessionId,
      ...(latest[0] !== undefined ? { runId: latest[0].runId } : {}),
    };
  } catch {
    return {
      sessionId: input.sessionId,
    };
  } finally {
    await pool.end();
  }
}

async function resolveRuntimeValidationWorkspacePath(input: {
  databaseUrl: string;
  runtimeContext: RuntimeRunContext;
  fallbackWorkspacePath: string;
  kestrelHomePath: string;
}): Promise<string> {
  const { store, pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    const session = await store.getSession(input.runtimeContext.sessionId);
    const fromSessionState = resolveManagedWorktreeValidationWorkspacePath(
      input.fallbackWorkspacePath,
      session?.state,
    );
    if (fromSessionState !== input.fallbackWorkspacePath) {
      return fromSessionState;
    }
    const fromBindingMetadata = await resolveManagedWorktreeValidationWorkspacePathFromKestrelHome({
      kestrelHomePath: input.kestrelHomePath,
      sessionId: input.runtimeContext.sessionId,
      fallbackWorkspacePath: input.fallbackWorkspacePath,
    });
    return fromBindingMetadata ?? input.fallbackWorkspacePath;
  } catch {
    return (
      await resolveManagedWorktreeValidationWorkspacePathFromKestrelHome({
        kestrelHomePath: input.kestrelHomePath,
        sessionId: input.runtimeContext.sessionId,
        fallbackWorkspacePath: input.fallbackWorkspacePath,
      })
    ) ?? input.fallbackWorkspacePath;
  } finally {
    await pool.end();
  }
}

async function resolveManagedWorktreeValidationWorkspacePathFromKestrelHome(input: {
  kestrelHomePath: string;
  sessionId: string;
  fallbackWorkspacePath: string;
}): Promise<string | undefined> {
  const worktreesRoot = path.join(input.kestrelHomePath, "worktrees");
  const repoDirs = await readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
  const sidecarPaths: string[] = [];
  for (const repoDir of repoDirs) {
    if (!repoDir.isDirectory()) {
      continue;
    }
    const repoRoot = path.join(worktreesRoot, repoDir.name);
    const entries = await readdir(repoRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".binding.json")) {
        continue;
      }
      sidecarPaths.push(path.join(repoRoot, entry.name));
    }
  }
  sidecarPaths.sort();

  let fallbackMatch: string | undefined;
  for (const sidecarPath of sidecarPaths) {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = readObjectRecord(JSON.parse(await readFile(sidecarPath, "utf8")));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      continue;
    }
    const worktreeRoot = readStringValue(parsed.worktreeRoot)?.trim();
    if (worktreeRoot === undefined || worktreeRoot.length === 0) {
      continue;
    }
    const lease = readObjectRecord(parsed.currentLease);
    const leaseSessionId = readStringValue(lease?.sessionId)?.trim();
    const createdBySessionId = readStringValue(parsed.createdBySessionId)?.trim();
    if (leaseSessionId === input.sessionId || createdBySessionId === input.sessionId) {
      return worktreeRoot;
    }
    const sourceWorkspaceRoot = readStringValue(parsed.sourceWorkspaceRoot)?.trim();
    if (sourceWorkspaceRoot === input.fallbackWorkspacePath) {
      fallbackMatch = worktreeRoot;
    }
  }
  return fallbackMatch;
}

async function closeRuntimeRunAfterCliAdapterFailure(input: {
  databaseUrl: string;
  runtimeContext: RuntimeRunContext;
  failureCode: string;
  timeoutPattern?: string | undefined;
}): Promise<RuntimeRunCleanupResult> {
  const { store, pool } = createPostgresSessionStoreFromUrl(input.databaseUrl);
  try {
    let runId = input.runtimeContext.runId;
    if (runId === undefined) {
      const running = await store.listRuns({
        sessionId: input.runtimeContext.sessionId,
        status: "RUNNING",
        limit: 1,
      });
      runId = running[0]?.runId;
    }

    if (runId === undefined) {
      return {
        status: "no_active_run",
        sessionId: input.runtimeContext.sessionId,
      };
    }

    await store.completeRun(
      runId,
      "FAILED",
      {
        code: "MOUNTAINTOP_CLI_ADAPTER_TERMINATED",
        message: `Mountaintop CLI adapter terminated before convergence (${input.failureCode}).`,
        details: {
          failureCode: input.failureCode,
          ...(input.timeoutPattern !== undefined ? { timeoutPattern: input.timeoutPattern } : {}),
          sessionId: input.runtimeContext.sessionId,
          runId,
        },
      },
    );
    return {
      status: "closed",
      sessionId: input.runtimeContext.sessionId,
      runId,
    };
  } catch (error) {
    return {
      status: "cleanup_failed",
      sessionId: input.runtimeContext.sessionId,
      ...(input.runtimeContext.runId !== undefined ? { runId: input.runtimeContext.runId } : {}),
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await pool.end();
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function terminateProcess(child: ChildProcess): void {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
}

async function runPythonDriver(scriptPath: string, payload: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.end(payload, "utf8");
  });
}

function sendPtyControlCommand(
  stdin: Writable | null,
  command: PtyControlCommand,
  options?: { end?: boolean | undefined },
): void {
  if (stdin === null || stdin.destroyed) {
    return;
  }
  const serialized = `${JSON.stringify(command)}\n`;
  if (options?.end) {
    stdin.end(serialized, "utf8");
    return;
  }
  stdin.write(serialized, "utf8");
}

async function runPythonDriverUntilScenarioCompletion(input: {
  scriptPath: string;
  payload: string;
  kestrelHomePath: string;
  sessionName: string;
  databaseUrl: string;
  scenario: MountaintopScenario;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  runtimeCompletionObserved: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [input.scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let pollInFlight = false;
    let replyInFlight = false;
    let runtimeCompletionObserved = false;
    let runtimeContext: RuntimeRunContext | undefined;
    let forcedFailure = false;
    const forcedFailureDiagnostics: string[] = [];
    const seenWaitFingerprints = new Set<string>();
    const overallTimeoutMs = input.scenario.completionTimeoutSeconds * 1000;
    let intervalId: NodeJS.Timeout | undefined;
    let timeoutId: NodeJS.Timeout | undefined;

    const finish = (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
      runtimeCompletionObserved: boolean;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      resolve(result);
    };

    const requestDriverTermination = () => {
      sendPtyControlCommand(child.stdin, { type: "terminate" }, { end: true });
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }, 300).unref();
    };

    const markHarnessFailure = (diagnostics: string[]) => {
      if (diagnostics.length > 0) {
        forcedFailureDiagnostics.push(...diagnostics);
      }
      forcedFailure = true;
      requestDriverTermination();
    };

    const pollForRuntimeProgress = async (): Promise<void> => {
      if (settled || pollInFlight || (runtimeCompletionObserved && !replyInFlight)) {
        return;
      }
      pollInFlight = true;
      try {
        const sessionSnapshot = await readPersistedSessionSnapshotFromKestrelHome({
          kestrelHomePath: input.kestrelHomePath,
          sessionName: input.sessionName,
        });
        const persistedSessionId = sessionSnapshot?.sessionId;
        if (persistedSessionId === undefined) {
          return;
        }

        if (input.scenario.simulatedUser?.mode === "explicit_waits" && replyInFlight === false) {
          const waitDecision = evaluateSimulatedUserWaitDecision({
            sessionSnapshot,
            seenWaitFingerprints,
            maxTurns: input.scenario.simulatedUser.maxTurns,
          });
          if (waitDecision.kind === "turn_cap_exhausted") {
            markHarnessFailure(waitDecision.diagnostics);
            return;
          }
          if (waitDecision.kind === "reply" && waitDecision.fingerprint !== undefined && waitDecision.prompt !== undefined) {
            replyInFlight = true;
            try {
              const reply = await generateSimulatedUserReply({
                scenario: input.scenario,
                waitPrompt: waitDecision.prompt,
                kestrelHomePath: input.kestrelHomePath,
                sessionId: persistedSessionId,
              });
              if (reply === undefined) {
                markHarnessFailure([
                  `Simulated user failed to produce a reply for explicit wait: ${waitDecision.prompt}`,
                ]);
                return;
              }
              seenWaitFingerprints.add(waitDecision.fingerprint);
              sendPtyControlCommand(child.stdin, {
                type: "send_text",
                text: `${reply}\n`,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              markHarnessFailure([
                `Simulated user reply generation failed: ${message}`,
              ]);
              return;
            } finally {
              replyInFlight = false;
            }
          }
        }

        runtimeContext = await resolveRuntimeRunContextForSession({
          databaseUrl: input.databaseUrl,
          sessionId: persistedSessionId,
        });
        if (runtimeContext.runId === undefined) {
          return;
        }
        const completed = await detectRuntimeCompletionEvidence({
          databaseUrl: input.databaseUrl,
          runId: runtimeContext.runId,
          scenario: input.scenario,
        });
        if (completed) {
          runtimeCompletionObserved = true;
          requestDriverTermination();
        }
      } catch {
        // Best-effort polling only; driver timeout remains the fallback.
      } finally {
        pollInFlight = false;
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      clearInterval(intervalId);
      reject(error);
    });
    child.on("close", (code) => {
      finish({
        stdout,
        stderr:
          forcedFailureDiagnostics.length > 0
            ? `${stderr}${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}${forcedFailureDiagnostics.join("\n")}\n`
            : stderr,
        exitCode: runtimeCompletionObserved && forcedFailure === false ? 0 : (code ?? 1),
        runtimeCompletionObserved,
      });
    });
    intervalId = setInterval(() => {
      void pollForRuntimeProgress();
    }, 500);
    timeoutId = setTimeout(() => {
      markHarnessFailure([
        `CLI adapter timed out after ${input.scenario.completionTimeoutSeconds}s without runtime completion.`,
      ]);
    }, overallTimeoutMs);
    void pollForRuntimeProgress();
    child.stdin.write(`${input.payload}\n`, "utf8");
  });
}

function resolveOpsDatabaseUrl(): string {
  return process.env.KESTREL_OPS_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? buildDefaultKestrelDatabaseUrl(process.env, "kestrel_ops_test");
}

async function isPostgresReachable(databaseUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 5432;
  if (!host || Number.isNaN(port)) {
    return false;
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function waitForPostgresReady(input: {
  databaseUrl: string;
  timeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  probe?: ((databaseUrl: string) => Promise<void>) | undefined;
  sleepFn?: ((ms: number) => Promise<void>) | undefined;
}): Promise<{
  ready: boolean;
  attempts: number;
  timeoutMs: number;
  pollIntervalMs: number;
  lastError?: string | undefined;
}> {
  const timeoutMs = input.timeoutMs ?? 45_000;
  const pollIntervalMs = input.pollIntervalMs ?? 500;
  const probe = input.probe ?? probePostgresQueryReadiness;
  const sleepFn = input.sleepFn ?? sleep;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError: string | undefined;

  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      await probe(input.databaseUrl);
      return {
        ready: true,
        attempts,
        timeoutMs,
        pollIntervalMs,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (Date.now() >= deadline) {
        break;
      }
      await sleepFn(pollIntervalMs);
    }
  }

  return {
    ready: false,
    attempts,
    timeoutMs,
    pollIntervalMs,
    lastError,
  };
}

async function probePostgresQueryReadiness(databaseUrl: string): Promise<void> {
  const { pool } = createPostgresSessionStoreFromUrl(databaseUrl);
  try {
    await pool.query("SELECT 1");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function buildPostgresReadyLog(input: {
  ready: boolean;
  attempts: number;
  timeoutMs: number;
  pollIntervalMs: number;
  lastError?: string | undefined;
}): string {
  const lines = [
    `status=${input.ready ? "ready" : "timeout"}`,
    `attempts=${input.attempts}`,
    `timeoutMs=${input.timeoutMs}`,
    `pollIntervalMs=${input.pollIntervalMs}`,
  ];
  if (input.lastError !== undefined) {
    lines.push(`lastError=${input.lastError}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function pruneMountaintopRuns(rootDir: string, keepRuns: number): Promise<void> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const withStats = await Promise.all(
    directories.map(async (name) => {
      const fullPath = path.join(rootDir, name);
      const info = await stat(fullPath).catch(() => undefined);
      return info === undefined
        ? undefined
        : { fullPath, mtimeMs: info.mtimeMs };
    }),
  );
  const sorted = withStats
    .filter((entry): entry is { fullPath: string; mtimeMs: number } => entry !== undefined)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const stale of sorted.slice(keepRuns)) {
    await rm(stale.fullPath, { recursive: true, force: true });
  }
}

function timestampKey(): string {
  const date = new Date();
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const sec = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${sec}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildDeterministicSubmitActions(
  text: string,
  options?: {
    settleAfterTypeMs?: number;
    settleAfterEnterMs?: number;
    extraEnterCount?: number;
    settleAfterExtraEnterMs?: number;
  },
): Array<{
  typeText?: string;
  key?: "enter" | "esc";
  settleMs?: number;
}> {
  const actions: Array<{
    typeText?: string;
    key?: "enter" | "esc";
    settleMs?: number;
  }> = [
    {
      typeText: text,
      settleMs: options?.settleAfterTypeMs ?? 250,
    },
    {
      key: "enter",
      settleMs: options?.settleAfterEnterMs ?? 800,
    },
  ];
  const extraEnterCount = Math.max(0, Math.trunc(options?.extraEnterCount ?? 0));
  for (let index = 0; index < extraEnterCount; index += 1) {
    actions.push({
      key: "enter",
      settleMs: options?.settleAfterExtraEnterMs ?? 250,
    });
  }
  return actions;
}

export function buildPromptSubmissionSteps(input: {
  setupCommands: string[];
  prompt: string;
}): PtyStep[] {
  return [
    {
      ...resolvePromptSubmissionReadyStep(input.setupCommands),
      send: `${input.prompt}\n`,
      actions: [
        {
          settleMs: 1000,
        },
      ],
    },
  ];
}

export function buildCliSetupCommandSteps(setupCommands: string[]): PtyStep[] {
  if (setupCommands.length === 0) {
    return [];
  }

  const steps: PtyStep[] = [];
  for (let index = 0; index < setupCommands.length; index += 1) {
    const commandText = setupCommands[index];
    if (commandText === undefined) {
      continue;
    }
    const readyGate = resolveSetupCommandReadyGateStep(setupCommands, index);
    steps.push({
      ...readyGate,
      actions: buildDeterministicSubmitActions(commandText, {
        settleAfterTypeMs: 250,
        settleAfterEnterMs: 900,
      }),
    });
  }

  return steps;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractFailFastReason(output: string): string | undefined {
  const match = output.match(/ABORT_PATTERN_MATCHED:([A-Za-z0-9_.-]+)/u);
  return match?.[1];
}

function extractTimeoutPattern(output: string): string | undefined {
  const match = output.match(/Timed out waiting for\s+([^\n]+)/iu);
  if (match === null) {
    return undefined;
  }
  return match[1]?.trim();
}

function resolveSetupCommandAckStep(commandText: string): PtyStep {
  const normalized = commandText.trim().toLowerCase();
  if (normalized === "/workspace status") {
    return {
      pattern: "Workspace: local:",
      regex: true,
      fromCursor: true,
      timeoutSeconds: DEFAULT_SETUP_COMMAND_TIMEOUT_SECONDS,
    };
  }
  if (normalized.startsWith("/profiles use ")) {
    return {
      pattern: "(?:Profile set to '.+')|(?:Profile already set to '.+')",
      regex: true,
      fromCursor: true,
      timeoutSeconds: DEFAULT_SETUP_COMMAND_TIMEOUT_SECONDS,
    };
  }
  if (normalized.startsWith("/mode ")) {
    return {
      pattern:
        "(?:Mode set to (Chat|Plan|Build)\\.)|(?:Mode already set to (Chat|Plan|Build)\\.)",
      regex: true,
      fromCursor: true,
      timeoutSeconds: DEFAULT_SETUP_COMMAND_TIMEOUT_SECONDS,
    };
  }
  if (normalized === "/code enable") {
    return {
      pattern: "(?:code-mode enabled\\.)|(?:code-mode already enabled\\.)",
      regex: true,
      fromCursor: true,
      timeoutSeconds: DEFAULT_SETUP_COMMAND_TIMEOUT_SECONDS,
    };
  }
  return {
    pattern: "·\\s+CHAT",
    regex: true,
    fromCursor: true,
    timeoutSeconds: DEFAULT_SETUP_COMMAND_TIMEOUT_SECONDS,
  };
}

function resolveSetupCommandReadyGateStep(setupCommands: string[], index: number): PtyStep {
  if (index <= 0) {
    return {
      pattern: "(?:·\\s+CHAT)|(?:Started fresh session)|(?:No workspace bound to the active session\\.)",
      regex: true,
      fromCursor: true,
      timeoutSeconds: DEFAULT_SETUP_COMMAND_TIMEOUT_SECONDS,
    };
  }
  const previousCommand = setupCommands[index - 1];
  if (previousCommand === undefined) {
    return {
      pattern: "(?:·\\s+CHAT)|(?:Started fresh session)|(?:No workspace bound to the active session\\.)",
      regex: true,
      fromCursor: true,
      timeoutSeconds: DEFAULT_SETUP_COMMAND_TIMEOUT_SECONDS,
    };
  }
  const ackPattern = resolveSetupCommandAckStep(previousCommand);
  return ackPattern;
}

function resolvePromptSubmissionReadyStep(setupCommands: string[]): PtyStep {
  if (setupCommands.length === 0) {
    return {
      pattern: "·\\s+CHAT",
      regex: true,
      fromCursor: true,
      timeoutSeconds: 120,
    };
  }
  const lastCommand = setupCommands[setupCommands.length - 1];
  if (lastCommand === undefined) {
    return {
      pattern: "·\\s+CHAT",
      regex: true,
      fromCursor: true,
      timeoutSeconds: 120,
    };
  }
  const ackPattern = resolveSetupCommandAckStep(lastCommand);
  return { ...ackPattern, timeoutSeconds: 120 };
}

function extractTranscriptTail(value: string): string | undefined {
  const normalized = value
    .replace(/\r/gu, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (normalized.length === 0) {
    return undefined;
  }
  const tailLines = normalized.slice(-60);
  return `${tailLines.join("\n")}\n`;
}

function readStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function buildProviderModelEnv(
  provider: MountaintopScenario["provider"],
): Record<string, string> {
  switch (provider.provider) {
    case "openrouter":
      return { OPENROUTER_MODEL: provider.model };
  }
}

async function writeMountaintopModelPolicy(
  kestrelHomePath: string,
  scenario: MountaintopScenario,
): Promise<void> {
  const filePath = path.join(kestrelHomePath, "model-policy.json");
  await writeFile(
    filePath,
    `${JSON.stringify({
      version: 1,
      provider: scenario.provider.provider,
      model: scenario.provider.model,
      modelByStage: {},
      modelCapabilities: { visionInputEnabled: false },
    })}\n`,
    "utf8",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectEntry()) {
  void main().catch((error) => {
    process.stderr.write(`[mountaintop] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
