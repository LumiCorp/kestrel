import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTerminalBenchCommands,
  parseTerminalBenchArgs,
  readTerminalBenchOutcome,
  runTerminalBench,
} from "./terminal-bench.js";
import {
  assertSweVerifiedJobInputContract,
  buildSweVerifiedJobInput,
  parseSweVerifiedBenchArgs,
  resolveSweVerifiedModelSelection,
  sanitizeSweVerifiedInstance,
  validatePredictionFile,
} from "./swe-verified-bench.js";
import { loadBenchmarkDotEnv } from "./benchmark-provider-config.js";

interface SmokeCheck {
  name: string;
  passed: boolean;
  message: string;
}

interface BenchmarkSmokeOptions {
  livePreflight: boolean;
}

export async function runBenchmarkSmoke(argv: string[]): Promise<number> {
  const options = parseBenchmarkSmokeArgs(argv);
  const checks: SmokeCheck[] = [];

  checks.push(checkTerminalBenchCommandConstruction());
  checks.push(await checkTerminalBenchArtifactParsing());
  checks.push(checkSweJobInputContract());
  checks.push(await checkSwePredictionValidation());
  checks.push(checkSweOpenRouterModelContract());

  if (options.livePreflight) {
    checks.push(await runLivePreflight());
  }

  for (const check of checks) {
    process.stdout.write(`${check.passed ? "ok  " : "fail"} ${check.name} :: ${check.message}\n`);
  }
  const failed = checks.filter((check) => check.passed === false);
  if (failed.length > 0) {
    process.stderr.write(`[bench:smoke] failed ${failed.length}/${checks.length} checks\n`);
    return 1;
  }
  process.stdout.write(`[bench:smoke] passed ${checks.length} checks\n`);
  return 0;
}

export function parseBenchmarkSmokeArgs(argv: string[]): BenchmarkSmokeOptions {
  let livePreflight = false;
  for (const arg of argv) {
    if (arg === "--live-preflight") {
      livePreflight = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: pnpm run bench:smoke -- [--live-preflight]\n");
      continue;
    }
    if (arg === "--") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { livePreflight };
}

function checkTerminalBenchCommandConstruction(): SmokeCheck {
  const options = parseTerminalBenchArgs(["run", "--adapter", "kestrel", "--task-id", "hello-world"]);
  const commands = buildTerminalBenchCommands(options);
  const passed =
    commands.length === 1 &&
    commands[0]?.adapter === "kestrel" &&
    commands[0]?.args.includes("benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent") === true &&
    commands.every((command) => command.args.includes("hello-world"));
  return {
    name: "terminal-bench-command-construction",
    passed,
    message: passed ? "canonical Kestrel adapter targets hello-world" : "unexpected Terminal-Bench command shape",
  };
}

async function checkTerminalBenchArtifactParsing(): Promise<SmokeCheck> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-bench-smoke-tb-"));
  try {
    const runDir = path.join(tempDir, "runs", "kestrel-terminal-bench-smoke");
    const agentLogDir = path.join(runDir, "agent-logs");
    await mkdir(agentLogDir, { recursive: true });
    await writeFile(
      path.join(runDir, "results.json"),
      `${JSON.stringify({
        n_resolved: 1,
        n_unresolved: 0,
        accuracy: 1,
        unresolved_ids: [],
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(agentLogDir, "kestrel-terminal-bench-hello-world.json"),
      `${JSON.stringify({
        status: "failed",
        failure_kind: "kestrel_run_failed",
        task_id: "hello-world",
        notes: "adapter failed after artifact resolved",
      })}\n`,
      "utf8",
    );
    const outcome = readTerminalBenchOutcome(path.join(runDir, "results.json"), runDir, "kestrel");
    const passed =
      outcome?.nResolved === 1 &&
      outcome.nUnresolved === 0 &&
      outcome.artifactPassedButAgentFailed === true &&
      outcome.adapterFailures[0]?.failureKind === "kestrel_run_failed";
    return {
      name: "terminal-bench-artifact-parser",
      passed,
      message: passed ? "detects adapter failure despite resolved artifact" : "failed to detect adapter failure",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function checkSweJobInputContract(): SmokeCheck {
  const sanitized = sanitizeSweVerifiedInstance({
    instance_id: "astropy__astropy-12907",
    repo: "astropy/astropy",
    base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
    problem_statement: "Fix separability.",
    hints_text: "Nearby tests are useful.",
    patch: "diff --git oracle",
    test_patch: "diff --git tests",
    FAIL_TO_PASS: ["test_new"],
    PASS_TO_PASS: ["test_old"],
  });
  const jobInput = buildSweVerifiedJobInput({
    instance: sanitized,
    dataset: "custom/SWE-bench_Verified",
    workspaceRoot: "/testbed",
    modelName: "kestrel-smoke",
  });
  assertSweVerifiedJobInputContract(jobInput);
  const serialized = JSON.stringify(jobInput);
  const turn = asRecord(jobInput.turn);
  const metadata = asRecord(turn?.metadata);
  const benchmark = asRecord(metadata?.benchmark);
  const context = asRecord(benchmark?.context);
  const passed =
    serialized.includes("Fix separability.") &&
    context?.source === "swe-verified" &&
    context?.problemStatement === "Fix separability." &&
    context?.hintsText === "Nearby tests are useful." &&
    context?.workspaceRoot === "/testbed" &&
    serialized.includes("Treat issue hints and proposed causes as hypotheses") === false &&
    serialized.includes("preserve the observed emitted semantics") === false &&
    serialized.includes("Validate the exact emitted value or behavior at risk") === false &&
    serialized.includes("FAIL_TO_PASS") === false &&
    serialized.includes("oracle") === false;
  return {
    name: "swe-job-input-contract",
    passed,
    message: passed ? "oracle fields stripped and build contract valid" : "SWE job input leaked oracle fields or invalid contract",
  };
}

async function checkSwePredictionValidation(): Promise<SmokeCheck> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-bench-smoke-swe-"));
  try {
    const predictionsPath = path.join(tempDir, "predictions.jsonl");
    await writeFile(
      predictionsPath,
      `${JSON.stringify({
        instance_id: "astropy__astropy-12907",
        model_name_or_path: "kestrel-smoke",
        model_patch: "diff --git a/file.py b/file.py\n",
      })}\n`,
      "utf8",
    );
    validatePredictionFile({
      predictionsPath,
      instanceId: "astropy__astropy-12907",
    });
    let rejectedEmptyPatch = false;
    const emptyPatchPath = path.join(tempDir, "empty.jsonl");
    await writeFile(
      emptyPatchPath,
      `${JSON.stringify({
        instance_id: "astropy__astropy-12907",
        model_name_or_path: "kestrel-smoke",
        model_patch: "",
      })}\n`,
      "utf8",
    );
    try {
      validatePredictionFile({
        predictionsPath: emptyPatchPath,
        instanceId: "astropy__astropy-12907",
      });
    } catch {
      rejectedEmptyPatch = true;
    }
    return {
      name: "swe-prediction-validation",
      passed: rejectedEmptyPatch,
      message: rejectedEmptyPatch ? "accepts patch predictions and rejects empty patches" : "empty patch was accepted",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function checkSweOpenRouterModelContract(): SmokeCheck {
  let deprecatedRejected = false;
  try {
    resolveSweVerifiedModelSelection({
      OPENROUTER_API_KEY: "sk-test",
      KESTREL_SWE_MODEL_NAME: "model-a",
      OPENROUTER_MODEL: "model-b",
    });
  } catch {
    deprecatedRejected = true;
  }
  const resolved = resolveSweVerifiedModelSelection({
    OPENROUTER_API_KEY: "sk-test",
    OPENROUTER_MODEL: "model-b",
  });
  const parsed = parseSweVerifiedBenchArgs(["--instance-id", "astropy__astropy-12907", "--dry-run"]);
  const passed = deprecatedRejected && resolved.runtimeModelName === "model-b" && parsed.dryRun === true;
  return {
    name: "swe-model-env-contract",
    passed,
    message: passed ? "OpenRouter model env is canonical and deprecated aliases are rejected" : "SWE model env contract failed",
  };
}

async function runLivePreflight(): Promise<SmokeCheck> {
  let output = "";
  const code = await runTerminalBench(["preflight", "--dry-run"], {
    spawn: spawnSync,
    env: process.env,
    cwd: process.cwd(),
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
    stderr: { write: (chunk: string) => { output += chunk; return true; } },
  });
  return {
    name: "live-preflight-dry-run",
    passed: code === 0 && output.includes("[bench:terminal]"),
    message: code === 0 ? "Terminal-Bench dry-run preflight command is renderable" : "Terminal-Bench dry-run preflight failed",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadBenchmarkDotEnv(process.cwd(), process.env);
  void runBenchmarkSmoke(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`bench:smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
