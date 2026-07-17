import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";
import { buildDefaultKestrelDatabaseUrl } from "../src/config/localDev.js";

type Phase =
  | "core"
  | "sdk"
  | "cli"
  | "tui"
  | "web"
  | "governance"
  | "prompts"
  | "evals"
  | "typecheck";

interface ScenarioStep {
  id: string;
  phase: Phase;
  title: string;
  command: string;
  args: string[];
  requiresDatabase?: boolean | undefined;
  requiresExternalProviders?: boolean | undefined;
}

export type LiveStepStatus = "passed" | "failed" | "infra_failed" | "build_failed";

interface StepResult {
  id: string;
  phase: Phase;
  title: string;
  command: string;
  durationMs: number;
  exitCode: number;
  status: LiveStepStatus;
  outputPath: string;
  diagnostics: string[];
}

const ALL_PHASES: Phase[] = [
  "core",
  "sdk",
  "cli",
  "tui",
  "web",
  "governance",
  "prompts",
  "evals",
  "typecheck",
];

const LIVE_PRODUCT_PREFER_DOT_ENV_KEYS = [
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_NAME",
  "TAVILY_API_KEY",
  "TAVILY_BASE_URL",
  "TAVILY_PROJECT",
  "TAVILY_HTTP_PROXY",
  "TAVILY_HTTPS_PROXY",
] as const;

const DEFAULT_STEPS: ScenarioStep[] = [
  {
    id: "core.operator-journey",
    phase: "core",
    title: "Core operator shell deterministic journey",
    command: "node",
    args: ["--import", "tsx", "--test", "tests/e2e/operator-product-flow.test.ts"],
  },
  {
    id: "sdk.ecosystem",
    phase: "sdk",
    title: "SDK ecosystem e2e contract",
    command: "node",
    args: [
      "--import",
      "tsx",
      "--test",
      "tests/e2e/sdk-ecosystem/ecosystem.test.ts",
      "tests/e2e/sdk-ecosystem/realtime-faults.test.ts",
    ],
  },
  {
    id: "ops.cli",
    phase: "cli",
    title: "Ops CLI live surface",
    command: "pnpm",
    args: ["run", "test:ops:cli"],
    requiresDatabase: true,
  },
  {
    id: "ops.tui",
    phase: "tui",
    title: "Ops TUI live surface",
    command: "pnpm",
    args: ["run", "test:ops:tui"],
    requiresDatabase: true,
  },
  {
    id: "ops.web",
    phase: "web",
    title: "Ops web live surface",
    command: "pnpm",
    args: ["run", "test:ops:web"],
    requiresDatabase: true,
  },
  {
    id: "gate.governance",
    phase: "governance",
    title: "Governance gate",
    command: "pnpm",
    args: ["run", "governance:check"],
  },
  {
    id: "gate.prompt-suite",
    phase: "prompts",
    title: "Prompt suite gate",
    command: "pnpm",
    args: ["run", "prompt-suite"],
    requiresExternalProviders: true,
  },
  {
    id: "gate.evals",
    phase: "evals",
    title: "Released Ruhroh evaluation gate",
    command: "pnpm",
    args: ["run", "evals:release-check"],
  },
  {
    id: "gate.typecheck",
    phase: "typecheck",
    title: "Typecheck gate",
    command: "pnpm",
    args: ["run", "typecheck"],
  },
];

async function main(): Promise<void> {
  await bootstrapLiveProductEnv(process.cwd());
  const args = process.argv.slice(2);
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  if (normalizedArgs.includes("--help")) {
    printUsage();
    return;
  }

  const phaseFilter = readPhasesArg(normalizedArgs);
  const autoDb = normalizedArgs.includes("--auto-db");
  const continueOnFailure = normalizedArgs.includes("--continue-on-failure");
  const skipGates = normalizedArgs.includes("--skip-gates");

  const selectedSteps = DEFAULT_STEPS.filter((step) => {
    if (skipGates && (step.phase === "governance" || step.phase === "prompts" || step.phase === "evals" || step.phase === "typecheck")) {
      return false;
    }
    return phaseFilter === undefined ? true : phaseFilter.has(step.phase);
  });
  if (selectedSteps.length === 0) {
    throw new Error("No live-product-e2e steps selected. Use --phase with valid values.");
  }

  const logDir = path.join(process.cwd(), "tmp", "live-product-e2e", timestampKey());
  await mkdir(logDir, { recursive: true });
  process.stdout.write(`[live-product-e2e] logs: ${logDir}\n`);

  const results: StepResult[] = [];
  const requiresDatabase = selectedSteps.some((step) => step.requiresDatabase);
  if (requiresDatabase) {
    const databaseUrl = resolveOpsDatabaseUrl();
    const databaseReady = await isPostgresReachable(databaseUrl);
    if (!databaseReady) {
      if (autoDb) {
        process.stdout.write("[live-product-e2e] postgres not reachable; starting docker postgres via `pnpm run db:up`.\n");
        const dbUpResult = await runStep({
          id: "infra.db-up",
          phase: "core",
          title: "Start postgres container",
          command: "pnpm",
          args: ["run", "db:up"],
        }, logDir);
        results.push(dbUpResult);
        if (dbUpResult.status !== "passed") {
          renderSummary(results, logDir);
          await writeJsonReport(logDir, results);
          process.exitCode = 1;
          return;
        }
      } else {
        results.push(buildSyntheticFailure({
          id: "infra.database",
          phase: "core",
          title: "Database preflight",
          command: "postgres connectivity check",
          status: "infra_failed",
          diagnostics: [`Postgres is not reachable at ${databaseUrl}. Start it first (pnpm run db:up) or rerun with --auto-db.`],
        }));
        renderSummary(results, logDir);
        await writeJsonReport(logDir, results);
        process.exitCode = 1;
        return;
      }
    }
  }

  const requiresExternalProviders = selectedSteps.some((step) => step.requiresExternalProviders);
  if (requiresExternalProviders) {
    const providerErrors = validateExternalProviderEnv(process.env);
    if (providerErrors.length > 0) {
      results.push(buildSyntheticFailure({
        id: "infra.external-providers",
        phase: "core",
        title: "External provider preflight",
        command: "env check",
        status: "infra_failed",
        diagnostics: providerErrors,
      }));
      renderSummary(results, logDir);
      await writeJsonReport(logDir, results);
      process.exitCode = 1;
      return;
    }
  }

  let failed = false;
  for (const step of selectedSteps) {
    const result = await runStep(step, logDir);
    results.push(result);
    if (result.status !== "passed") {
      failed = true;
      if (!continueOnFailure) {
        break;
      }
    }
  }

  const goldenResult = buildGoldenJourneyResult(results);
  if (goldenResult !== undefined) {
    results.push(goldenResult);
    if (goldenResult.status !== "passed") {
      failed = true;
    }
  }

  renderSummary(results, logDir);
  await writeJsonReport(logDir, results);
  if (failed) {
    process.exitCode = 1;
  }
}

export async function bootstrapLiveProductEnv(cwd = process.cwd()): Promise<void> {
  await loadShellAndDotEnv(cwd, {
    preferDotEnvKeys: [...LIVE_PRODUCT_PREFER_DOT_ENV_KEYS],
  });
}

function buildGoldenJourneyResult(results: StepResult[]): StepResult | undefined {
  const requiredIds = [
    "core.operator-journey",
    "ops.cli",
    "ops.tui",
    "ops.web",
  ];
  const present = requiredIds.filter((id) => results.some((result) => result.id === id));
  if (present.length !== requiredIds.length) {
    return ;
  }
  const missingPass = results.filter((result) => requiredIds.includes(result.id) && result.status !== "passed");
  if (missingPass.length > 0) {
    return {
      id: "golden.live-journey",
      phase: "core",
      title: "Golden live journey gate",
      command: "aggregate",
      durationMs: 0,
      exitCode: 1,
      status: "failed",
      outputPath: "",
      diagnostics: missingPass.map((result) => `${result.id}:${result.status}`),
    };
  }
  return {
    id: "golden.live-journey",
    phase: "core",
    title: "Golden live journey gate",
    command: "aggregate",
    durationMs: 0,
    exitCode: 0,
    status: "passed",
    outputPath: "",
    diagnostics: [],
  };
}

export function validateExternalProviderEnv(env: NodeJS.ProcessEnv): string[] {
  const required = ["OPENROUTER_API_KEY", "TAVILY_API_KEY"];
  const missing = required.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length === 0) {
    return [];
  }
  return [`Missing required external provider credentials: ${missing.join(", ")}`];
}

function buildSyntheticFailure(input: {
  id: string;
  phase: Phase;
  title: string;
  command: string;
  status: Exclude<LiveStepStatus, "passed">;
  diagnostics: string[];
}): StepResult {
  return {
    id: input.id,
    phase: input.phase,
    title: input.title,
    command: input.command,
    durationMs: 0,
    exitCode: 1,
    status: input.status,
    outputPath: "",
    diagnostics: input.diagnostics,
  };
}

async function writeJsonReport(logDir: string, results: StepResult[]): Promise<void> {
  const durationMs = results.reduce((sum, item) => sum + item.durationMs, 0);
  const totals = {
    passed: results.filter((item) => item.status === "passed").length,
    failed: results.filter((item) => item.status === "failed").length,
    infraFailed: results.filter((item) => item.status === "infra_failed").length,
    buildFailed: results.filter((item) => item.status === "build_failed").length,
  };
  await writeFile(path.join(logDir, "report.json"), JSON.stringify({
    startedAt: new Date().toISOString(),
    host: os.hostname(),
    durationMs,
    totals,
    results,
  }, null, 2), "utf8");
}

export function classifyStepStatus(step: ScenarioStep, exitCode: number, stdout: string, stderr: string): {
  status: LiveStepStatus;
  diagnostics: string[];
} {
  if (exitCode === 0) {
    return {
      status: "passed",
      diagnostics: [],
    };
  }
  const merged = `${stdout}\n${stderr}`;
  if (/ECONNREFUSED|database preflight|Postgres is not reachable/iu.test(merged)) {
    return {
      status: "infra_failed",
      diagnostics: ["database connectivity failure"],
    };
  }
  if (/Missing required external provider credentials/iu.test(merged)) {
    return {
      status: "infra_failed",
      diagnostics: ["external provider credentials missing"],
    };
  }
  if (/Failed to compile|Type error|Process from config\.webServer was not able to start|Next\.js build worker exited/iu.test(merged)) {
    return {
      status: "build_failed",
      diagnostics: ["web build/start failure"],
    };
  }
  if (/research_stalled_partial/iu.test(merged)) {
    return {
      status: "failed",
      diagnostics: ["runtime research stall convergence"],
    };
  }
  return {
    status: "failed",
    diagnostics: [`command exited non-zero (${step.command})`],
  };
}

function readPhasesArg(args: string[]): Set<Phase> | undefined {
  const phaseArg = readArgValue(args, "--phase");
  if (phaseArg === undefined || phaseArg.trim().length === 0) {
    return ;
  }
  const values = phaseArg.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  const unknown = values.filter((value) => !ALL_PHASES.includes(value as Phase));
  if (unknown.length > 0) {
    throw new Error(`Unknown phases: ${unknown.join(", ")}. Valid phases: ${ALL_PHASES.join(", ")}`);
  }
  return new Set(values as Phase[]);
}

function resolveOpsDatabaseUrl(): string {
  return process.env.KESTREL_OPS_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? buildDefaultKestrelDatabaseUrl(process.env, "kestrel_ops_test");
}

async function isPostgresReachable(databaseUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  const host = url.hostname;
  const port = Number(url.port || 5432);
  if (!host || Number.isNaN(port)) {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1200);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function runStep(step: ScenarioStep, logDir: string | undefined): Promise<StepResult> {
  const displayCommand = `${step.command} ${step.args.join(" ")}`;
  process.stdout.write(`\n[live-product-e2e] ▶ ${step.id} (${step.phase})\n`);
  process.stdout.write(`[live-product-e2e]    ${displayCommand}\n`);

  const started = Date.now();
  const child = spawn(step.command, step.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(text);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const durationMs = Date.now() - started;
  const classified = classifyStepStatus(step, exitCode, stdout, stderr);

  const outputPath = logDir === undefined
    ? ""
    : path.join(logDir, `${step.id.replaceAll(/[^\w.-]/g, "_")}.log`);
  if (outputPath.length > 0) {
    const body = [
      `id=${step.id}`,
      `phase=${step.phase}`,
      `title=${step.title}`,
      `command=${displayCommand}`,
      `exitCode=${exitCode}`,
      `status=${classified.status}`,
      `durationMs=${durationMs}`,
      `diagnostics=${classified.diagnostics.join(" | ")}`,
      "",
      "----- STDOUT -----",
      stdout,
      "",
      "----- STDERR -----",
      stderr,
      "",
    ].join("\n");
    await writeFile(outputPath, body, "utf8");
  }

  process.stdout.write(
    `[live-product-e2e] ${classified.status === "passed" ? "✓" : "✗"} ${step.id} status=${classified.status} exit=${exitCode} durationMs=${durationMs}\n`,
  );
  return {
    id: step.id,
    phase: step.phase,
    title: step.title,
    command: displayCommand,
    durationMs,
    exitCode,
    status: classified.status,
    outputPath,
    diagnostics: classified.diagnostics,
  };
}

function renderSummary(results: StepResult[], logDir: string): void {
  const passed = results.filter((item) => item.status === "passed").length;
  const failed = results.filter((item) => item.status === "failed").length;
  const infraFailed = results.filter((item) => item.status === "infra_failed").length;
  const buildFailed = results.filter((item) => item.status === "build_failed").length;
  const durationMs = results.reduce((sum, item) => sum + item.durationMs, 0);
  process.stdout.write("\n[live-product-e2e] summary\n");
  for (const result of results) {
    process.stdout.write(
      `${result.status.toUpperCase()} ${result.id} phase=${result.phase} durationMs=${result.durationMs}${
        result.outputPath ? ` log=${result.outputPath}` : ""
      }${result.diagnostics.length > 0 ? ` diagnostics=${result.diagnostics.join("|")}` : ""}\n`,
    );
  }
  process.stdout.write(
    `[live-product-e2e] totals pass=${passed} failed=${failed} infra_failed=${infraFailed} build_failed=${buildFailed} durationMs=${durationMs} host=${os.hostname()} report=${path.join(logDir, "report.json")}\n`,
  );
}

function readArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return ;
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) {
    return ;
  }
  return next;
}

function timestampKey(date = new Date()): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: node --import tsx scripts/live-product-e2e.ts [options]",
      "",
      "Options:",
      "  --phase <csv>           Run only selected phases.",
      `                          Valid: ${ALL_PHASES.join(", ")}`,
      "  --auto-db               Start postgres with `pnpm run db:up` when required and unavailable.",
      "  --continue-on-failure   Keep running later phases after a failed step.",
      "  --skip-gates            Skip governance/prompt-suite/evals/typecheck gate phases.",
      "  --help                  Show this help message.",
      "",
      "Examples:",
      "  node --import tsx scripts/live-product-e2e.ts --phase core,sdk",
      "  node --import tsx scripts/live-product-e2e.ts --auto-db",
      "  pnpm run live:test:product -- --continue-on-failure",
    ].join("\n"),
  );
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
    process.stderr.write(`[live-product-e2e] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
