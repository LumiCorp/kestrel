import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBenchmarkTurnMode,
  benchmarkGuardrails,
  benchmarkProfileMode,
  benchmarkTurnMode,
  benchmarkProviderEnv,
  benchmarkProviderIssues,
  benchmarkProviderWarnings,
  loadBenchmarkDotEnv,
  resolveBenchmarkProviderConfig,
} from "./benchmark-provider-config.js";
import type {
  SweWorkspaceBaselineReport,
  SweWorkspacePatchReport,
} from "./swe-verified-workspace-patch.js";

type CommandMode = "preflight" | "run" | "evaluate" | "list";

export interface SweVerifiedBenchOptions {
  mode: CommandMode;
  dataset: string;
  split: string;
  instanceId?: string | undefined;
  runId?: string | undefined;
  instancesJsonl?: string | undefined;
  predictionsPath?: string | undefined;
  pythonBin?: string | undefined;
  outputRoot: string;
  dryRun: boolean;
  maxWorkers: number;
  timeout: number;
}

export interface SweVerifiedInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string | undefined;
}

interface SweVerifiedLatestAttemptMetadata {
  attempt_id: string;
  attempt_dir: string;
  predictions_path: string;
  job_input_path: string;
  job_output_path: string;
  kestrel_output_path: string;
  terminal_status?: string | undefined;
  model_patch_exists?: boolean | undefined;
  model_patch_bytes?: number | undefined;
  evaluator_ran?: boolean | undefined;
  evaluator_status?: number | undefined;
  evaluator_resolved_instances?: number | undefined;
  evaluator_unresolved_instances?: number | undefined;
  evaluator_report_path?: string | undefined;
  kestrel_job_status?: string | undefined;
  kestrel_wait_event_type?: string | undefined;
  kestrel_wait_reason?: string | undefined;
  kestrel_process_exit_code?: number | undefined;
  workspace_patch_status?: string | undefined;
  workspace_patch_report_path?: string | undefined;
  workspace_patch_sha256?: string | undefined;
  workspace_patch_changed_paths?: number | undefined;
  workspace_patch_excluded_transient_paths?: number | undefined;
  workspace_baseline_report_path?: string | undefined;
  workspace_baseline_commit?: string | undefined;
  workspace_baseline_tree_sha?: string | undefined;
  updated_at: string;
}

interface SweVerifiedEvaluationReport {
  status: number;
  resolved_instances?: number | undefined;
  unresolved_instances?: number | undefined;
  resolved_ids?: string[] | undefined;
  unresolved_ids?: string[] | undefined;
}

interface SweVerifiedEvaluationResult {
  status: number;
  outputPath: string;
  reportPath: string;
  report: SweVerifiedEvaluationReport;
}

interface KestrelJobStatusSummary {
  terminalEventType?: string | undefined;
  status?: string | undefined;
  waitEventType?: string | undefined;
  waitReason?: string | undefined;
}

interface RuntimeDeps {
  spawn: typeof spawnSync;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  now?: () => Date;
}

interface SweVerifiedImageInfo {
  instanceImageKey: string;
  platform: string;
}

const DEFAULT_DATASET = "princeton-nlp/SWE-bench_Verified";
const DEFAULT_SPLIT = "test";
const DEFAULT_OUTPUT_ROOT = "runs/swe-verified";
const DEFAULT_TIMEOUT_SEC = 1800;
const DEFAULT_MAX_WORKERS = 1;
const SWE_VERIFIED_CONTAINER_WORKSPACE_ROOT = "/testbed";
const SWE_VERIFIED_CONTAINER_ATTEMPT_DIR = "/kestrel-attempt";
const SWE_VERIFIED_CONTAINER_BASELINE_REPO = "/kestrel-baseline";
const SWE_VERIFIED_CONTAINER_DEV_SHELL_DIR = "/tmp/kestrel-dev-shell";
const SWE_VERIFIED_RUNNER_SOURCE_DIR_NAME = "kestrel-src";
const SWE_VERIFIED_RUNNER_IMAGE_DIR_NAME = "runner-image";
const SWE_VERIFIED_MODEL_PATCH_FILE = "model.patch";
const SWE_VERIFIED_PATCH_REPORT_FILE = "workspace-patch-report.json";
const SWE_VERIFIED_BASELINE_REPORT_FILE = "workspace-baseline-report.json";
const SWE_VERIFIED_BASELINE_OUTPUT_FILE = "workspace-baseline-output.txt";
const ORACLE_FIELDS = new Set(["patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS"]);
const SWE_VERIFIED_REQUIRED_PROFILE_TOOLS = [
  "FinalizeAnswer",
  "fs.read_text",
  "repo.trace",
  "fs.write_text",
  "fs.replace_text",
  "exec_command",
];

export function parseSweVerifiedBenchArgs(argv: string[]): SweVerifiedBenchOptions {
  let mode: CommandMode = "run";
  let dataset = DEFAULT_DATASET;
  let split = DEFAULT_SPLIT;
  let instanceId: string | undefined;
  let runId: string | undefined;
  let instancesJsonl: string | undefined;
  let predictionsPath: string | undefined;
  let pythonBin: string | undefined;
  let outputRoot = DEFAULT_OUTPUT_ROOT;
  let dryRun = false;
  let maxWorkers = DEFAULT_MAX_WORKERS;
  let timeout = DEFAULT_TIMEOUT_SEC;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "preflight" || arg === "run" || arg === "evaluate" || arg === "list") {
      mode = arg;
      continue;
    }

    if (arg === "--dataset") {
      dataset = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--split") {
      split = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--instance-id") {
      instanceId = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--run-id") {
      runId = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--instances-jsonl") {
      instancesJsonl = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--predictions-path") {
      predictionsPath = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--python-bin") {
      pythonBin = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--output-root") {
      outputRoot = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--max-workers") {
      maxWorkers = readPositiveInteger(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === "--timeout") {
      timeout = readPositiveInteger(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (mode !== "preflight" && instanceId === undefined) {
    throw new Error("--instance-id is required for SWE Verified run and evaluate modes");
  }

  if (instanceId !== undefined) {
    assertSafeInstanceId(instanceId);
  }

  if (runId !== undefined) {
    assertSafeRunId(runId);
  }

  return {
    mode,
    dataset,
    split,
    instanceId,
    runId,
    instancesJsonl,
    predictionsPath,
    pythonBin,
    outputRoot,
    dryRun,
    maxWorkers,
    timeout,
  };
}

export function formatSweVerifiedAttemptId(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}${milliseconds}Z`;
}

export function buildSweVerifiedAttemptPaths(input: {
  cwd: string;
  outputRoot: string;
  instanceId: string;
  attemptId: string;
}): {
  instanceKey: string;
  instanceRoot: string;
  attemptsRoot: string;
  attemptDir: string;
} {
  const instanceKey = `kestrel-swe-${input.instanceId}`;
  const resolvedOutputRoot = path.isAbsolute(input.outputRoot)
    ? input.outputRoot
    : path.join(input.cwd, input.outputRoot);
  const instanceRoot = path.join(resolvedOutputRoot, instanceKey);
  const attemptsRoot = path.join(instanceRoot, "attempts");
  return {
    instanceKey,
    instanceRoot,
    attemptsRoot,
    attemptDir: path.join(attemptsRoot, input.attemptId),
  };
}

export function sanitizeSweVerifiedInstance(row: Record<string, unknown>): SweVerifiedInstance {
  const instance = {
    instance_id: readRequiredString(row, "instance_id"),
    repo: readRequiredString(row, "repo"),
    base_commit: readRequiredString(row, "base_commit"),
    problem_statement: readRequiredString(row, "problem_statement"),
    ...(typeof row.hints_text === "string" && row.hints_text.trim().length > 0
      ? { hints_text: row.hints_text }
      : {}),
  };
  assertSafeInstanceId(instance.instance_id);
  assertSafeRepo(instance.repo);
  return instance;
}

export function sanitizeSweVerifiedIssueText(input: string, options?: {
  stripLongPytestTraces?: boolean | undefined;
}): string {
  let text = input
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^### System Details\b[\s\S]*?(?=^### |\s*$)/gmu, "");
  if (options?.stripLongPytestTraces === true) {
    text = stripLongPytestTraceBlocks(text);
  }
  return normalizeMarkdownWhitespace(text);
}

export function buildSweVerifiedJobInput(input: {
  instance: SweVerifiedInstance;
  dataset: string;
  workspaceRoot: string;
  modelName: string;
  runtimeModelName?: string | undefined;
}): Record<string, unknown> {
  const problemStatement = sanitizeSweVerifiedIssueText(input.instance.problem_statement);
  const hintsText = input.instance.hints_text === undefined
    ? undefined
    : sanitizeSweVerifiedIssueText(input.instance.hints_text, { stripLongPytestTraces: true });
  return {
    version: "job_input_v1",
    storeDriver: "sqlite",
    approvalPolicyPackId: "dev",
    profile: {
      id: "swe-verified",
      label: "SWE Verified",
      agent: "reference-react",
      sessionPrefix: "swe-verified",
      ...benchmarkProfileMode(),
      ...(input.runtimeModelName !== undefined
        ? {
            modelProvider: "openrouter",
            model: input.runtimeModelName,
            agentStageConfig: {
              modelByStage: {
                "agent.loop": input.runtimeModelName,
              },
            },
          }
        : {}),
      devShell: {
        enabled: true,
        envMode: "inherit",
      },
      guardrails: benchmarkGuardrails(),
      toolAllowlist: [
        "FinalizeAnswer",
        "effect_result_lookup",
        "fs.read_text",
        "repo.trace",
        "fs.write_text",
        "fs.replace_text",
        "exec_command",
      ],
    },
    turn: {
      sessionId: `swe-verified-${input.instance.instance_id}`,
      eventType: "job.run",
      message: `Resolve SWE-bench Verified instance ${input.instance.instance_id} in this checked-out repository.`,
      stepAgent: "agent.loop",
      ...benchmarkTurnMode(),
      metadata: {
        benchmark: {
          name: "swe-verified",
          dataset: input.dataset,
          instanceId: input.instance.instance_id,
          repo: input.instance.repo,
          baseCommit: input.instance.base_commit,
          context: {
            source: "swe-verified",
            instanceId: input.instance.instance_id,
            problemStatement,
            ...(hintsText !== undefined && hintsText.length > 0 ? { hintsText } : {}),
            workspaceRoot: SWE_VERIFIED_CONTAINER_WORKSPACE_ROOT,
          },
        },
        workspace: {
          workspaceId: "swe-verified",
          workspaceRoot: input.workspaceRoot,
          label: `SWE Verified ${input.instance.instance_id}`,
          managedWorktreeRequired: false,
          memoryBootstrap: "",
          memoryFiles: [],
          planDocumentSync: false,
        },
      },
    },
  };
}

export function assertSweVerifiedJobInputContract(jobInput: Record<string, unknown>): void {
  const turn = asRecord(jobInput.turn);
  if (turn === undefined) {
    throw new Error("SWE Verified job input must include turn configuration.");
  }

  assertBenchmarkTurnMode(turn, "SWE Verified job turn");

  const profile = asRecord(jobInput.profile);
  if (profile === undefined) {
    throw new Error("SWE Verified job input must include an embedded profile.");
  }

  if (profile.agent !== "reference-react") {
    throw new Error("SWE Verified job profile must use the reference-react agent.");
  }

  if (profile.defaultInteractionMode !== "build") {
    throw new Error("SWE Verified job profile must use canonical build defaultInteractionMode.");
  }

  if (profile.defaultActSubmode !== "full_auto") {
    throw new Error("SWE Verified job profile must use full_auto defaultActSubmode.");
  }

  const devShell = asRecord(profile.devShell);
  if (devShell?.enabled !== true) {
    throw new Error("SWE Verified job profile must enable devShell before allowlisting exec_command.");
  }

  const guardrails = asRecord(profile.guardrails);
  const expectedGuardrails = benchmarkGuardrails() as Record<string, unknown>;
  for (const [key, value] of Object.entries(expectedGuardrails)) {
    if (guardrails?.[key] !== value) {
      throw new Error(`SWE Verified job profile guardrails.${key} must be ${value}.`);
    }
  }

  if (!Array.isArray(profile.toolAllowlist)) {
    throw new Error("SWE Verified job profile must include a toolAllowlist.");
  }

  const toolAllowlist = profile.toolAllowlist.filter((toolName): toolName is string => typeof toolName === "string");
  for (const toolName of SWE_VERIFIED_REQUIRED_PROFILE_TOOLS) {
    if (toolAllowlist.includes(toolName) === false) {
      throw new Error(`SWE Verified job profile is missing required tool: ${toolName}`);
    }
  }

  if (typeof profile.model === "string" && profile.model.trim().length > 0) {
    const agentStageConfig = asRecord(profile.agentStageConfig);
    const modelByStage = asRecord(agentStageConfig?.modelByStage);
    if (modelByStage?.["agent.loop"] !== profile.model) {
      throw new Error("SWE Verified job profile model must match agentStageConfig.modelByStage['agent.loop'].");
    }
  }
}

export function resolveSweVerifiedModelSelection(env: NodeJS.ProcessEnv): {
  modelName: string;
  runtimeModelName?: string | undefined;
} {
  const issues = benchmarkProviderIssues(env);
  if (issues.length > 0) {
    throw new Error(issues.join(" "));
  }
  const runtimeModelName = resolveBenchmarkProviderConfig(env).model;
  return {
    modelName: runtimeModelName,
    runtimeModelName,
  };
}

export function buildSweVerifiedEvaluationArgs(input: {
  dataset: string;
  split: string;
  instanceId: string;
  predictionsPath: string;
  runId: string;
  maxWorkers: number;
  timeout: number;
}): string[] {
  return [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "swe-verified-run-evaluation.py"),
    "--dataset_name",
    input.dataset,
    "--split",
    input.split,
    "--predictions_path",
    input.predictionsPath,
    "--max_workers",
    String(input.maxWorkers),
    "--timeout",
    String(input.timeout),
    "--run_id",
    input.runId,
    "--instance_ids",
    input.instanceId,
  ];
}

export async function runSweVerifiedBench(argv: string[], deps: RuntimeDeps): Promise<number> {
  let options: SweVerifiedBenchOptions;
  try {
    options = parseSweVerifiedBenchArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      deps.stdout.write(helpText());
      return 0;
    }
    deps.stderr.write(`bench:swe failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
    deps.stderr.write(helpText());
    return 1;
  }

  if (options.mode === "preflight") {
    return runPreflight(deps, resolvePythonBin(options, deps.env));
  }

  const instanceId = options.instanceId as string;
  const pythonBin = resolvePythonBin(options, deps.env);
  const instancePaths = buildSweVerifiedAttemptPaths({
    cwd: deps.cwd,
    outputRoot: options.outputRoot,
    instanceId,
    attemptId: ".attempt-placeholder",
  });

  if (options.mode === "list") {
    return listSweVerifiedAttempts({
      deps,
      instanceId,
      instanceRoot: instancePaths.instanceRoot,
      attemptsRoot: instancePaths.attemptsRoot,
    });
  }

  if (options.mode === "evaluate") {
    if (options.predictionsPath === undefined) {
      deps.stderr.write("[bench:swe] --predictions-path is required for evaluate mode.\n");
      return 1;
    }
    const runId = options.runId ?? formatSweVerifiedAttemptId(resolveNow(deps));
    try {
      validatePredictionFile({ predictionsPath: options.predictionsPath, instanceId });
    } catch (error) {
      deps.stderr.write(`[bench:swe] ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    return runEvaluation({
      options,
      deps,
      instanceId,
      runId,
      predictionsPath: options.predictionsPath,
      evaluatorOutputPath: path.join(path.dirname(options.predictionsPath), "evaluator-output.txt"),
      evaluatorReportPath: path.join(path.dirname(options.predictionsPath), "evaluator-report.json"),
      pythonBin,
      dryRun: options.dryRun,
    }).status;
  }

  const attemptId = options.runId ?? formatSweVerifiedAttemptId(resolveNow(deps));
  const attemptPaths = buildSweVerifiedAttemptPaths({
    cwd: deps.cwd,
    outputRoot: options.outputRoot,
    instanceId,
    attemptId,
  });
  if (options.runId !== undefined && existsSync(attemptPaths.attemptDir)) {
    deps.stderr.write(`[bench:swe] Attempt directory already exists for --run-id ${attemptId}: ${path.relative(deps.cwd, attemptPaths.attemptDir)}\n`);
    return 1;
  }
  mkdirSync(attemptPaths.attemptDir, { recursive: true });
  const predictionsPath = options.predictionsPath ?? path.join(attemptPaths.attemptDir, "predictions.jsonl");
  let instance: SweVerifiedInstance;
  try {
    instance = loadInstance({ options, deps, instanceId });
  } catch (error) {
    deps.stderr.write(`[bench:swe] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const repoDir = path.join(attemptPaths.attemptDir, "workspace", "repo");
  const jobInputPath = path.join(attemptPaths.attemptDir, "job-input.json");
  const jobOutputPath = path.join(attemptPaths.attemptDir, "job-output.json");
  const kestrelOutputPath = path.join(attemptPaths.attemptDir, "kestrel-output.txt");
  const runnerImageDir = path.join(attemptPaths.attemptDir, SWE_VERIFIED_RUNNER_IMAGE_DIR_NAME);
  const modelPatchPath = path.join(attemptPaths.attemptDir, SWE_VERIFIED_MODEL_PATCH_FILE);
  const patchReportPath = path.join(attemptPaths.attemptDir, SWE_VERIFIED_PATCH_REPORT_FILE);
  const baselineReportPath = path.join(attemptPaths.attemptDir, SWE_VERIFIED_BASELINE_REPORT_FILE);
  const baselineOutputPath = path.join(attemptPaths.attemptDir, SWE_VERIFIED_BASELINE_OUTPUT_FILE);
  const runScriptPath = path.join(attemptPaths.attemptDir, "run-kestrel.sh");
  let modelSelection: ReturnType<typeof resolveSweVerifiedModelSelection>;
  try {
    modelSelection = resolveSweVerifiedModelSelection(deps.env);
  } catch (error) {
    deps.stderr.write(`[bench:swe] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  for (const warning of benchmarkProviderWarnings(deps.env)) {
    deps.stderr.write(`[bench:swe] ${warning}\n`);
  }
  const benchmarkEnv = benchmarkProviderEnv(deps.env);
  const { modelName, runtimeModelName } = modelSelection;
  const jobInput = buildSweVerifiedJobInput({
    instance,
    dataset: options.dataset,
    workspaceRoot: SWE_VERIFIED_CONTAINER_WORKSPACE_ROOT,
    modelName,
    runtimeModelName,
  });
  try {
    assertSweVerifiedJobInputContract(jobInput);
  } catch (error) {
    deps.stderr.write(`[bench:swe] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  writeFileSync(jobInputPath, JSON.stringify(jobInput, null, 2) + "\n", "utf8");
  writeLatestAttemptMetadata({
    cwd: deps.cwd,
    instanceRoot: attemptPaths.instanceRoot,
    attemptId,
    attemptDir: attemptPaths.attemptDir,
    predictionsPath,
    jobInputPath,
    jobOutputPath,
    kestrelOutputPath,
    now: resolveNow(deps),
  });

  const cloneArgs = ["clone", `https://github.com/${instance.repo}.git`, repoDir];
  const checkoutArgs = ["-C", repoDir, "checkout", instance.base_commit];
  const imageInfoArgs = buildSweVerifiedImageInfoArgs({
    dataset: options.dataset,
    split: options.split,
    instanceId,
  });
  const prepareImagesArgs = buildSweVerifiedPrepareImagesArgs({
    dataset: options.dataset,
    split: options.split,
    instanceId,
    maxWorkers: options.maxWorkers,
  });

  if (options.dryRun) {
    deps.stdout.write(`[bench:swe] dataset=${options.dataset} split=${options.split} instance=${instanceId}\n`);
    deps.stdout.write(`[bench:swe] attempt=${attemptId}\n`);
    if (runtimeModelName !== undefined) {
      deps.stdout.write(`[bench:swe] runtime-model-provider=openrouter runtime-model=${runtimeModelName}\n`);
    }
    deps.stdout.write(`[bench:swe] dry-run: ${formatCommand("git", cloneArgs)}\n`);
    deps.stdout.write(`[bench:swe] dry-run: ${formatCommand("git", checkoutArgs)}\n`);
    deps.stdout.write(`[bench:swe] dry-run: ${formatCommand(pythonBin, imageInfoArgs)}\n`);
    deps.stdout.write(`[bench:swe] dry-run: ${formatCommand(pythonBin, prepareImagesArgs)}\n`);
    deps.stdout.write("[bench:swe] dry-run: docker image inspect <swe-instance-image>\n");
    deps.stdout.write(`[bench:swe] dry-run: would build a derived Kestrel SWE runner image under ${path.relative(deps.cwd, runnerImageDir)}\n`);
    deps.stdout.write(`[bench:swe] dry-run: would run Kestrel inside Docker with ${SWE_VERIFIED_CONTAINER_WORKSPACE_ROOT} as the workspace\n`);
    deps.stdout.write(`[bench:swe] dry-run: would write ${path.relative(deps.cwd, predictionsPath)}\n`);
    deps.stdout.write(
      `[bench:swe] dry-run: ${formatCommand(pythonBin, buildSweVerifiedEvaluationArgs({
        dataset: options.dataset,
        split: options.split,
        instanceId,
        predictionsPath,
        runId: attemptId,
        maxWorkers: options.maxWorkers,
        timeout: options.timeout,
      }))}\n`,
    );
    return 0;
  }

  mkdirSync(path.dirname(repoDir), { recursive: true });
  const clone = deps.spawn("git", cloneArgs, { cwd: deps.cwd, env: deps.env });
  if (!spawnPassed(clone)) {
    deps.stderr.write(`[bench:swe] git clone failed.\n${renderSpawnOutput(clone)}`);
    return clone.status ?? 1;
  }

  const checkout = deps.spawn("git", checkoutArgs, { cwd: deps.cwd, env: deps.env });
  if (!spawnPassed(checkout)) {
    deps.stderr.write(`[bench:swe] git checkout failed.\n${renderSpawnOutput(checkout)}`);
    return checkout.status ?? 1;
  }

  let imageInfo: SweVerifiedImageInfo;
  try {
    imageInfo = loadSweVerifiedImageInfo({
      deps,
      pythonBin,
      args: imageInfoArgs,
      instanceId,
    });
  } catch (error) {
    deps.stderr.write(`[bench:swe] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const prepareImages = deps.spawn(pythonBin, prepareImagesArgs, {
    cwd: deps.cwd,
    env: deps.env,
  });
  if (!spawnPassed(prepareImages)) {
    deps.stderr.write(`[bench:swe] SWE-bench image preparation failed.\n${renderSpawnOutput(prepareImages)}`);
    return prepareImages.status ?? 1;
  }
  const imageInspect = deps.spawn("docker", ["image", "inspect", imageInfo.instanceImageKey], {
    cwd: deps.cwd,
    env: deps.env,
  });
  if (!spawnPassed(imageInspect)) {
    deps.stderr.write(
      `[bench:swe] SWE-bench image preparation completed but expected instance image is missing: ${imageInfo.instanceImageKey}\n` +
      `prepare_images output:\n${renderSpawnOutput(prepareImages)}` +
      `docker image inspect output:\n${renderSpawnOutput(imageInspect)}`,
    );
    return imageInspect.status ?? 1;
  }

  let sourceHash: string;
  try {
    sourceHash = createSweVerifiedRunnerBuildContext({
      deps,
      runnerImageDir,
      baseImage: imageInfo.instanceImageKey,
    });
  } catch (error) {
    deps.stderr.write(`[bench:swe] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const runnerImageTag = buildSweVerifiedRunnerImageTag({
    instanceImageKey: imageInfo.instanceImageKey,
    sourceHash,
  });
  const dockerBuild = deps.spawn("docker", buildSweVerifiedRunnerImageBuildArgs({
    runnerImageDir,
    runnerImageTag,
    baseImage: imageInfo.instanceImageKey,
    platform: imageInfo.platform,
  }), {
    cwd: deps.cwd,
    env: deps.env,
  });
  if (!spawnPassed(dockerBuild)) {
    deps.stderr.write(`[bench:swe] Kestrel SWE runner image build failed.\n${renderSpawnOutput(dockerBuild)}`);
    return dockerBuild.status ?? 1;
  }

  const baselineCapture = deps.spawn("docker", buildSweVerifiedBaselineCaptureArgs({
    attemptDir: attemptPaths.attemptDir,
    baselineRepoDir: repoDir,
    runnerImageTag,
    sourceBaseCommit: instance.base_commit,
  }), {
    cwd: deps.cwd,
    env: deps.env,
  });
  writeFileSync(baselineOutputPath, renderSpawnOutput(baselineCapture), "utf8");
  let baselineReport: SweWorkspaceBaselineReport;
  try {
    baselineReport = readAndValidateWorkspaceBaselineReport({
      reportPath: baselineReportPath,
      expectedSourceBaseCommit: instance.base_commit,
    });
  } catch (error) {
    updateLatestAttemptMetadata({
      cwd: deps.cwd,
      instanceRoot: attemptPaths.instanceRoot,
      now: resolveNow(deps),
      patchPath: modelPatchPath,
      patchExists: false,
      terminalStatus: "baseline_capture_failed",
      evaluatorRan: false,
      baselineReportPath,
    });
    deps.stderr.write(
      `[bench:swe] prepared workspace baseline capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  if (!spawnPassed(baselineCapture) || baselineReport.status === "failed") {
    updateLatestAttemptMetadata({
      cwd: deps.cwd,
      instanceRoot: attemptPaths.instanceRoot,
      now: resolveNow(deps),
      patchPath: modelPatchPath,
      patchExists: false,
      terminalStatus: "baseline_capture_failed",
      evaluatorRan: false,
      baselineReport,
      baselineReportPath,
    });
    deps.stderr.write(
      `[bench:swe] prepared workspace baseline capture failed at ${String(baselineReport.failureStage)}: ${String(baselineReport.failureMessage)}\n`,
    );
    return 1;
  }

  writeSweVerifiedContainerRunScript({
    runScriptPath,
    sourceBaseCommit: instance.base_commit,
    baseCommit: baselineReport.baselineCommit as string,
    jobInputPath: path.join(SWE_VERIFIED_CONTAINER_ATTEMPT_DIR, path.basename(jobInputPath)),
    jobOutputPath: path.join(SWE_VERIFIED_CONTAINER_ATTEMPT_DIR, path.basename(jobOutputPath)),
    kestrelOutputPath: path.join(SWE_VERIFIED_CONTAINER_ATTEMPT_DIR, path.basename(kestrelOutputPath)),
    modelPatchPath: path.join(SWE_VERIFIED_CONTAINER_ATTEMPT_DIR, path.basename(modelPatchPath)),
    patchReportPath: path.join(SWE_VERIFIED_CONTAINER_ATTEMPT_DIR, path.basename(patchReportPath)),
  });
  const kestrel = deps.spawn("docker", buildSweVerifiedDockerRunArgs({
    deps: { ...deps, env: benchmarkEnv },
    attemptDir: attemptPaths.attemptDir,
    baselineRepoDir: repoDir,
    runnerImageTag,
  }), {
    cwd: deps.cwd,
    env: {
      ...benchmarkEnv,
      KESTREL_HOME: path.join(SWE_VERIFIED_CONTAINER_ATTEMPT_DIR, "kestrel-home"),
      KESTREL_STORE_DRIVER: "sqlite",
      KESTREL_SQLITE_PATH: path.join(SWE_VERIFIED_CONTAINER_ATTEMPT_DIR, "runtime.db"),
    },
  });
  if (!existsSync(kestrelOutputPath)) {
    writeFileSync(kestrelOutputPath, renderSpawnOutput(kestrel), "utf8");
  }
  let patchReport: SweWorkspacePatchReport;
  try {
    patchReport = readAndValidateWorkspacePatchReport({
      reportPath: patchReportPath,
      patchPath: modelPatchPath,
      expectedSourceBaseCommit: instance.base_commit,
      expectedBaselineCommit: baselineReport.baselineCommit as string,
    });
  } catch (error) {
    updateLatestAttemptMetadata({
      cwd: deps.cwd,
      instanceRoot: attemptPaths.instanceRoot,
      now: resolveNow(deps),
      patchPath: modelPatchPath,
      patchExists: existsSync(modelPatchPath),
      terminalStatus: "patch_harvest_failed",
      evaluatorRan: false,
      patchReportPath,
      baselineReport,
      baselineReportPath,
    });
    deps.stderr.write(`[bench:swe] workspace patch harvesting failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!spawnPassed(kestrel)) {
    deps.stderr.write(
      `[bench:swe] warning: container command exited with status ${String(kestrel.status)} after writing a valid workspace patch report.\n`,
    );
  }
  if (patchReport.status === "failed") {
    updateLatestAttemptMetadata({
      cwd: deps.cwd,
      instanceRoot: attemptPaths.instanceRoot,
      now: resolveNow(deps),
      patchPath: modelPatchPath,
      patchExists: false,
      terminalStatus: "patch_harvest_failed",
      evaluatorRan: false,
      patchReport,
      patchReportPath,
      baselineReport,
      baselineReportPath,
    });
    deps.stderr.write(
      `[bench:swe] workspace patch harvesting failed at ${String(patchReport.failureStage)}: ${String(patchReport.failureMessage)}\n`,
    );
    return 1;
  }

  let terminalStatus = patchReport.kestrelExitCode === 0
    ? "evaluated"
    : "evaluated_after_kestrel_failure";
  let kestrelJobSummary: KestrelJobStatusSummary | undefined;
  try {
    kestrelJobSummary = readKestrelJobStatus(jobOutputPath);
    assertKestrelJobCompleted(jobOutputPath);
  } catch (error) {
    if (terminalStatus === "evaluated") {
      terminalStatus = "evaluated_after_nonterminal_job";
    }
    deps.stderr.write(
      `[bench:swe] warning: ${error instanceof Error ? error.message : String(error)} Validated non-empty patches still proceed to evaluation.\n`,
    );
  }

  if (patchReport.status === "empty") {
    updateLatestAttemptMetadata({
      cwd: deps.cwd,
      instanceRoot: attemptPaths.instanceRoot,
      now: resolveNow(deps),
      patchPath: modelPatchPath,
      patchExists: true,
      terminalStatus: "empty_patch",
      evaluatorRan: false,
      kestrelJobSummary,
      patchReport,
      patchReportPath,
      baselineReport,
      baselineReportPath,
    });
    deps.stderr.write("[bench:swe] workspace export verified that the final submission is empty. Skipping evaluation.\n");
    return 1;
  }

  const modelPatch = readFileSync(modelPatchPath, "utf8");
  writePrediction({ predictionsPath, instanceId, modelName, modelPatch });
  deps.stdout.write(`[bench:swe] wrote ${path.relative(deps.cwd, predictionsPath)}\n`);

  const evaluation = runEvaluation({
    options,
    deps,
    instanceId,
    runId: attemptId,
    predictionsPath,
    evaluatorOutputPath: path.join(attemptPaths.attemptDir, "evaluator-output.txt"),
    evaluatorReportPath: path.join(attemptPaths.attemptDir, "evaluator-report.json"),
    pythonBin,
    dryRun: false,
  });
  updateLatestAttemptMetadata({
    cwd: deps.cwd,
    instanceRoot: attemptPaths.instanceRoot,
    now: resolveNow(deps),
    patchPath: modelPatchPath,
    patchExists: true,
    terminalStatus: evaluation.status === 0 ? terminalStatus : "evaluation_failed",
    evaluatorRan: true,
    evaluation,
    kestrelJobSummary,
    patchReport,
    patchReportPath,
    baselineReport,
    baselineReportPath,
  });
  return evaluation.status;
}

function buildSweVerifiedImageInfoArgs(input: {
  dataset: string;
  split: string;
  instanceId: string;
}): string[] {
  return [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "swe-verified-image-info.py"),
    "--dataset",
    input.dataset,
    "--split",
    input.split,
    "--instance-id",
    input.instanceId,
  ];
}

function buildSweVerifiedPrepareImagesArgs(input: {
  dataset: string;
  split: string;
  instanceId: string;
  maxWorkers: number;
}): string[] {
  return [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "swe-verified-prepare-images.py"),
    "--dataset_name",
    input.dataset,
    "--split",
    input.split,
    "--instance_ids",
    input.instanceId,
    "--max_workers",
    String(input.maxWorkers),
    "--tag",
    "latest",
    "--env_image_tag",
    "latest",
  ];
}

function loadSweVerifiedImageInfo(input: {
  deps: RuntimeDeps;
  pythonBin: string;
  args: string[];
  instanceId: string;
}): SweVerifiedImageInfo {
  const result = input.deps.spawn(input.pythonBin, input.args, {
    cwd: input.deps.cwd,
    env: input.deps.env,
  });
  if (!spawnPassed(result)) {
    throw new Error(`Unable to resolve SWE-bench image metadata for ${input.instanceId}.\n${renderSpawnOutput(result)}`);
  }
  const payload = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
  const instanceImageKey = readRequiredString(payload, "instance_image_key");
  const platform = readRequiredString(payload, "platform");
  return { instanceImageKey, platform };
}

function createSweVerifiedRunnerBuildContext(input: {
  deps: RuntimeDeps;
  runnerImageDir: string;
  baseImage: string;
}): string {
  rmSync(input.runnerImageDir, { recursive: true, force: true });
  const sourceDir = path.join(input.runnerImageDir, SWE_VERIFIED_RUNNER_SOURCE_DIR_NAME);
  mkdirSync(sourceDir, { recursive: true });

  const attemptDir = path.dirname(input.runnerImageDir);
  const excludedRoots = [path.relative(input.deps.cwd, attemptDir)].filter((value) => value.length > 0);
  const files = listSweVerifiedRunnerSourceFiles(input.deps, excludedRoots);
  const hash = createHash("sha256");
  hash.update(input.baseImage);
  hash.update("\0");
  for (const relativePath of files) {
    const sourcePath = path.join(input.deps.cwd, relativePath);
    const targetPath = path.join(sourceDir, relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath, { dereference: false });
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(sourcePath));
    hash.update("\0");
  }

  writeFileSync(
    path.join(input.runnerImageDir, "Dockerfile"),
    [
      "ARG BASE_IMAGE",
      "FROM node:22-bookworm-slim AS node",
      "FROM ${BASE_IMAGE}",
      "COPY --from=node /usr/local /usr/local",
      "ENV PATH=/usr/local/bin:${PATH}",
      "RUN corepack enable pnpm",
      "WORKDIR /opt/kestrel",
      `COPY ${SWE_VERIFIED_RUNNER_SOURCE_DIR_NAME}/ ./`,
      "RUN pnpm install --frozen-lockfile --ignore-workspace",
      `WORKDIR ${SWE_VERIFIED_CONTAINER_WORKSPACE_ROOT}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return hash.digest("hex");
}

function listSweVerifiedRunnerSourceFiles(deps: RuntimeDeps, excludedRoots: string[]): string[] {
  const result = deps.spawn("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: deps.cwd,
    env: deps.env,
  });
  if (!spawnPassed(result)) {
    throw new Error(`Unable to snapshot Kestrel source for SWE runner image.\n${renderSpawnOutput(result)}`);
  }
  return result.stdout.toString("utf8")
    .split("\0")
    .filter((relativePath) => relativePath.length > 0)
    .filter((relativePath) => shouldIncludeSweVerifiedRunnerSourceFile(relativePath, excludedRoots))
    .filter((relativePath) => existsSync(path.join(deps.cwd, relativePath)))
    .sort();
}

export function shouldIncludeSweVerifiedRunnerSourceFile(relativePath: string, excludedRoots: string[]): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  if (excludedRoots.some((root) => isPathWithinRoot(normalized, root))) {
    return false;
  }
  if (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.includes("/.env.") ||
    normalized.endsWith("/.env")
  ) {
    return false;
  }
  return (
    normalized !== ".git" &&
    normalized.startsWith(".git/") === false &&
    normalized !== "node_modules" &&
    normalized.startsWith("node_modules/") === false &&
    normalized !== "runs" &&
    normalized.startsWith("runs/") === false &&
    normalized !== "logs" &&
    normalized.startsWith("logs/") === false &&
    normalized !== "output" &&
    normalized.startsWith("output/") === false &&
    normalized !== "outputs" &&
    normalized.startsWith("outputs/") === false &&
    normalized !== ".cache" &&
    normalized.startsWith(".cache/") === false &&
    normalized !== ".hf-cache" &&
    normalized.startsWith(".hf-cache/") === false &&
    normalized !== ".pytest_cache" &&
    normalized.startsWith(".pytest_cache/") === false &&
    isRootBenchmarkReportArtifact(normalized) === false &&
    (normalized.includes("/") || normalized.startsWith("kestrel.") === false || normalized.endsWith(".json") === false) &&
    normalized.endsWith(".log") === false &&
    normalized !== "dist" &&
    normalized.startsWith("dist/") === false
  );
}

function isRootBenchmarkReportArtifact(normalizedPath: string): boolean {
  if (normalizedPath.includes("/") || normalizedPath.endsWith(".json") === false) {
    return false;
  }
  return /^[a-z0-9][a-z0-9._-]*__[a-z0-9][a-z0-9._-]*\.\d{8}T\d{9}Z\.json$/iu.test(normalizedPath) ||
    /^codex-cli-[a-z0-9._-]+-\d{8}T\d{9}Z\.json$/iu.test(normalizedPath);
}

function isPathWithinRoot(relativePath: string, root: string): boolean {
  const normalizedRoot = root.split(path.sep).join("/").replace(/\/+$/u, "");
  return normalizedRoot.length > 0 && (relativePath === normalizedRoot || relativePath.startsWith(`${normalizedRoot}/`));
}

function buildSweVerifiedRunnerImageTag(input: {
  instanceImageKey: string;
  sourceHash: string;
}): string {
  const hash = createHash("sha256")
    .update(input.instanceImageKey)
    .update("\0")
    .update(input.sourceHash)
    .digest("hex")
    .slice(0, 24);
  return `kestrel-swe-runner:${hash}`;
}

function buildSweVerifiedRunnerImageBuildArgs(input: {
  runnerImageDir: string;
  runnerImageTag: string;
  baseImage: string;
  platform: string;
}): string[] {
  return [
    "build",
    "--platform",
    normalizeDockerPlatform(input.platform),
    "--build-arg",
    `BASE_IMAGE=${input.baseImage}`,
    "-t",
    input.runnerImageTag,
    input.runnerImageDir,
  ];
}

function normalizeDockerPlatform(platform: string): string {
  return platform === "linux/x86_64" ? "linux/amd64" : platform;
}

function writeSweVerifiedContainerRunScript(input: {
  runScriptPath: string;
  sourceBaseCommit: string;
  baseCommit: string;
  jobInputPath: string;
  jobOutputPath: string;
  kestrelOutputPath: string;
  modelPatchPath: string;
  patchReportPath: string;
}): void {
  writeFileSync(
    input.runScriptPath,
    [
      "#!/usr/bin/env bash",
      "set +e",
      `cd ${SWE_VERIFIED_CONTAINER_WORKSPACE_ROOT}`,
      "node /opt/kestrel/bin/kestrel.js job run \\",
      `  --json-in ${shellQuote(input.jobInputPath)} \\`,
      `  --json-out ${shellQuote(input.jobOutputPath)} \\`,
      `  --store sqlite > ${shellQuote(input.kestrelOutputPath)} 2>&1`,
      "kestrel_status=$?",
      "cd /opt/kestrel",
      "node --import tsx /opt/kestrel/scripts/swe-verified-workspace-patch.ts \\",
      "  --mode export \\",
      `  --workspace-root ${shellQuote(SWE_VERIFIED_CONTAINER_WORKSPACE_ROOT)} \\`,
      `  --baseline-repo ${shellQuote(SWE_VERIFIED_CONTAINER_BASELINE_REPO)} \\`,
      `  --source-base-commit ${shellQuote(input.sourceBaseCommit)} \\`,
      `  --base-commit ${shellQuote(input.baseCommit)} \\`,
      `  --patch-path ${shellQuote(input.modelPatchPath)} \\`,
      `  --report-path ${shellQuote(input.patchReportPath)} \\`,
      `  --kestrel-exit-code "$kestrel_status" >> ${shellQuote(input.kestrelOutputPath)} 2>&1`,
      "export_status=$?",
      "exit \"$export_status\"",
      "",
    ].join("\n"),
    "utf8",
  );
}

function buildSweVerifiedBaselineCaptureArgs(input: {
  attemptDir: string;
  baselineRepoDir: string;
  runnerImageTag: string;
  sourceBaseCommit: string;
}): string[] {
  return [
    "run",
    "--rm",
    "-v",
    `${input.attemptDir}:${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}`,
    "-v",
    `${input.baselineRepoDir}:${SWE_VERIFIED_CONTAINER_BASELINE_REPO}`,
    "-w",
    "/opt/kestrel",
    input.runnerImageTag,
    "node",
    "--import",
    "tsx",
    "/opt/kestrel/scripts/swe-verified-workspace-patch.ts",
    "--mode",
    "capture",
    "--workspace-root",
    SWE_VERIFIED_CONTAINER_WORKSPACE_ROOT,
    "--baseline-repo",
    SWE_VERIFIED_CONTAINER_BASELINE_REPO,
    "--source-base-commit",
    input.sourceBaseCommit,
    "--report-path",
    `${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}/${SWE_VERIFIED_BASELINE_REPORT_FILE}`,
  ];
}

function buildSweVerifiedDockerRunArgs(input: {
  deps: RuntimeDeps;
  attemptDir: string;
  baselineRepoDir: string;
  runnerImageTag: string;
}): string[] {
  const args = [
    "run",
    "--rm",
    "-v",
    `${input.attemptDir}:${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}`,
    "-v",
    `${input.baselineRepoDir}:${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}/workspace/repo:ro`,
    "-v",
    `${input.baselineRepoDir}:${SWE_VERIFIED_CONTAINER_BASELINE_REPO}:ro`,
  ];
  const dotEnvPath = path.join(input.deps.cwd, ".env");
  if (existsSync(dotEnvPath)) {
    args.push("-v", `${dotEnvPath}:/opt/kestrel/.env:ro`);
  }
  const containerOwnedEnv = new Set([
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "KESTREL_HOME",
    "KESTREL_STORE_DRIVER",
    "KESTREL_SQLITE_PATH",
    "KESTREL_DISABLE_DOTENV",
    "KESTREL_DEV_SHELL_SOCKET_PATH",
    "KESTREL_DEV_SHELL_LOG_PATH",
    "KESTREL_DEV_SHELL_STATUS_PATH",
    "KESTREL_MODEL_PROMPT_DUMP",
    "KESTREL_MODEL_PROMPT_DUMP_DIR",
    "DATABASE_URL",
  ]);
  for (const name of Object.keys(input.deps.env).filter(isValidEnvironmentName).sort()) {
    if (containerOwnedEnv.has(name)) {
      continue;
    }
    args.push("-e", name);
  }
  args.push(
    ...buildSweVerifiedContainerDatabaseEnv(input.deps.env),
    "-e",
    "SHELL=/bin/bash",
    "-e",
    "HOME=/root",
    "-e",
    "TMPDIR=/tmp",
    "-e",
    "KESTREL_DISABLE_DOTENV=1",
    "-e",
    `KESTREL_HOME=${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}/kestrel-home`,
    "-e",
    "KESTREL_STORE_DRIVER=sqlite",
    "-e",
    `KESTREL_SQLITE_PATH=${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}/runtime.db`,
    "-e",
    `KESTREL_DEV_SHELL_SOCKET_PATH=${SWE_VERIFIED_CONTAINER_DEV_SHELL_DIR}/supervisor.sock`,
    "-e",
    `KESTREL_DEV_SHELL_LOG_PATH=${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}/kestrel-home/dev-shell/service.log`,
    "-e",
    `KESTREL_DEV_SHELL_STATUS_PATH=${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}/kestrel-home/dev-shell/bootstrap-status.json`,
    "-e",
    "KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS=30000",
    "-e",
    "-e",
    "KESTREL_MODEL_PROMPT_DUMP=1",
    "-e",
    `KESTREL_MODEL_PROMPT_DUMP_DIR=${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}/model-prompts`,
    "-w",
    SWE_VERIFIED_CONTAINER_WORKSPACE_ROOT,
    input.runnerImageTag,
    "bash",
    `${SWE_VERIFIED_CONTAINER_ATTEMPT_DIR}/run-kestrel.sh`,
  );
  return args;
}

function isValidEnvironmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function buildSweVerifiedContainerDatabaseEnv(env: NodeJS.ProcessEnv): string[] {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    return [];
  }
  return ["-e", `DATABASE_URL=${rewriteLocalDatabaseUrlForContainer(databaseUrl)}`];
}

function rewriteLocalDatabaseUrlForContainer(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      parsed.hostname = "host.docker.internal";
      return parsed.toString();
    }
  } catch {
    return databaseUrl;
  }
  return databaseUrl;
}

function stripLongPytestTraceBlocks(input: string): string {
  const withoutFencedTraces = input.replace(/```[\s\S]*?```/gu, (block) =>
    isLongPytestTrace(block) ? "" : block
  );
  return withoutFencedTraces
    .split(/\n{2,}/u)
    .filter((block) => isLongPytestTrace(block) === false)
    .join("\n\n");
}

function isLongPytestTrace(block: string): boolean {
  if (block.length < 1200) {
    return false;
  }
  const lower = block.toLowerCase();
  return (
    lower.includes("traceback") ||
    lower.includes("_pytest") ||
    lower.includes("pluggy") ||
    lower.includes("plugin already registered") ||
    lower.includes("site-packages/pytest")
  );
}

function normalizeMarkdownWhitespace(input: string): string {
  return input
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function runPreflight(deps: RuntimeDeps, pythonBin: string): number {
  const issues: string[] = [...benchmarkProviderIssues(deps.env)];
  const python = deps.spawn(pythonBin, [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "swe-verified-run-evaluation.py"),
    "--help",
  ], {
    cwd: deps.cwd,
    env: deps.env,
  });
  if (!spawnPassed(python)) {
    issues.push(`SWE-bench evaluation wrapper is not available to ${pythonBin}. Install the official swebench package in that environment first.`);
  }
  const datasets = deps.spawn(pythonBin, ["-c", "import datasets"], {
    cwd: deps.cwd,
    env: deps.env,
  });
  if (!spawnPassed(datasets)) {
    issues.push(`datasets is not available to ${pythonBin}. Install it in that environment before running SWE Verified without --instances-jsonl.`);
  }

  const git = deps.spawn("git", ["--version"], { cwd: deps.cwd, env: deps.env });
  if (!spawnPassed(git)) {
    issues.push("git is not available.");
  }

  const docker = deps.spawn("docker", ["info"], { cwd: deps.cwd, env: deps.env });
  if (!spawnPassed(docker)) {
    issues.push("Docker is not available for the official SWE-bench evaluator.");
  }
  const pythonDocker = deps.spawn(pythonBin, ["-c", "import docker; docker.from_env().ping()"], {
    cwd: deps.cwd,
    env: deps.env,
  });
  if (!spawnPassed(pythonDocker)) {
    issues.push("Python Docker SDK cannot reach Docker. Set DOCKER_HOST to the active Docker socket before running SWE Verified.");
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      deps.stderr.write(`[bench:swe] ${issue}\n`);
    }
    return 1;
  }
  for (const warning of benchmarkProviderWarnings(deps.env)) {
    deps.stderr.write(`[bench:swe] ${warning}\n`);
  }

  deps.stdout.write("[bench:swe] preflight passed.\n");
  return 0;
}

function runEvaluation(input: {
  options: SweVerifiedBenchOptions;
  deps: RuntimeDeps;
  instanceId: string;
  runId: string;
  predictionsPath: string;
  evaluatorOutputPath: string;
  evaluatorReportPath: string;
  pythonBin: string;
  dryRun: boolean;
}): SweVerifiedEvaluationResult {
  const args = buildSweVerifiedEvaluationArgs({
    dataset: input.options.dataset,
    split: input.options.split,
    instanceId: input.instanceId,
    predictionsPath: input.predictionsPath,
    runId: input.runId,
    maxWorkers: input.options.maxWorkers,
    timeout: input.options.timeout,
  });
  if (input.dryRun) {
    input.deps.stdout.write(`[bench:swe] dry-run: ${formatCommand(input.pythonBin, args)}\n`);
    const report = { status: 0 };
    return {
      status: 0,
      outputPath: input.evaluatorOutputPath,
      reportPath: input.evaluatorReportPath,
      report,
    };
  }
  const evaluation = input.deps.spawn(input.pythonBin, args, {
    cwd: input.deps.cwd,
    env: input.deps.env,
  });
  const output = renderSpawnOutput(evaluation);
  input.deps.stdout.write(output);
  mkdirSync(path.dirname(input.evaluatorOutputPath), { recursive: true });
  writeFileSync(input.evaluatorOutputPath, output, "utf8");
  const status = evaluation.status ?? (evaluation.error === undefined ? 0 : 1);
  const parsedReport = parseSweVerifiedEvaluationOutput(output);
  const report: SweVerifiedEvaluationReport = {
    status,
    ...(parsedReport.resolved_instances !== undefined
      ? { resolved_instances: parsedReport.resolved_instances }
      : {}),
    ...(parsedReport.unresolved_instances !== undefined
      ? { unresolved_instances: parsedReport.unresolved_instances }
      : {}),
    ...(parsedReport.resolved_ids !== undefined ? { resolved_ids: parsedReport.resolved_ids } : {}),
    ...(parsedReport.unresolved_ids !== undefined ? { unresolved_ids: parsedReport.unresolved_ids } : {}),
  };
  mkdirSync(path.dirname(input.evaluatorReportPath), { recursive: true });
  writeFileSync(input.evaluatorReportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  return {
    status,
    outputPath: input.evaluatorOutputPath,
    reportPath: input.evaluatorReportPath,
    report,
  };
}

function parseSweVerifiedEvaluationOutput(output: string): Partial<SweVerifiedEvaluationReport> {
  const embeddedReport = parseEmbeddedSweVerifiedEvaluationReport(output);
  if (embeddedReport !== undefined) {
    return embeddedReport;
  }
  return {
    ...readEvaluationCountSummary(output),
    ...readEvaluationIdSummary(output),
  };
}

function parseEmbeddedSweVerifiedEvaluationReport(output: string): Partial<SweVerifiedEvaluationReport> | undefined {
  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return ;
  }
  try {
    const parsed = JSON.parse(output.slice(firstBrace, lastBrace + 1)) as unknown;
    const record = asRecord(parsed);
    if (record === undefined) {
      return ;
    }
    return compactEvaluationReport({
      resolved_instances: readNonNegativeNumber(record.resolved_instances),
      unresolved_instances: readNonNegativeNumber(record.unresolved_instances),
      resolved_ids: readStringArray(record.resolved_ids),
      unresolved_ids: readStringArray(record.unresolved_ids),
    });
  } catch {
    return ;
  }
}

function readEvaluationCountSummary(output: string): Partial<SweVerifiedEvaluationReport> {
  return compactEvaluationReport({
    resolved_instances: readLabeledCount(output, /(?:Instances\s+resolved|resolved_instances)\s*[:=]\s*(\d+)/iu),
    unresolved_instances: readLabeledCount(output, /(?:Instances\s+unresolved|unresolved_instances)\s*[:=]\s*(\d+)/iu),
  });
}

function readEvaluationIdSummary(output: string): Partial<SweVerifiedEvaluationReport> {
  const resolvedIds = readJsonLikeStringList(output, /resolved_ids\s*[:=]\s*(\[[^\n\r]*\])/iu);
  const unresolvedIds = readJsonLikeStringList(output, /unresolved_ids\s*[:=]\s*(\[[^\n\r]*\])/iu);
  return compactEvaluationReport({
    ...(resolvedIds !== undefined ? { resolved_ids: resolvedIds } : {}),
    ...(unresolvedIds !== undefined ? { unresolved_ids: unresolvedIds } : {}),
  });
}

function readLabeledCount(output: string, pattern: RegExp): number | undefined {
  const match = output.match(pattern);
  if (match?.[1] === undefined) {
    return ;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readJsonLikeStringList(output: string, pattern: RegExp): string[] | undefined {
  const match = output.match(pattern);
  if (match?.[1] === undefined) {
    return ;
  }
  try {
    return readStringArray(JSON.parse(match[1]));
  } catch {
    return ;
  }
}

function compactEvaluationReport(
  input: Partial<SweVerifiedEvaluationReport>,
): Partial<SweVerifiedEvaluationReport> {
  return {
    ...(input.resolved_instances !== undefined ? { resolved_instances: input.resolved_instances } : {}),
    ...(input.unresolved_instances !== undefined ? { unresolved_instances: input.unresolved_instances } : {}),
    ...(input.resolved_ids !== undefined ? { resolved_ids: input.resolved_ids } : {}),
    ...(input.unresolved_ids !== undefined ? { unresolved_ids: input.unresolved_ids } : {}),
  };
}

function listSweVerifiedAttempts(input: {
  deps: RuntimeDeps;
  instanceId: string;
  instanceRoot: string;
  attemptsRoot: string;
}): number {
  input.deps.stdout.write(`[bench:swe] instance=${input.instanceId}\n`);
  if (!existsSync(input.attemptsRoot)) {
    input.deps.stdout.write(`[bench:swe] no attempts found under ${path.relative(input.deps.cwd, input.instanceRoot)}\n`);
    return 0;
  }

  const latest = readLatestAttemptMetadata(path.join(input.instanceRoot, "latest.json"));
  if (latest !== undefined) {
    input.deps.stdout.write(
      `[bench:swe] latest attempt=${latest.attempt_id} predictions=${latest.predictions_path}\n`,
    );
  }

  const attempts = readdirSync(input.attemptsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  for (const attemptId of attempts) {
    const attemptDir = path.join(input.attemptsRoot, attemptId);
    const predictionsPath = path.join(attemptDir, "predictions.jsonl");
    const latestLabel = latest?.attempt_id === attemptId ? " latest" : "";
    input.deps.stdout.write(
      `[bench:swe] attempt=${attemptId}${latestLabel} dir=${path.relative(input.deps.cwd, attemptDir)} predictions=${path.relative(input.deps.cwd, predictionsPath)}${existsSync(predictionsPath) ? "" : " (missing)"}\n`,
    );
  }
  return 0;
}

export function validatePredictionFile(input: {
  predictionsPath: string;
  instanceId: string;
}): void {
  if (!existsSync(input.predictionsPath)) {
    throw new Error(`Predictions file does not exist: ${input.predictionsPath}`);
  }
  const content = readFileSync(input.predictionsPath, "utf8");
  const rows: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    rows.push(JSON.parse(line) as Record<string, unknown>);
  }
  if (rows.length === 0) {
    throw new Error(`Predictions file is empty: ${input.predictionsPath}`);
  }
  const matchingRow = rows.find((row) => row.instance_id === input.instanceId);
  if (matchingRow === undefined) {
    throw new Error(`Predictions file does not contain instance ${input.instanceId}: ${input.predictionsPath}`);
  }
  readRequiredPredictionString(matchingRow, "instance_id");
  readRequiredPredictionString(matchingRow, "model_name_or_path");
  readRequiredPredictionString(matchingRow, "model_patch");
}

function readAndValidateWorkspaceBaselineReport(input: {
  reportPath: string;
  expectedSourceBaseCommit: string;
}): SweWorkspaceBaselineReport {
  if (!existsSync(input.reportPath)) {
    throw new Error(`workspace baseline report does not exist: ${input.reportPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(input.reportPath, "utf8"));
  } catch (error) {
    throw new Error(
      `workspace baseline report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = asRecord(parsed);
  if (record?.schemaVersion !== 1) {
    throw new Error(`workspace baseline report has unsupported schemaVersion: ${String(record?.schemaVersion)}`);
  }
  const status = record?.status;
  if (status !== "captured" && status !== "failed") {
    throw new Error(`workspace baseline report has invalid status: ${String(status)}`);
  }
  if (record?.sourceBaseCommit !== input.expectedSourceBaseCommit) {
    throw new Error(
      `workspace baseline source mismatch: expected ${input.expectedSourceBaseCommit}, got ${String(record?.sourceBaseCommit)}`,
    );
  }
  const stages = parseWorkspacePatchStages(record?.stages);
  const report: SweWorkspaceBaselineReport = {
    schemaVersion: 1,
    status,
    sourceBaseCommit: input.expectedSourceBaseCommit,
    ...(typeof record.baselineCommit === "string" ? { baselineCommit: record.baselineCommit } : {}),
    ...(typeof record.baselineTreeSha === "string" ? { baselineTreeSha: record.baselineTreeSha } : {}),
    excludedTransientPaths: parseStringArray(record.excludedTransientPaths, "excludedTransientPaths"),
    unsupportedPaths: parseStringArray(record.unsupportedPaths, "unsupportedPaths"),
    stages,
    ...(typeof record.failureStage === "string" ? { failureStage: record.failureStage } : {}),
    ...(typeof record.failureMessage === "string" ? { failureMessage: record.failureMessage } : {}),
  };
  if (status === "failed") {
    if (!stages.some((stage) => stage.status === "failed")) {
      throw new Error("failed workspace baseline report must identify a failed stage");
    }
    return report;
  }
  if (
    report.baselineCommit === undefined ||
    report.baselineTreeSha === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(report.baselineCommit) ||
    !/^[0-9a-f]{40,64}$/u.test(report.baselineTreeSha)
  ) {
    throw new Error("captured workspace baseline report is missing valid commit or tree hashes");
  }
  if (report.unsupportedPaths.length > 0) {
    throw new Error("captured workspace baseline report contains unsupported filesystem entries");
  }
  if (!stages.some((stage) => stage.name === "publish_baseline" && stage.status === "passed")) {
    throw new Error("captured workspace baseline report must include a passed publish_baseline stage");
  }
  return report;
}

function readAndValidateWorkspacePatchReport(input: {
  reportPath: string;
  patchPath: string;
  expectedSourceBaseCommit: string;
  expectedBaselineCommit: string;
}): SweWorkspacePatchReport {
  if (!existsSync(input.reportPath)) {
    throw new Error(`workspace patch report does not exist: ${input.reportPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(input.reportPath, "utf8"));
  } catch (error) {
    throw new Error(
      `workspace patch report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = asRecord(parsed);
  const validation = asRecord(record?.validation);
  const status = record?.status;
  if (record?.schemaVersion !== 1) {
    throw new Error(`workspace patch report has unsupported schemaVersion: ${String(record?.schemaVersion)}`);
  }
  if (status !== "produced" && status !== "empty" && status !== "failed") {
    throw new Error(`workspace patch report has invalid status: ${String(status)}`);
  }
  if (record?.sourceBaseCommit !== input.expectedSourceBaseCommit) {
    throw new Error(
      `workspace patch source mismatch: expected ${input.expectedSourceBaseCommit}, got ${String(record?.sourceBaseCommit)}`,
    );
  }
  if (record?.baselineCommit !== input.expectedBaselineCommit) {
    throw new Error(
      `workspace patch report baseline mismatch: expected ${input.expectedBaselineCommit}, got ${String(record?.baselineCommit)}`,
    );
  }
  if (!(Number.isInteger(record?.kestrelExitCode) && Number.isInteger(record?.patchBytes) ) || Number(record?.patchBytes) < 0) {
    throw new Error("workspace patch report has invalid exit-code or patch-byte fields");
  }
  const changedPaths = parseWorkspacePatchChanges(record?.changedPaths);
  const excludedTransientPaths = parseStringArray(record?.excludedTransientPaths, "excludedTransientPaths");
  const unsupportedPaths = parseStringArray(record?.unsupportedPaths, "unsupportedPaths");
  const stages = parseWorkspacePatchStages(record?.stages);
  if (typeof validation?.applies !== "boolean" || typeof validation?.treeMatches !== "boolean") {
    throw new Error("workspace patch report has invalid validation fields");
  }
  const report: SweWorkspacePatchReport = {
    schemaVersion: 1,
    status,
    sourceBaseCommit: input.expectedSourceBaseCommit,
    baselineCommit: input.expectedBaselineCommit,
    kestrelExitCode: Number(record.kestrelExitCode),
    patchBytes: Number(record.patchBytes),
    ...(typeof record.patchSha256 === "string" ? { patchSha256: record.patchSha256 } : {}),
    ...(typeof record.targetTreeSha === "string" ? { targetTreeSha: record.targetTreeSha } : {}),
    changedPaths,
    excludedTransientPaths,
    unsupportedPaths,
    stages,
    validation: {
      applies: validation.applies,
      treeMatches: validation.treeMatches,
    },
    ...(typeof record.failureStage === "string" ? { failureStage: record.failureStage } : {}),
    ...(typeof record.failureMessage === "string" ? { failureMessage: record.failureMessage } : {}),
  };

  if (status === "failed") {
    if (existsSync(input.patchPath)) {
      throw new Error("failed workspace patch report must not leave model.patch behind");
    }
    if (!stages.some((stage) => stage.status === "failed")) {
      throw new Error("failed workspace patch report must identify a failed stage");
    }
    return report;
  }
  if (!(report.validation.applies && report.validation.treeMatches)) {
    throw new Error("successful workspace patch report must contain successful patch and tree validation");
  }
  if (!stages.some((stage) => stage.name === "validate_patch" && stage.status === "passed")) {
    throw new Error("successful workspace patch report must include a passed validate_patch stage");
  }
  if (!existsSync(input.patchPath)) {
    throw new Error(`workspace patch report references a missing patch: ${input.patchPath}`);
  }
  const patch = readFileSync(input.patchPath);
  if (patch.length !== report.patchBytes) {
    throw new Error(`workspace patch byte mismatch: report=${report.patchBytes}, actual=${patch.length}`);
  }
  if (report.targetTreeSha === undefined || !/^[0-9a-f]{40,64}$/u.test(report.targetTreeSha)) {
    throw new Error("workspace patch report is missing a valid target tree hash");
  }
  if (status === "empty") {
    if (patch.length !== 0 || changedPaths.length !== 0 || report.patchSha256 !== undefined) {
      throw new Error("empty workspace patch report contradicts its patch artifact");
    }
    return report;
  }
  if (patch.length === 0 || changedPaths.length === 0) {
    throw new Error("produced workspace patch report must contain a non-empty patch and changed paths");
  }
  const actualSha256 = createHash("sha256").update(patch).digest("hex");
  if (report.patchSha256 !== actualSha256) {
    throw new Error(`workspace patch SHA-256 mismatch: report=${String(report.patchSha256)}, actual=${actualSha256}`);
  }
  return report;
}

function parseWorkspacePatchChanges(value: unknown): SweWorkspacePatchReport["changedPaths"] {
  if (!Array.isArray(value)) {
    throw new Error("workspace patch report changedPaths must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    const status = record?.status;
    if (
      typeof record?.path !== "string" ||
      (status !== "A" && status !== "M" && status !== "D" && status !== "T")
    ) {
      throw new Error(`workspace patch report changedPaths[${index}] is invalid`);
    }
    return { path: record.path, status };
  });
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`workspace patch report ${field} must be a string array`);
  }
  return value as string[];
}

function parseWorkspacePatchStages(value: unknown): SweWorkspacePatchReport["stages"] {
  if (!Array.isArray(value)) {
    throw new Error("workspace patch report stages must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    const status = record?.status;
    if (typeof record?.name !== "string" || (status !== "passed" && status !== "failed")) {
      throw new Error(`workspace patch report stages[${index}] is invalid`);
    }
    if (record.message !== undefined && typeof record.message !== "string") {
      throw new Error(`workspace patch report stages[${index}].message is invalid`);
    }
    return {
      name: record.name,
      status,
      ...(typeof record.message === "string" ? { message: record.message } : {}),
    };
  });
}

export function assertKestrelJobCompleted(jobOutputPath: string): void {
  const summary = readKestrelJobStatus(jobOutputPath);
  if (summary.terminalEventType !== "job.completed" || summary.status !== "COMPLETED") {
    throw new Error(
      `Kestrel job did not reach terminal COMPLETED state (terminalEventType=${String(summary.terminalEventType)}, status=${String(summary.status)}).`,
    );
  }
}

function readKestrelJobStatus(jobOutputPath: string): KestrelJobStatusSummary {
  if (!existsSync(jobOutputPath)) {
    throw new Error(`Kestrel run did not produce job output: ${jobOutputPath}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(jobOutputPath, "utf8"));
  } catch (error) {
    throw new Error(`Kestrel job output is not valid JSON: ${jobOutputPath}. ${error instanceof Error ? error.message : String(error)}`);
  }

  const output = asRecord(parsed);
  const job = asRecord(output?.job);
  const waitFor = asRecord(job?.waitFor);
  const waitMetadata = asRecord(waitFor?.metadata);
  return {
    terminalEventType: typeof output?.terminalEventType === "string" ? output.terminalEventType : undefined,
    status: typeof job?.status === "string" ? job.status : undefined,
    waitEventType: typeof waitFor?.eventType === "string" ? waitFor.eventType : undefined,
    waitReason: typeof waitMetadata?.reason === "string" ? waitMetadata.reason : undefined,
  };
}

function loadInstance(input: {
  options: SweVerifiedBenchOptions;
  deps: RuntimeDeps;
  instanceId: string;
}): SweVerifiedInstance {
  if (input.options.instancesJsonl !== undefined) {
    return loadInstanceFromJsonl(input.options.instancesJsonl, input.instanceId);
  }

  const loader = input.deps.spawn(resolvePythonBin(input.options, input.deps.env), [
    "-c",
    [
      "import json, sys",
      "from datasets import load_dataset",
      "dataset, split, instance_id = sys.argv[1:4]",
      "rows = load_dataset(dataset, split=split)",
      "for row in rows:",
      "    if row.get('instance_id') == instance_id:",
      "        print(json.dumps(row))",
      "        raise SystemExit(0)",
      "raise SystemExit(f'instance not found: {instance_id}')",
    ].join("\n"),
    input.options.dataset,
    input.options.split,
    input.instanceId,
  ], {
    cwd: input.deps.cwd,
    env: input.deps.env,
  });
  if (!spawnPassed(loader)) {
    throw new Error(`Unable to load SWE Verified instance ${input.instanceId}.\n${renderSpawnOutput(loader)}`);
  }
  return sanitizeSweVerifiedInstance(JSON.parse(loader.stdout.toString("utf8")) as Record<string, unknown>);
}

function loadInstanceFromJsonl(filePath: string, instanceId: string): SweVerifiedInstance {
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    const row = JSON.parse(line) as Record<string, unknown>;
    if (row.instance_id === instanceId) {
      return sanitizeSweVerifiedInstance(stripOracleFields(row));
    }
  }
  throw new Error(`Instance ${instanceId} not found in ${filePath}`);
}

function stripOracleFields(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !ORACLE_FIELDS.has(key)));
}

function writePrediction(input: {
  predictionsPath: string;
  instanceId: string;
  modelName: string;
  modelPatch: string;
}): void {
  mkdirSync(path.dirname(input.predictionsPath), { recursive: true });
  writeFileSync(
    input.predictionsPath,
    JSON.stringify({
      instance_id: input.instanceId,
      model_name_or_path: input.modelName,
      model_patch: input.modelPatch,
    }) + "\n",
    "utf8",
  );
}

function resolvePythonBin(options: SweVerifiedBenchOptions, env: NodeJS.ProcessEnv): string {
  return options.pythonBin ?? env.KESTREL_SWE_PYTHON ?? "python3";
}

function resolveNow(deps: RuntimeDeps): Date {
  return deps.now?.() ?? new Date();
}

function readRequiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`SWE Verified instance is missing required string field: ${key}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) === false) {
    return ;
  }
  const values = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0);
  return values.length > 0 ? [...new Set(values)] : [];
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function readTrimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function readRequiredPredictionString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Predictions row is missing required string field: ${key}`);
  }
  return value;
}

function writeLatestAttemptMetadata(input: {
  cwd: string;
  instanceRoot: string;
  attemptId: string;
  attemptDir: string;
  predictionsPath: string;
  jobInputPath: string;
  jobOutputPath: string;
  kestrelOutputPath: string;
  now: Date;
}): void {
  mkdirSync(input.instanceRoot, { recursive: true });
  const latestPath = path.join(input.instanceRoot, "latest.json");
  const metadata: SweVerifiedLatestAttemptMetadata = {
    attempt_id: input.attemptId,
    attempt_dir: path.relative(input.cwd, input.attemptDir),
    predictions_path: path.relative(input.cwd, input.predictionsPath),
    job_input_path: path.relative(input.cwd, input.jobInputPath),
    job_output_path: path.relative(input.cwd, input.jobOutputPath),
    kestrel_output_path: path.relative(input.cwd, input.kestrelOutputPath),
    updated_at: input.now.toISOString(),
  };
  writeFileSync(latestPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
}

function updateLatestAttemptMetadata(input: {
  cwd: string;
  instanceRoot: string;
  now: Date;
  patchPath: string;
  patchExists: boolean;
  terminalStatus: string;
  evaluatorRan: boolean;
  evaluation?: SweVerifiedEvaluationResult | undefined;
  kestrelJobSummary?: KestrelJobStatusSummary | undefined;
  patchReport?: SweWorkspacePatchReport | undefined;
  patchReportPath?: string | undefined;
  baselineReport?: SweWorkspaceBaselineReport | undefined;
  baselineReportPath?: string | undefined;
}): void {
  const latestPath = path.join(input.instanceRoot, "latest.json");
  const previous = readLatestAttemptMetadata(latestPath);
  if (previous === undefined) {
    return;
  }
  const modelPatchBytes = input.patchExists && existsSync(input.patchPath)
    ? Buffer.byteLength(readFileSync(input.patchPath))
    : 0;
  const metadata: SweVerifiedLatestAttemptMetadata = {
    ...previous,
    terminal_status: input.terminalStatus,
    model_patch_exists: input.patchExists,
    model_patch_bytes: modelPatchBytes,
    evaluator_ran: input.evaluatorRan,
    ...(input.kestrelJobSummary?.status !== undefined
      ? { kestrel_job_status: input.kestrelJobSummary.status }
      : {}),
    ...(input.kestrelJobSummary?.waitEventType !== undefined
      ? { kestrel_wait_event_type: input.kestrelJobSummary.waitEventType }
      : {}),
    ...(input.kestrelJobSummary?.waitReason !== undefined
      ? { kestrel_wait_reason: input.kestrelJobSummary.waitReason }
      : {}),
    ...(input.patchReport !== undefined
      ? {
          kestrel_process_exit_code: input.patchReport.kestrelExitCode,
          workspace_patch_status: input.patchReport.status,
          workspace_patch_changed_paths: input.patchReport.changedPaths.length,
          workspace_patch_excluded_transient_paths: input.patchReport.excludedTransientPaths.length,
          ...(input.patchReport.patchSha256 !== undefined
            ? { workspace_patch_sha256: input.patchReport.patchSha256 }
            : {}),
        }
      : {}),
    ...(input.patchReportPath !== undefined
      ? { workspace_patch_report_path: path.relative(input.cwd, input.patchReportPath) }
      : {}),
    ...(input.baselineReport?.baselineCommit !== undefined
      ? {
          workspace_baseline_commit: input.baselineReport.baselineCommit,
          ...(input.baselineReport.baselineTreeSha !== undefined
            ? { workspace_baseline_tree_sha: input.baselineReport.baselineTreeSha }
            : {}),
        }
      : {}),
    ...(input.baselineReportPath !== undefined
      ? { workspace_baseline_report_path: path.relative(input.cwd, input.baselineReportPath) }
      : {}),
    ...(input.evaluation !== undefined
      ? {
          evaluator_status: input.evaluation.status,
          ...(input.evaluation.report.resolved_instances !== undefined
            ? { evaluator_resolved_instances: input.evaluation.report.resolved_instances }
            : {}),
          ...(input.evaluation.report.unresolved_instances !== undefined
            ? { evaluator_unresolved_instances: input.evaluation.report.unresolved_instances }
            : {}),
          evaluator_report_path: path.relative(input.cwd, input.evaluation.reportPath),
        }
      : {}),
    updated_at: input.now.toISOString(),
  };
  writeFileSync(latestPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
}

function readLatestAttemptMetadata(filePath: string): SweVerifiedLatestAttemptMetadata | undefined {
  if (!existsSync(filePath)) {
    return ;
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as SweVerifiedLatestAttemptMetadata;
}

function assertSafeInstanceId(instanceId: string): void {
  if (!/^[a-zA-Z0-9_.-]+__[a-zA-Z0-9_.-]+-\d+$/u.test(instanceId)) {
    throw new Error(`Unsafe SWE Verified instance id: ${instanceId}`);
  }
}

function assertSafeRunId(runId: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/u.test(runId)) {
    throw new Error(`Unsafe SWE Verified run id: ${runId}`);
  }
}

function assertSafeRepo(repo: string): void {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repo)) {
    throw new Error(`Unsafe SWE Verified repo: ${repo}`);
  }
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
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function spawnPassed(result: SpawnSyncReturns<Buffer>): boolean {
  return result.error === undefined && result.status === 0;
}

function renderSpawnOutput(result: SpawnSyncReturns<Buffer>): string {
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr.toString("utf8");
  return [stdout, stderr].filter((part) => part.length > 0).join("\n");
}

function formatCommand(binary: string, args: string[]): string {
  return [binary, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./:=@+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function helpText(): string {
  return [
    "Usage: pnpm run bench:swe -- <mode> [options]",
    "",
    "Modes:",
    "  preflight        Check local SWE-bench evaluator prerequisites.",
    "  run              Generate one prediction with Kestrel, then evaluate that one instance.",
    "  evaluate         Evaluate an existing predictions.jsonl for one instance.",
    "  list             List recorded attempts for one instance.",
    "",
    "Options:",
    "  --dataset <name>           Hugging Face dataset name. Default: princeton-nlp/SWE-bench_Verified",
    "  --split <name>             Dataset split. Default: test",
    "  --instance-id <id>         SWE-bench instance id to run. Required for run/evaluate/list.",
    "  --instances-jsonl <path>   Optional local instance rows for offline or dry-run prompt rendering.",
    "  --predictions-path <path>  Output predictions path for run; required input path for evaluate.",
    "  --python-bin <path>        Python interpreter with swebench installed. Env: KESTREL_SWE_PYTHON.",
    "  --output-root <path>       Run artifact root. Default: runs/swe-verified",
    "  --run-id <id>              Explicit attempt/evaluation run id. Default: generated UTC attempt id.",
    "  --max-workers <n>          Official evaluator worker count. Default: 1",
    "  --timeout <seconds>        Official evaluator timeout. Default: 1800",
    "  --dry-run                  Print commands and write job input without starting Kestrel/evaluator.",
    "",
  ].join("\n");
}

class HelpRequested extends Error {}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadBenchmarkDotEnv(process.cwd(), process.env);
  void runSweVerifiedBench(process.argv.slice(2), {
    spawn: spawnSync,
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => new Date(),
  }).then((code) => {
    process.exitCode = code;
  });
}
