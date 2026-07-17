import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSweVerifiedJobInputContract,
  buildSweVerifiedAttemptPaths,
  buildSweVerifiedEvaluationArgs,
  buildSweVerifiedJobInput,
  formatSweVerifiedAttemptId,
  parseSweVerifiedBenchArgs,
  resolveSweVerifiedModelSelection,
  runSweVerifiedBench,
  sanitizeSweVerifiedIssueText,
  sanitizeSweVerifiedInstance,
  shouldIncludeSweVerifiedRunnerSourceFile,
} from "../../scripts/swe-verified-bench.js";

const TEST_SOURCE_BASE_COMMIT = "d16bfe05a744909de4b27f5875fe0d4ed41ce607";
const TEST_PREPARED_BASELINE_COMMIT = "b".repeat(40);
const TEST_PREPARED_BASELINE_TREE = "c".repeat(40);

function isSwePrepareImagesCall(command: string, args: readonly string[]): boolean {
  return command === "python3" && String(args[0]).endsWith("swe-verified-prepare-images.py");
}

function isSweRunEvaluationCall(command: string, args: readonly string[]): boolean {
  return command === "python3" && String(args[0]).endsWith("swe-verified-run-evaluation.py");
}

function isSweBaselineCaptureCall(command: string, args: readonly string[]): boolean {
  const modeIndex = args.indexOf("--mode");
  return command === "docker" && args[0] === "run" && modeIndex >= 0 && args[modeIndex + 1] === "capture";
}

test("swe verified bench defaults to one verified instance at a time", () => {
  const options = parseSweVerifiedBenchArgs(["--instance-id", "astropy__astropy-12907"]);

  assert.deepEqual(options, {
    mode: "run",
    dataset: "princeton-nlp/SWE-bench_Verified",
    split: "test",
    instanceId: "astropy__astropy-12907",
    runId: undefined,
    instancesJsonl: undefined,
    predictionsPath: undefined,
    pythonBin: undefined,
    outputRoot: "runs/swe-verified",
    dryRun: false,
    maxWorkers: 1,
    timeout: 1800,
  });
});

test("swe verified bench accepts an explicit Python interpreter", () => {
  const options = parseSweVerifiedBenchArgs([
    "--instance-id",
    "astropy__astropy-12907",
    "--python-bin",
    ".venv/bin/python",
  ]);

  assert.equal(options.pythonBin, ".venv/bin/python");
});

test("swe verified bench resolves runtime model overrides without label drift", () => {
  assert.deepEqual(resolveSweVerifiedModelSelection({ OPENROUTER_API_KEY: "sk-test" }), {
    modelName: "z-ai/glm-5.2",
    runtimeModelName: "z-ai/glm-5.2",
  });
  assert.deepEqual(resolveSweVerifiedModelSelection({
    OPENROUTER_API_KEY: "sk-test",
    OPENROUTER_MODEL: "minimax/minimax-m3",
  }), {
    modelName: "minimax/minimax-m3",
    runtimeModelName: "minimax/minimax-m3",
  });
  assert.throws(
    () => resolveSweVerifiedModelSelection({
      OPENROUTER_API_KEY: "sk-test",
      KESTREL_SWE_MODEL_NAME: "minimax/minimax-m3",
      OPENROUTER_MODEL: "openai/gpt-5.4-mini",
    }),
    /Deprecated benchmark env KESTREL_SWE_MODEL_NAME/u,
  );
});

test("swe verified bench formats UTC-safe attempt ids", () => {
  assert.equal(
    formatSweVerifiedAttemptId(new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789))),
    "20260602T123456789Z",
  );
});

test("swe verified bench builds attempt-local paths under a stable instance root", () => {
  assert.deepEqual(
    buildSweVerifiedAttemptPaths({
      cwd: "/tmp/workspace",
      outputRoot: "runs/swe-verified",
      instanceId: "astropy__astropy-12907",
      attemptId: "20260602T123456789Z",
    }),
    {
      instanceKey: "kestrel-swe-astropy__astropy-12907",
      instanceRoot: "/tmp/workspace/runs/swe-verified/kestrel-swe-astropy__astropy-12907",
      attemptsRoot: "/tmp/workspace/runs/swe-verified/kestrel-swe-astropy__astropy-12907/attempts",
      attemptDir: "/tmp/workspace/runs/swe-verified/kestrel-swe-astropy__astropy-12907/attempts/20260602T123456789Z",
    },
  );
});

test("swe verified bench exposes a package script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.["bench:swe"], "bash scripts/bench-swe.sh");
  assert.equal(packageJson.scripts?.swe, "bash scripts/swe.sh");
});

test("swe verified bench exposes a passing regression script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const wrapper = readFileSync(path.join(process.cwd(), "scripts", "swe-passing.sh"), "utf8");

  assert.equal(packageJson.scripts?.["swe:passing"], "bash scripts/swe-passing.sh");
  assert.match(wrapper, /run_swe_passing_case pytest-dev__pytest-10051 "\$\{extra_args\[@\]\}"/u);
  assert.match(wrapper, /pnpm run swe "\$\{instance_id\}" "\$@"/u);
});

test("swe verified bench exposes a convenience helper that loads env and defaults the venv", () => {
  const wrapper = readFileSync(path.join(process.cwd(), "scripts", "swe.sh"), "utf8");

  assert.match(wrapper, /bash scripts\/bench-swe\.sh run --instance-id "\$\{instance_id\}"/u);
  assert.match(wrapper, /caller_openrouter_model="\$\{OPENROUTER_MODEL-\}"/u);
  assert.match(wrapper, /export OPENROUTER_MODEL="\$\{caller_openrouter_model\}"/u);
  assert.match(wrapper, /unset OPENROUTER_MODEL/u);
  assert.doesNotMatch(wrapper, /KESTREL_SWE_MODEL_NAME/u);
});

test("swe verified bench shared wrapper loads env and defaults the venv", () => {
  const wrapper = readFileSync(path.join(process.cwd(), "scripts", "bench-swe.sh"), "utf8");

  assert.match(wrapper, /\. "\$\{REPO_ROOT\}\/\.env"/u);
  assert.match(wrapper, /export CI="\$\{CI:-true\}"/u);
  assert.match(wrapper, /caller_openrouter_model="\$\{OPENROUTER_MODEL-\}"/u);
  assert.match(wrapper, /export OPENROUTER_MODEL="\$\{caller_openrouter_model\}"/u);
  assert.match(wrapper, /unset OPENROUTER_MODEL/u);
  assert.doesNotMatch(wrapper, /KESTREL_SWE_MODEL_NAME/u);
  assert.doesNotMatch(wrapper, /KESTREL_TBENCH_MODEL/u);
  assert.match(wrapper, /KESTREL_SWE_PYTHON="\$\{KESTREL_SWE_PYTHON:-\.venv-swebench\/bin\/python\}"/u);
  assert.match(wrapper, /HF_HOME="\$\{HF_HOME:-\$\{TMPDIR:-\/tmp\}\/kestrel-hf\}"/u);
  assert.match(wrapper, /HF_HUB_CACHE="\$\{HF_HUB_CACHE:-\$\{HF_HOME\}\/hub\}"/u);
  assert.match(wrapper, /DOCKER_CONFIG="\$\{DOCKER_CONFIG:-\$\{TMPDIR:-\/tmp\}\/kestrel-docker\}"/u);
  assert.match(wrapper, /DOCKER_HOST="unix:\/\/\$\{HOME\}\/\.docker\/run\/docker\.sock"/u);
  assert.match(wrapper, /node --import tsx scripts\/swe-verified-bench\.ts "\$@"/u);
});

test("swe verified bench requires an instance id for run and evaluate modes", () => {
  assert.throws(() => parseSweVerifiedBenchArgs([]), /--instance-id is required/u);
  assert.throws(() => parseSweVerifiedBenchArgs(["evaluate"]), /--instance-id is required/u);
});

test("swe verified bench strips oracle fields before building the Kestrel prompt", () => {
  const sanitized = sanitizeSweVerifiedInstance({
    instance_id: "astropy__astropy-12907",
    repo: "astropy/astropy",
    base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
    problem_statement: "Fix separability.",
    hints_text: "Look at separable.py.",
    patch: "diff --git oracle",
    test_patch: "diff --git tests",
    FAIL_TO_PASS: ["test_new_behavior"],
    PASS_TO_PASS: ["test_existing_behavior"],
  });

  assert.deepEqual(sanitized, {
    instance_id: "astropy__astropy-12907",
    repo: "astropy/astropy",
    base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
    problem_statement: "Fix separability.",
    hints_text: "Look at separable.py.",
  });

  const jobInput = buildSweVerifiedJobInput({
    instance: sanitized,
    dataset: "custom/SWE-bench_Verified",
    workspaceRoot: "/tmp/workspace",
    modelName: "kestrel",
  });
  assert.deepEqual((jobInput as { profile: Record<string, unknown> }).profile, {
    id: "swe-verified",
    label: "SWE Verified",
    agent: "reference-react",
    sessionPrefix: "swe-verified",
    defaultInteractionMode: "build",
    defaultActSubmode: "full_auto",
    devShell: {
      enabled: true,
      envMode: "inherit",
    },
    guardrails: {
      maxStepsPerRun: 2500,
      maxToolCallsPerRun: 1000,
      maxModelCallsPerRun: 500,
      maxStepVisits: 750,
    },
    toolAllowlist: [
      "FinalizeAnswer",
      "effect_result_lookup",
      "fs.read_text",
      "repo.trace",
      "fs.write_text",
      "fs.replace_text",
      "exec_command",
    ],
  });
  assert.deepEqual((jobInput as { turn: Record<string, unknown> }).turn.interactionMode, "build");
  assert.deepEqual((jobInput as { turn: Record<string, unknown> }).turn.actSubmode, "full_auto");
  const turn = (jobInput as { turn: Record<string, unknown> }).turn;
  assert.equal(turn.message, "Resolve SWE-bench Verified instance astropy__astropy-12907 in this checked-out repository.");
  const metadata = turn.metadata as Record<string, unknown>;
  const benchmark = metadata.benchmark as Record<string, unknown>;
  assert.deepEqual(benchmark.context, {
    source: "swe-verified",
    instanceId: "astropy__astropy-12907",
    problemStatement: "Fix separability.",
    hintsText: "Look at separable.py.",
    workspaceRoot: "/testbed",
  });
  const serialized = JSON.stringify(jobInput);
  assert.match(serialized, /Fix separability/u);
  assert.match(serialized, /custom\/SWE-bench_Verified/u);
  assert.doesNotMatch(serialized, /You are running inside the SWE-bench testbed at \/testbed/u);
  assert.doesNotMatch(serialized, /Use dev\.shell\.run for focused validation/u);
  assert.doesNotMatch(serialized, /"dev\.shell\.run"/u);
  assert.match(serialized, /"exec_command"/u);
  assert.doesNotMatch(serialized, /Treat issue hints and proposed causes as hypotheses/u);
  assert.doesNotMatch(serialized, /preserve the observed emitted semantics/u);
  assert.doesNotMatch(serialized, /Validate the exact emitted value or behavior at risk/u);
  assert.doesNotMatch(serialized, /Before editing, find the relevant source file and existing tests for that behavior/u);
  assert.doesNotMatch(serialized, /Run the focused existing test before finalizing/u);
  assert.doesNotMatch(serialized, /find the repo-native test command and try that/u);
  assert.doesNotMatch(serialized, /Use a reproduction script only when no relevant test exists/u);
  assert.doesNotMatch(serialized, /Keep the patch focused\. Do not remove unrelated tests/u);
  assert.doesNotMatch(serialized, /Finalize only after the relevant check passes/u);
  assert.doesNotMatch(serialized, /data\.sweValidation/u);
  assert.doesNotMatch(serialized, /PASS_TO_PASS/u);
  assert.doesNotMatch(serialized, /Run the focused test or reproduction/u);
  assert.doesNotMatch(serialized, /discovered relevant tests/u);
  assert.doesNotMatch(serialized, /oracle/u);
  assert.doesNotMatch(serialized, /FAIL_TO_PASS/u);
});

test("swe verified bench configures explicit runtime model for reference-react agent loop", () => {
  const jobInput = buildSweVerifiedJobInput({
    instance: {
      instance_id: "astropy__astropy-12907",
      repo: "astropy/astropy",
      base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
      problem_statement: "Fix separability.",
    },
    dataset: "custom/SWE-bench_Verified",
    workspaceRoot: "/tmp/workspace",
    modelName: "minimax/minimax-m3",
    runtimeModelName: "minimax/minimax-m3",
  });
  const profile = (jobInput as { profile: Record<string, unknown> }).profile;

  assert.equal(profile.modelProvider, "openrouter");
  assert.equal(profile.model, "minimax/minimax-m3");
  assert.deepEqual(profile.agentStageConfig, {
    modelByStage: {
      "agent.loop": "minimax/minimax-m3",
    },
  });
  assertSweVerifiedJobInputContract(jobInput);
});

test("swe verified issue text removes HTML comments system details and long pytest traces", () => {
  const trace = [
    "```",
    "Traceback (most recent call last):",
    ...Array.from({ length: 140 }, (_, index) =>
      `  File "/tmp/site-packages/_pytest/pluginmanager.py", line ${index}, in load_setuptools_entrypoints`
    ),
    "ValueError: Plugin already registered under a different name: pytest_astropy",
    "```",
  ].join("\n");

  const sanitized = sanitizeSweVerifiedIssueText(
    [
      "<!-- noise -->",
      "### Description",
      "The repro fails.",
      "### System Details",
      "platform: macOS",
      "numpy: 1.26",
      "### Expected behavior",
      "The function should preserve dimensions.",
      trace,
      "Useful hint: inspect the separability helper.",
    ].join("\n\n"),
    { stripLongPytestTraces: true },
  );

  assert.match(sanitized, /The repro fails/u);
  assert.match(sanitized, /The function should preserve dimensions/u);
  assert.match(sanitized, /Useful hint: inspect the separability helper/u);
  assert.doesNotMatch(sanitized, /noise/u);
  assert.doesNotMatch(sanitized, /System Details/u);
  assert.doesNotMatch(sanitized, /Plugin already registered/u);
  assert.doesNotMatch(sanitized, /_pytest/u);
});

test("swe verified issue text keeps repro code and useful hints", () => {
  const sanitized = sanitizeSweVerifiedIssueText(
    [
      "### Reproducer",
      "```python",
      "from sympy import symbols",
      "x = symbols('x')",
      "assert str(x) == 'x'",
      "```",
      "Hint: check the parser path before editing shared regex helpers.",
    ].join("\n"),
    { stripLongPytestTraces: true },
  );

  assert.match(sanitized, /```python/u);
  assert.match(sanitized, /from sympy import symbols/u);
  assert.match(sanitized, /Hint: check the parser path/u);
});

test("swe verified bench rejects non-build turn mode", () => {
  const jobInput = buildSweVerifiedJobInput({
    instance: {
      instance_id: "astropy__astropy-12907",
      repo: "astropy/astropy",
      base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
      problem_statement: "Fix separability.",
    },
    dataset: "custom/SWE-bench_Verified",
    workspaceRoot: "/tmp/workspace",
    modelName: "kestrel",
  });
  const turn = (jobInput as { turn: Record<string, unknown> }).turn;

  assert.throws(
    () => assertSweVerifiedJobInputContract({ ...jobInput, turn: { ...turn, interactionMode: "act" } }),
    /canonical build interactionMode/u,
  );
  assert.throws(
    () => assertSweVerifiedJobInputContract({ ...jobInput, turn: { ...turn, actSubmode: "safe" } }),
    /full_auto actSubmode/u,
  );
});

test("swe verified bench rejects shell allowlists without enabled dev shell", () => {
  const jobInput = buildSweVerifiedJobInput({
    instance: {
      instance_id: "astropy__astropy-12907",
      repo: "astropy/astropy",
      base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
      problem_statement: "Fix separability.",
    },
    dataset: "custom/SWE-bench_Verified",
    workspaceRoot: "/tmp/workspace",
    modelName: "kestrel",
  });
  const profile = (jobInput as { profile: Record<string, unknown> }).profile;
  const profileWithoutDevShell = { ...profile };
  delete profileWithoutDevShell.devShell;

  assert.throws(
    () => assertSweVerifiedJobInputContract({ ...jobInput, profile: profileWithoutDevShell }),
    /must enable devShell/u,
  );
  assert.throws(
    () => assertSweVerifiedJobInputContract({ ...jobInput, profile: { ...profile, devShell: { enabled: false } } }),
    /must enable devShell/u,
  );
});

test("swe verified bench rejects model labels that do not configure the agent loop", () => {
  const jobInput = buildSweVerifiedJobInput({
    instance: {
      instance_id: "astropy__astropy-12907",
      repo: "astropy/astropy",
      base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
      problem_statement: "Fix separability.",
    },
    dataset: "custom/SWE-bench_Verified",
    workspaceRoot: "/tmp/workspace",
    modelName: "minimax/minimax-m3",
    runtimeModelName: "minimax/minimax-m3",
  });
  const profile = (jobInput as { profile: Record<string, unknown> }).profile;

  assert.throws(
    () => assertSweVerifiedJobInputContract({
      ...jobInput,
      profile: {
        ...profile,
        agentStageConfig: undefined,
      },
    }),
    /must match agentStageConfig\.modelByStage/u,
  );
  assert.throws(
    () => assertSweVerifiedJobInputContract({
      ...jobInput,
      profile: {
        ...profile,
        agentStageConfig: {
          modelByStage: {
            "agent.loop": "openai/gpt-5.4-mini",
          },
        },
      },
    }),
    /must match agentStageConfig\.modelByStage/u,
  );
});

test("swe verified bench builds official single-instance evaluation args", () => {
  const args = buildSweVerifiedEvaluationArgs({
    dataset: "princeton-nlp/SWE-bench_Verified",
    split: "test",
    instanceId: "astropy__astropy-12907",
    predictionsPath: "/tmp/predictions.jsonl",
    runId: "20260602T123456789Z",
    maxWorkers: 1,
    timeout: 1800,
  });

  assert.match(String(args[0]), /swe-verified-run-evaluation\.py$/u);
  assert.deepEqual(args.slice(1), [
    "--dataset_name",
    "princeton-nlp/SWE-bench_Verified",
    "--split",
    "test",
    "--predictions_path",
    "/tmp/predictions.jsonl",
    "--max_workers",
    "1",
    "--timeout",
    "1800",
    "--run_id",
    "20260602T123456789Z",
    "--instance_ids",
    "astropy__astropy-12907",
  ]);
});

test("swe verified bench dry-runs one local instance without exposing oracle fields", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
        hints_text: "Look at separable.py.",
        patch: "diff --git oracle",
        test_patch: "diff --git tests",
      }) + "\n",
      "utf8",
    );

    let stdout = "";
    const code = await runSweVerifiedBench(
      [
        "run",
        "--instance-id",
        "astropy__astropy-12907",
        "--instances-jsonl",
        instancesJsonl,
        "--dry-run",
      ],
      {
        spawn: (() => passedSpawn("")) as never,
        env: {
          HOME: tmp,
          KESTREL_SWE_PYTHON: "/existing/venv/bin/python",
          OPENROUTER_API_KEY: "sk-test",
          OPENROUTER_MODEL: "minimax/minimax-m3",
        },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789)),
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: () => true },
      },
    );

    assert.equal(code, 0);
    assert.match(stdout, /attempt=20260602T123456789Z/u);
    assert.match(stdout, /runtime-model-provider=openrouter runtime-model=minimax\/minimax-m3/u);
    assert.match(stdout, /git clone https:\/\/github\.com\/astropy\/astropy\.git/u);
    assert.match(stdout, /git -C .* checkout d16bfe05a744909de4b27f5875fe0d4ed41ce607/u);
    assert.match(stdout, /swe-verified-image-info\.py/u);
    assert.match(stdout, /swe-verified-prepare-images\.py/u);
    assert.match(stdout, /docker image inspect <swe-instance-image>/u);
    assert.match(stdout, /would run Kestrel inside Docker with \/testbed as the workspace/u);
    assert.doesNotMatch(stdout, /node .*bin\/kestrel\.js/u);
    assert.match(stdout, /\/existing\/venv\/bin\/python .*swe-verified-run-evaluation\.py/u);
    assert.match(stdout, /predictions\.jsonl/u);
    assert.doesNotMatch(stdout, /oracle/u);
    assert.doesNotMatch(stdout, /test_patch/u);

    const jobInputPath = path.join(
      tmp,
      "runs",
      "swe-verified",
      "kestrel-swe-astropy__astropy-12907",
      "attempts",
      "20260602T123456789Z",
      "job-input.json",
    );
    const jobInput = readFileSync(jobInputPath, "utf8");
    const parsedJobInput = JSON.parse(jobInput) as {
      profile: {
        modelProvider?: string;
        model?: string;
        agentStageConfig?: { modelByStage?: Record<string, string> };
      };
      turn: { metadata: { workspace: { workspaceRoot: string } } };
    };
    assert.match(jobInput, /Fix separability/u);
    assert.equal(parsedJobInput.profile.modelProvider, "openrouter");
    assert.equal(parsedJobInput.profile.model, "minimax/minimax-m3");
    assert.equal(parsedJobInput.profile.agentStageConfig?.modelByStage?.["agent.loop"], "minimax/minimax-m3");
    assert.equal(parsedJobInput.turn.metadata.workspace.workspaceRoot, "/testbed");
    assert.doesNotMatch(jobInput, /oracle/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench fails before cloning when deprecated SWE model env is present", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-model-conflict-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
      }) + "\n",
      "utf8",
    );

    const calls: Array<{ command: string; args: string[] }> = [];
    let stderr = "";
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-12907", "--instances-jsonl", instancesJsonl],
      {
        spawn: ((command: string, args: readonly string[]) => {
          calls.push({ command, args: [...args] });
          return passedSpawn("");
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: {
          HOME: tmp,
          OPENROUTER_API_KEY: "sk-test",
          KESTREL_SWE_MODEL_NAME: "minimax/minimax-m3",
          OPENROUTER_MODEL: "openai/gpt-5.4-mini",
        },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789)),
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 1);
    assert.match(stderr, /Deprecated benchmark env KESTREL_SWE_MODEL_NAME/u);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench dry-run can load an instance through the configured Python environment", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-dry-dataset-"));
  try {
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "psf__requests-2931", "--dry-run"],
      {
        spawn: ((command: string, args: readonly string[]) => {
          if (command === "/existing/venv/bin/python" && args[0] === "-c") {
            return passedSpawn(JSON.stringify({
              instance_id: "psf__requests-2931",
              repo: "psf/requests",
              base_commit: "5a87a8c0f1e2b6",
              problem_statement: "Fix requests behavior.",
              patch: "diff --git oracle",
              test_patch: "diff --git tests",
            }) + "\n");
          }
          return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: { HOME: tmp, KESTREL_SWE_PYTHON: "/existing/venv/bin/python", OPENROUTER_API_KEY: "sk-test" },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789)),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    assert.equal(code, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench preflight uses the configured Python environment", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const code = await runSweVerifiedBench(["preflight"], {
    spawn: ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      return passedSpawn("ok\n");
    }) as unknown as typeof import("node:child_process").spawnSync,
    env: { KESTREL_SWE_PYTHON: "/shared/venv/bin/python", OPENROUTER_API_KEY: "sk-test" },
    cwd: process.cwd(),
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(code, 0);
  assert.equal(calls[0]?.command, "/shared/venv/bin/python");
  assert.match(String(calls[0]?.args[0]), /swe-verified-run-evaluation\.py$/u);
  assert.deepEqual(calls[0]?.args.slice(1), ["--help"]);
  assert.equal(calls[1]?.command, "/shared/venv/bin/python");
  assert.deepEqual(calls[1]?.args, ["-c", "import datasets"]);
  assert.equal(calls[4]?.command, "/shared/venv/bin/python");
  assert.deepEqual(calls[4]?.args, ["-c", "import docker; docker.from_env().ping()"]);
});

test("swe verified bench creates attempt-local artifacts and writes one prediction", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-run-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
      }) + "\n",
      "utf8",
    );

    const calls: Array<{ command: string; args: string[] }> = [];
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-12907", "--instances-jsonl", instancesJsonl],
      {
        spawn: ((command: string, args: readonly string[]) => {
          calls.push({ command, args: [...args] });
          if (command === "git" && args[0] === "clone") {
            assert.equal(existsSync(path.dirname(String(args[2]))), true);
            return passedSpawn("cloned\n");
          }
          if (command === "git" && args[0] === "-C" && args[2] === "checkout") return passedSpawn("checked out\n");
          if (command === "python3" && String(args[0]).endsWith("swe-verified-image-info.py")) {
            return passedSpawn(JSON.stringify({
              instance_image_key: "sweb.eval.x86_64.astropy__astropy-12907:latest",
              platform: "linux/x86_64",
            }) + "\n");
          }
          if (isSwePrepareImagesCall(command, args)) return passedSpawn("images ok\n");
          if (command === "docker" && args[0] === "image" && args[1] === "inspect") return passedSpawn("image exists\n");
          if (command === "git" && args[0] === "ls-files") return passedSpawn("");
          if (command === "docker" && args[0] === "build") return passedSpawn("built\n");
          if (isSweBaselineCaptureCall(command, args)) {
            writeWorkspaceBaselineArtifacts(dockerAttemptDir(args));
            return passedSpawn("baseline captured\n");
          }
          if (command === "docker" && args[0] === "run") {
            const mount = String(args[args.indexOf("-v") + 1]);
            const attemptDir = mount.split(":")[0] as string;
            writeFileSync(path.join(attemptDir, "kestrel-output.txt"), "kestrel ok\n", "utf8");
            writeCompletedJobOutput(attemptDir);
            writeWorkspacePatchArtifacts(attemptDir, "diff --git a/example.py b/example.py\n");
            return passedSpawn("ran\n");
          }
          if (command === "git" && args[0] === "-C" && args[2] === "apply") return passedSpawn("applied\n");
          if (isSweRunEvaluationCall(command, args)) {
            return passedSpawn("Instances resolved: 0\nInstances unresolved: 1\n");
          }
          return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: {
          HOME: tmp,
          OPENROUTER_API_KEY: "sk-test",
          OPENROUTER_MODEL: "kestrel-test",
          DATABASE_URL: "postgres://kestrel:kestrel@localhost:55432/kestrel",
        },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789)),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    assert.equal(code, 0);
    const dockerBuild = calls.find((call) => call.command === "docker" && call.args[0] === "build");
    assert.ok(dockerBuild);
    assert.ok(dockerBuild.args.includes("BASE_IMAGE=sweb.eval.x86_64.astropy__astropy-12907:latest"));
    assert.ok(dockerBuild.args.includes("linux/amd64"));
    const prepareImagesCallIndex = calls.findIndex((call) => isSwePrepareImagesCall(call.command, call.args));
    const imageInspectCallIndex = calls.findIndex((call) => call.command === "docker" && call.args[0] === "image" && call.args[1] === "inspect");
    const dockerBuildCallIndex = calls.findIndex((call) => call.command === "docker" && call.args[0] === "build");
    assert.ok(prepareImagesCallIndex >= 0);
    assert.ok(imageInspectCallIndex > prepareImagesCallIndex);
    assert.ok(dockerBuildCallIndex > imageInspectCallIndex);
    assert.deepEqual(calls[imageInspectCallIndex]?.args, ["image", "inspect", "sweb.eval.x86_64.astropy__astropy-12907:latest"]);
    const baselineCaptureRun = calls.find((call) => isSweBaselineCaptureCall(call.command, call.args));
    assert.ok(baselineCaptureRun);
    assert.ok(baselineCaptureRun.args.includes("/kestrel-baseline"));
    const dockerRun = calls.find(
      (call) => call.command === "docker" && call.args[0] === "run" && !isSweBaselineCaptureCall(call.command, call.args),
    );
    assert.ok(dockerRun);
    assert.ok(dockerRun.args.includes("/testbed"));
    assert.ok(dockerRun.args.some((arg) => arg.endsWith(":/kestrel-baseline:ro")));
    assert.ok(dockerRun.args.some((arg) => arg.endsWith(":/kestrel-attempt/workspace/repo:ro")));
    assert.ok(dockerRun.args.includes("SHELL=/bin/bash"));
    assert.ok(dockerRun.args.includes("DATABASE_URL=postgres://kestrel:kestrel@host.docker.internal:55432/kestrel"));
    assert.ok(dockerRun.args.includes("KESTREL_DISABLE_DOTENV=1"));
    assert.ok(dockerRun.args.includes("KESTREL_HOME=/kestrel-attempt/kestrel-home"));
    assert.ok(dockerRun.args.includes("KESTREL_DEV_SHELL_SOCKET_PATH=/tmp/kestrel-dev-shell/supervisor.sock"));
    assert.ok(dockerRun.args.includes("KESTREL_DEV_SHELL_LOG_PATH=/kestrel-attempt/kestrel-home/dev-shell/service.log"));
    assert.ok(dockerRun.args.includes("KESTREL_DEV_SHELL_STATUS_PATH=/kestrel-attempt/kestrel-home/dev-shell/bootstrap-status.json"));
    assert.ok(dockerRun.args.includes("KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS=30000"));
    assert.equal(
      dockerRun.args.some((arg) => arg.startsWith("KESTREL_RUNNER_PROCESS_MODE=")),
      false,
    );
    assert.ok(dockerRun.args.includes("KESTREL_MODEL_PROMPT_DUMP=1"));
    assert.ok(dockerRun.args.includes("KESTREL_MODEL_PROMPT_DUMP_DIR=/kestrel-attempt/model-prompts"));
    const attemptRoot = path.join(
      tmp,
      "runs",
      "swe-verified",
      "kestrel-swe-astropy__astropy-12907",
      "attempts",
      "20260602T123456789Z",
    );
    const runScript = readFileSync(path.join(attemptRoot, "run-kestrel.sh"), "utf8");
    assert.match(runScript, /kestrel_status=\$\?\ncd \/opt\/kestrel\nnode --import tsx/u);
    assert.match(runScript, /swe-verified-workspace-patch\.ts/u);
    assert.match(runScript, /--baseline-repo \/kestrel-baseline/u);
    assert.match(runScript, /--mode export/u);
    assert.match(runScript, /--source-base-commit d16bfe05a744909de4b27f5875fe0d4ed41ce607/u);
    assert.match(runScript, new RegExp(`--base-commit ${TEST_PREPARED_BASELINE_COMMIT}`, "u"));
    assert.match(runScript, /--kestrel-exit-code "\$kestrel_status"/u);
    assert.doesNotMatch(runScript, /git -C \/testbed diff/u);
    assert.doesNotMatch(runScript, /falling back/u);

    const prediction = JSON.parse(
      readFileSync(path.join(attemptRoot, "predictions.jsonl"), "utf8"),
    ) as { instance_id?: string; model_name_or_path?: string; model_patch?: string };
    assert.equal(prediction.instance_id, "astropy__astropy-12907");
    assert.equal(prediction.model_name_or_path, "kestrel-test");
    assert.match(prediction.model_patch ?? "", /diff --git/u);

    const latest = JSON.parse(
      readFileSync(
        path.join(
          tmp,
          "runs",
          "swe-verified",
          "kestrel-swe-astropy__astropy-12907",
          "latest.json",
        ),
        "utf8",
      ),
    ) as {
      attempt_id?: string;
      predictions_path?: string;
      terminal_status?: string;
      model_patch_exists?: boolean;
      model_patch_bytes?: number;
      evaluator_ran?: boolean;
      evaluator_status?: number;
      evaluator_resolved_instances?: number;
      evaluator_unresolved_instances?: number;
      evaluator_report_path?: string;
      kestrel_process_exit_code?: number;
      workspace_patch_status?: string;
      workspace_patch_report_path?: string;
      workspace_patch_sha256?: string;
      workspace_patch_changed_paths?: number;
      workspace_baseline_report_path?: string;
      workspace_baseline_commit?: string;
      workspace_baseline_tree_sha?: string;
    };
    assert.equal(latest.attempt_id, "20260602T123456789Z");
    assert.match(latest.predictions_path ?? "", /attempts\/20260602T123456789Z\/predictions\.jsonl/u);
    assert.equal(latest.terminal_status, "evaluated");
    assert.equal(latest.model_patch_exists, true);
    assert.ok((latest.model_patch_bytes ?? 0) > 0);
    assert.equal(latest.evaluator_ran, true);
    assert.equal(latest.evaluator_status, 0);
    assert.equal(latest.evaluator_resolved_instances, 0);
    assert.equal(latest.evaluator_unresolved_instances, 1);
    assert.match(latest.evaluator_report_path ?? "", /attempts\/20260602T123456789Z\/evaluator-report\.json/u);
    assert.equal(latest.kestrel_process_exit_code, 0);
    assert.equal(latest.workspace_patch_status, "produced");
    assert.equal(latest.workspace_patch_changed_paths, 1);
    assert.equal(latest.workspace_patch_sha256, createHash("sha256").update("diff --git a/example.py b/example.py\n").digest("hex"));
    assert.match(latest.workspace_patch_report_path ?? "", /workspace-patch-report\.json$/u);
    assert.match(latest.workspace_baseline_report_path ?? "", /workspace-baseline-report\.json$/u);
    assert.equal(latest.workspace_baseline_commit, TEST_PREPARED_BASELINE_COMMIT);
    assert.equal(latest.workspace_baseline_tree_sha, TEST_PREPARED_BASELINE_TREE);
    assert.match(
      readFileSync(path.join(attemptRoot, "evaluator-output.txt"), "utf8"),
      /Instances unresolved: 1/u,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(attemptRoot, "evaluator-report.json"), "utf8")),
      {
        status: 0,
        resolved_instances: 0,
        unresolved_instances: 1,
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench creates a fresh attempt directory for each run by default", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-rerun-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
      }) + "\n",
      "utf8",
    );

    const runOnce = (now: Date) => runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-12907", "--instances-jsonl", instancesJsonl],
      {
        spawn: ((command: string, args: readonly string[]) => {
          if (command === "git" && args[0] === "clone") return passedSpawn("cloned\n");
          if (command === "git" && args[0] === "-C" && args[2] === "checkout") return passedSpawn("checked out\n");
          if (command === "python3" && String(args[0]).endsWith("swe-verified-image-info.py")) {
            return passedSpawn(JSON.stringify({
              instance_image_key: "sweb.eval.x86_64.astropy__astropy-12907:latest",
              platform: "linux/x86_64",
            }) + "\n");
          }
          if (isSwePrepareImagesCall(command, args)) return passedSpawn("images ok\n");
          if (command === "docker" && args[0] === "image" && args[1] === "inspect") return passedSpawn("image exists\n");
          if (command === "git" && args[0] === "ls-files") return passedSpawn("");
          if (command === "docker" && args[0] === "build") return passedSpawn("built\n");
          if (isSweBaselineCaptureCall(command, args)) {
            writeWorkspaceBaselineArtifacts(dockerAttemptDir(args));
            return passedSpawn("baseline captured\n");
          }
          if (command === "docker" && args[0] === "run") {
            const mount = String(args[args.indexOf("-v") + 1]);
            const attemptDir = mount.split(":")[0] as string;
            writeFileSync(path.join(attemptDir, "kestrel-output.txt"), "kestrel ok\n", "utf8");
            writeCompletedJobOutput(attemptDir);
            writeWorkspacePatchArtifacts(attemptDir, "diff --git a/example.py b/example.py\n");
            return passedSpawn("ran\n");
          }
          if (command === "git" && args[0] === "-C" && args[2] === "apply") return passedSpawn("applied\n");
          if (isSweRunEvaluationCall(command, args)) return passedSpawn("evaluation ok\n");
          return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: { HOME: tmp, OPENROUTER_API_KEY: "sk-test", OPENROUTER_MODEL: "kestrel-test" },
        cwd: tmp,
        now: () => now,
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    assert.equal(await runOnce(new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789))), 0);
    assert.equal(await runOnce(new Date(Date.UTC(2026, 5, 2, 12, 34, 57, 101))), 0);

    const attemptsRoot = path.join(
      tmp,
      "runs",
      "swe-verified",
      "kestrel-swe-astropy__astropy-12907",
      "attempts",
    );
    const attemptDirs = readdirSync(attemptsRoot).sort();
    assert.deepEqual(attemptDirs, ["20260602T123456789Z", "20260602T123457101Z"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench fails before runner build when prepared instance image is missing", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-missing-image-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-8707",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Header.fromstring does not accept Python 3 bytes.",
      }) + "\n",
      "utf8",
    );

    const calls: Array<{ command: string; args: string[] }> = [];
    let stderr = "";
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-8707", "--instances-jsonl", instancesJsonl],
      {
        spawn: ((command: string, args: readonly string[]) => {
          calls.push({ command, args: [...args] });
          if (command === "git" && args[0] === "clone") return passedSpawn("cloned\n");
          if (command === "git" && args[0] === "-C" && args[2] === "checkout") return passedSpawn("checked out\n");
          if (command === "python3" && String(args[0]).endsWith("swe-verified-image-info.py")) {
            return passedSpawn(JSON.stringify({
              instance_image_key: "sweb.eval.x86_64.astropy__astropy-8707:latest",
              platform: "linux/x86_64",
            }) + "\n");
          }
          if (isSwePrepareImagesCall(command, args)) return passedSpawn("images ok\n");
          if (command === "docker" && args[0] === "image" && args[1] === "inspect") return failedSpawn("No such image\n");
          return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: { HOME: tmp, OPENROUTER_API_KEY: "sk-test" },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789)),
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 1);
    assert.match(stderr, /expected instance image is missing: sweb\.eval\.x86_64\.astropy__astropy-8707:latest/u);
    assert.match(stderr, /prepare_images output:/u);
    assert.match(stderr, /images ok/u);
    assert.match(stderr, /docker image inspect output:/u);
    assert.match(stderr, /No such image/u);
    assert.ok(calls.some((call) => call.command === "docker" && call.args[0] === "image" && call.args[1] === "inspect"));
    assert.equal(calls.some((call) => call.command === "docker" && call.args[0] === "build"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench source snapshot skips deleted tracked files", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-deleted-source-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
      }) + "\n",
      "utf8",
    );

    const calls: Array<{ command: string; args: string[] }> = [];
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-12907", "--instances-jsonl", instancesJsonl],
      {
        spawn: ((command: string, args: readonly string[]) => {
          calls.push({ command, args: [...args] });
          if (command === "git" && args[0] === "clone") return passedSpawn("cloned\n");
          if (command === "git" && args[0] === "-C" && args[2] === "checkout") return passedSpawn("checked out\n");
          if (command === "python3" && String(args[0]).endsWith("swe-verified-image-info.py")) {
            return passedSpawn(JSON.stringify({
              instance_image_key: "sweb.eval.x86_64.astropy__astropy-12907:latest",
              platform: "linux/x86_64",
            }) + "\n");
          }
          if (isSwePrepareImagesCall(command, args)) return passedSpawn("images ok\n");
          if (command === "docker" && args[0] === "image" && args[1] === "inspect") return passedSpawn("image exists\n");
          if (command === "git" && args[0] === "ls-files") {
            return passedSpawn("agents/reference-react/src/codingCloseoutPolicy.ts\0");
          }
          if (command === "docker" && args[0] === "build") return passedSpawn("built\n");
          if (isSweBaselineCaptureCall(command, args)) {
            writeWorkspaceBaselineArtifacts(dockerAttemptDir(args));
            return passedSpawn("baseline captured\n");
          }
          if (command === "docker" && args[0] === "run") {
            const mount = String(args[args.indexOf("-v") + 1]);
            const attemptDir = mount.split(":")[0] as string;
            writeFileSync(path.join(attemptDir, "kestrel-output.txt"), "kestrel ok\n", "utf8");
            writeCompletedJobOutput(attemptDir);
            writeWorkspacePatchArtifacts(attemptDir, "diff --git a/example.py b/example.py\n");
            return passedSpawn("ran\n");
          }
          if (command === "git" && args[0] === "-C" && args[2] === "apply") return passedSpawn("applied\n");
          if (isSweRunEvaluationCall(command, args)) return passedSpawn("evaluation ok\n");
          return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: {
          HOME: tmp,
          OPENROUTER_API_KEY: "sk-test",
          OPENROUTER_MODEL: "kestrel-test",
          DATABASE_URL: "postgres://kestrel:kestrel@localhost:55432/kestrel",
        },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 35, 58, 123)),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    assert.equal(code, 0);
    assert.ok(calls.some((call) => call.command === "docker" && call.args[0] === "build"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench source snapshot excludes prior run artifacts", () => {
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile("src/runtime/modelTranscript.ts", []), true);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile("kestrel.20260615.json", []), false);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile("openai__gpt-5.4.20260618T204015608Z.json", []), false);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile("minimax__minimax-m3.20260617T230758463Z.json", []), false);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile("codex-cli-0.130.0.codex-cli-sphinx-doc-10466-20260618T171150289Z.json", []), false);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile("runs/swe-verified/case/attempts/old/job-input.json", []), false);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile("logs/kestrel-output.txt", []), false);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile("outputs/model.patch", []), false);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile(".cache/swebench/images.json", []), false);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile(".hf-cache/datasets/cache.arrow", []), false);
  assert.equal(shouldIncludeSweVerifiedRunnerSourceFile("src/kestrel.runtime.json", []), true);
});

test("swe verified bench fails fast on explicit run-id collisions", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-collision-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
      }) + "\n",
      "utf8",
    );
    mkdirSync(
      path.join(
        tmp,
        "runs",
        "swe-verified",
        "kestrel-swe-astropy__astropy-12907",
        "attempts",
        "custom-attempt",
      ),
      { recursive: true },
    );

    let stderr = "";
    const code = await runSweVerifiedBench(
      [
        "run",
        "--instance-id",
        "astropy__astropy-12907",
        "--instances-jsonl",
        instancesJsonl,
        "--run-id",
        "custom-attempt",
      ],
      {
        spawn: (() => failedSpawn("should not spawn")) as never,
        env: { HOME: tmp, OPENROUTER_API_KEY: "sk-test" },
        cwd: tmp,
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 1);
    assert.match(stderr, /Attempt directory already exists/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench rejects empty patches before evaluation", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-empty-patch-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
      }) + "\n",
      "utf8",
    );

    let stderr = "";
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-12907", "--instances-jsonl", instancesJsonl],
      {
        spawn: ((command: string, args: readonly string[]) => {
          if (command === "git" && args[0] === "clone") return passedSpawn("cloned\n");
          if (command === "git" && args[0] === "-C" && args[2] === "checkout") return passedSpawn("checked out\n");
          if (command === "python3" && String(args[0]).endsWith("swe-verified-image-info.py")) {
            return passedSpawn(JSON.stringify({
              instance_image_key: "sweb.eval.x86_64.astropy__astropy-12907:latest",
              platform: "linux/x86_64",
            }) + "\n");
          }
          if (isSwePrepareImagesCall(command, args)) return passedSpawn("images ok\n");
          if (command === "docker" && args[0] === "image" && args[1] === "inspect") return passedSpawn("image exists\n");
          if (command === "git" && args[0] === "ls-files") return passedSpawn("");
          if (command === "docker" && args[0] === "build") return passedSpawn("built\n");
          if (isSweBaselineCaptureCall(command, args)) {
            writeWorkspaceBaselineArtifacts(dockerAttemptDir(args));
            return passedSpawn("baseline captured\n");
          }
          if (command === "docker" && args[0] === "run") {
            const mount = String(args[args.indexOf("-v") + 1]);
            const attemptDir = mount.split(":")[0] as string;
            writeFileSync(path.join(attemptDir, "kestrel-output.txt"), "kestrel ok\n", "utf8");
            writeCompletedJobOutput(attemptDir);
            writeWorkspacePatchArtifacts(attemptDir, "");
            return passedSpawn("ran\n");
          }
          if (isSweRunEvaluationCall(command, args)) return failedSpawn("should not evaluate");
          return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: { HOME: tmp, OPENROUTER_API_KEY: "sk-test" },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789)),
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 1);
    assert.match(stderr, /final submission is empty/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench reports patch harvesting failures without evaluation", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-harvest-failure-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
      }) + "\n",
      "utf8",
    );

    let stderr = "";
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-12907", "--instances-jsonl", instancesJsonl],
      {
        spawn: ((command: string, args: readonly string[]) => {
          if (command === "git" && args[0] === "clone") return passedSpawn("cloned\n");
          if (command === "git" && args[0] === "-C" && args[2] === "checkout") return passedSpawn("checked out\n");
          if (command === "python3" && String(args[0]).endsWith("swe-verified-image-info.py")) {
            return passedSpawn(JSON.stringify({
              instance_image_key: "sweb.eval.x86_64.astropy__astropy-12907:latest",
              platform: "linux/x86_64",
            }) + "\n");
          }
          if (isSwePrepareImagesCall(command, args)) return passedSpawn("images ok\n");
          if (command === "docker" && args[0] === "image" && args[1] === "inspect") return passedSpawn("image exists\n");
          if (command === "git" && args[0] === "ls-files") return passedSpawn("");
          if (command === "docker" && args[0] === "build") return passedSpawn("built\n");
          if (isSweBaselineCaptureCall(command, args)) {
            writeWorkspaceBaselineArtifacts(dockerAttemptDir(args));
            return passedSpawn("baseline captured\n");
          }
          if (command === "docker" && args[0] === "run") {
            const mount = String(args[args.indexOf("-v") + 1]);
            const attemptDir = mount.split(":")[0] as string;
            writeFileSync(path.join(attemptDir, "kestrel-output.txt"), "harvest failed\n", "utf8");
            writeCompletedJobOutput(attemptDir);
            writeWorkspacePatchArtifacts(attemptDir, "", { status: "failed", kestrelExitCode: 0 });
            return failedSpawn("exporter failed\n");
          }
          if (isSweRunEvaluationCall(command, args)) return failedSpawn("should not evaluate");
          return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: { HOME: tmp, OPENROUTER_API_KEY: "sk-test" },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789)),
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 1);
    assert.match(stderr, /workspace patch harvesting failed at render_patch/u);
    const latest = JSON.parse(
      readFileSync(path.join(tmp, "runs", "swe-verified", "kestrel-swe-astropy__astropy-12907", "latest.json"), "utf8"),
    ) as { terminal_status?: string; workspace_patch_status?: string; evaluator_ran?: boolean };
    assert.equal(latest.terminal_status, "patch_harvest_failed");
    assert.equal(latest.workspace_patch_status, "failed");
    assert.equal(latest.evaluator_ran, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench evaluates non-empty patches from non-terminal Kestrel jobs", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-non-terminal-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
      }) + "\n",
      "utf8",
    );

    let stderr = "";
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-12907", "--instances-jsonl", instancesJsonl],
      {
        spawn: ((command: string, args: readonly string[]) => {
          if (command === "git" && args[0] === "clone") return passedSpawn("cloned\n");
          if (command === "git" && args[0] === "-C" && args[2] === "checkout") return passedSpawn("checked out\n");
          if (command === "python3" && String(args[0]).endsWith("swe-verified-image-info.py")) {
            return passedSpawn(JSON.stringify({
              instance_image_key: "sweb.eval.x86_64.astropy__astropy-12907:latest",
              platform: "linux/x86_64",
            }) + "\n");
          }
          if (isSwePrepareImagesCall(command, args)) return passedSpawn("images ok\n");
          if (command === "docker" && args[0] === "image" && args[1] === "inspect") return passedSpawn("image exists\n");
          if (command === "git" && args[0] === "ls-files") return passedSpawn("");
          if (command === "docker" && args[0] === "build") return passedSpawn("built\n");
          if (isSweBaselineCaptureCall(command, args)) {
            writeWorkspaceBaselineArtifacts(dockerAttemptDir(args));
            return passedSpawn("baseline captured\n");
          }
          if (command === "docker" && args[0] === "run") {
            const mount = String(args[args.indexOf("-v") + 1]);
            const attemptDir = mount.split(":")[0] as string;
            writeFileSync(path.join(attemptDir, "kestrel-output.txt"), "kestrel waiting\n", "utf8");
            writeJobOutput(attemptDir, "job.completed", "WAITING", {
              kind: "user",
              eventType: "user.reply",
              metadata: { reason: "max_model_calls_continuation" },
            });
            writeWorkspacePatchArtifacts(attemptDir, "diff --git a/example.py b/example.py\n");
            return passedSpawn("ran\n");
          }
          if (command === "git" && args[0] === "-C" && args[2] === "apply") return passedSpawn("applied\n");
          if (isSweRunEvaluationCall(command, args)) return passedSpawn("evaluation ok\n");
          return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: { HOME: tmp, OPENROUTER_API_KEY: "sk-test" },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789)),
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 0);
    assert.match(stderr, /did not reach terminal COMPLETED state/u);
    assert.match(stderr, /status=WAITING/u);
    assert.match(stderr, /Validated non-empty patches still proceed to evaluation/u);
    const predictionsPath = path.join(
      tmp,
      "runs",
      "swe-verified",
      "kestrel-swe-astropy__astropy-12907",
      "attempts",
      "20260602T123456789Z",
      "predictions.jsonl",
    );
    assert.equal(existsSync(predictionsPath), true);
    const latest = JSON.parse(
      readFileSync(
        path.join(tmp, "runs", "swe-verified", "kestrel-swe-astropy__astropy-12907", "latest.json"),
        "utf8",
      ),
    ) as {
      terminal_status?: string;
      evaluator_ran?: boolean;
      model_patch_exists?: boolean;
      kestrel_job_status?: string;
      kestrel_wait_event_type?: string;
      kestrel_wait_reason?: string;
    };
    assert.equal(latest.terminal_status, "evaluated_after_nonterminal_job");
    assert.equal(latest.evaluator_ran, true);
    assert.equal(latest.model_patch_exists, true);
    assert.equal(latest.kestrel_job_status, "WAITING");
    assert.equal(latest.kestrel_wait_event_type, "user.reply");
    assert.equal(latest.kestrel_wait_reason, "max_model_calls_continuation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench evaluates a validated patch when Kestrel exits nonzero", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-container-fail-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(
      instancesJsonl,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        repo: "astropy/astropy",
        base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
        problem_statement: "Fix separability.",
      }) + "\n",
      "utf8",
    );

    let stderr = "";
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-12907", "--instances-jsonl", instancesJsonl],
      {
        spawn: ((command: string, args: readonly string[]) => {
          if (command === "git" && args[0] === "clone") return passedSpawn("cloned\n");
          if (command === "git" && args[0] === "-C" && args[2] === "checkout") return passedSpawn("checked out\n");
          if (command === "python3" && String(args[0]).endsWith("swe-verified-image-info.py")) {
            return passedSpawn(JSON.stringify({
              instance_image_key: "sweb.eval.x86_64.astropy__astropy-12907:latest",
              platform: "linux/x86_64",
            }) + "\n");
          }
          if (isSwePrepareImagesCall(command, args)) return passedSpawn("images ok\n");
          if (command === "docker" && args[0] === "image" && args[1] === "inspect") return passedSpawn("image exists\n");
          if (command === "git" && args[0] === "ls-files") return passedSpawn("");
          if (command === "docker" && args[0] === "build") return passedSpawn("built\n");
          if (isSweBaselineCaptureCall(command, args)) {
            writeWorkspaceBaselineArtifacts(dockerAttemptDir(args));
            return passedSpawn("baseline captured\n");
          }
          if (command === "docker" && args[0] === "run") {
            const mount = String(args[args.indexOf("-v") + 1]);
            const attemptDir = mount.split(":")[0] as string;
            writeFileSync(path.join(attemptDir, "kestrel-output.txt"), "container validation failed\n", "utf8");
            writeWorkspacePatchArtifacts(attemptDir, "diff --git a/example.py b/example.py\n", {
              kestrelExitCode: 7,
            });
            return failedSpawn("container failed\n");
          }
          if (isSweRunEvaluationCall(command, args)) return passedSpawn("evaluation ok\n");
          return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
        }) as unknown as typeof import("node:child_process").spawnSync,
        env: { HOME: tmp, OPENROUTER_API_KEY: "sk-test" },
        cwd: tmp,
        now: () => new Date(Date.UTC(2026, 5, 2, 12, 34, 56, 789)),
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 0);
    assert.match(stderr, /container command exited with status 1/u);
    assert.match(stderr, /did not produce job output/u);
    const attemptRoot = path.join(
      tmp,
      "runs",
      "swe-verified",
      "kestrel-swe-astropy__astropy-12907",
      "attempts",
      "20260602T123456789Z",
    );
    assert.equal(readFileSync(path.join(attemptRoot, "kestrel-output.txt"), "utf8"), "container validation failed\n");
    const latest = JSON.parse(
      readFileSync(path.join(tmp, "runs", "swe-verified", "kestrel-swe-astropy__astropy-12907", "latest.json"), "utf8"),
    ) as { terminal_status?: string; kestrel_process_exit_code?: number; evaluator_ran?: boolean };
    assert.equal(latest.terminal_status, "evaluated_after_kestrel_failure");
    assert.equal(latest.kestrel_process_exit_code, 7);
    assert.equal(latest.evaluator_ran, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench reports missing local instance rows without crashing", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-missing-"));
  try {
    const instancesJsonl = path.join(tmp, "instances.jsonl");
    writeFileSync(instancesJsonl, "", "utf8");

    let stderr = "";
    const code = await runSweVerifiedBench(
      ["run", "--instance-id", "astropy__astropy-12907", "--instances-jsonl", instancesJsonl],
      {
        spawn: (() => failedSpawn("should not spawn")) as never,
        env: { HOME: tmp, OPENROUTER_API_KEY: "sk-test" },
        cwd: tmp,
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 1);
    assert.match(stderr, /Instance astropy__astropy-12907 not found/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench evaluate mode requires predictions path", async () => {
  let stderr = "";
  const code = await runSweVerifiedBench(["evaluate", "--instance-id", "astropy__astropy-12907"], {
    spawn: (() => failedSpawn("should not spawn")) as never,
    env: {},
    cwd: process.cwd(),
    stdout: { write: () => true },
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
  });

  assert.equal(code, 1);
  assert.match(stderr, /--predictions-path is required/u);
});

test("swe verified bench evaluate mode rejects missing files", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-eval-missing-"));
  try {
    let stderr = "";
    const code = await runSweVerifiedBench(
      [
        "evaluate",
        "--instance-id",
        "astropy__astropy-12907",
        "--predictions-path",
        path.join(tmp, "missing.jsonl"),
      ],
      {
        spawn: (() => failedSpawn("should not spawn")) as never,
        env: {},
        cwd: tmp,
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 1);
    assert.match(stderr, /does not exist/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench evaluate mode rejects empty patches", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-eval-empty-"));
  try {
    const predictionsPath = path.join(tmp, "predictions.jsonl");
    writeFileSync(
      predictionsPath,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        model_name_or_path: "kestrel-test",
        model_patch: "",
      }) + "\n",
      "utf8",
    );

    let stderr = "";
    const code = await runSweVerifiedBench(
      [
        "evaluate",
        "--instance-id",
        "astropy__astropy-12907",
        "--predictions-path",
        predictionsPath,
      ],
      {
        spawn: (() => failedSpawn("should not spawn")) as never,
        env: {},
        cwd: tmp,
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
    );

    assert.equal(code, 1);
    assert.match(stderr, /model_patch/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench evaluate mode writes resolved evaluator report", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-eval-report-"));
  try {
    const predictionsPath = path.join(tmp, "predictions.jsonl");
    writeFileSync(
      predictionsPath,
      JSON.stringify({
        instance_id: "astropy__astropy-12907",
        model_name_or_path: "kestrel-test",
        model_patch: "diff --git a/a.py b/a.py\n",
      }) + "\n",
      "utf8",
    );

    const code = await runSweVerifiedBench(
      [
        "evaluate",
        "--instance-id",
        "astropy__astropy-12907",
        "--predictions-path",
        predictionsPath,
      ],
      {
        spawn: ((command: string, args: readonly string[]) => {
          assert.equal(command, "python3");
          assert.ok(isSweRunEvaluationCall(command, args));
          return passedSpawn(JSON.stringify({
            resolved_instances: 1,
            unresolved_instances: 0,
            resolved_ids: ["astropy__astropy-12907"],
            unresolved_ids: [],
          }));
        }) as never,
        env: {},
        cwd: tmp,
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    assert.equal(code, 0);
    assert.match(readFileSync(path.join(tmp, "evaluator-output.txt"), "utf8"), /resolved_instances/u);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(tmp, "evaluator-report.json"), "utf8")),
      {
        status: 0,
        resolved_instances: 1,
        unresolved_instances: 0,
        resolved_ids: ["astropy__astropy-12907"],
        unresolved_ids: [],
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swe verified bench lists attempts and marks the latest one", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-swe-verified-list-"));
  try {
    const instanceRoot = path.join(
      tmp,
      "runs",
      "swe-verified",
      "kestrel-swe-astropy__astropy-12907",
    );
    const attemptsRoot = path.join(instanceRoot, "attempts");
    mkdirSync(path.join(attemptsRoot, "20260602T123456789Z"), { recursive: true });
    mkdirSync(path.join(attemptsRoot, "20260602T123457101Z"), { recursive: true });
    writeFileSync(path.join(attemptsRoot, "20260602T123456789Z", "predictions.jsonl"), "{}\n", "utf8");
    writeFileSync(
      path.join(instanceRoot, "latest.json"),
      JSON.stringify({
        attempt_id: "20260602T123457101Z",
        attempt_dir: "runs/swe-verified/kestrel-swe-astropy__astropy-12907/attempts/20260602T123457101Z",
        predictions_path: "runs/swe-verified/kestrel-swe-astropy__astropy-12907/attempts/20260602T123457101Z/predictions.jsonl",
        job_input_path: "runs/swe-verified/kestrel-swe-astropy__astropy-12907/attempts/20260602T123457101Z/job-input.json",
        job_output_path: "runs/swe-verified/kestrel-swe-astropy__astropy-12907/attempts/20260602T123457101Z/job-output.json",
        kestrel_output_path: "runs/swe-verified/kestrel-swe-astropy__astropy-12907/attempts/20260602T123457101Z/kestrel-output.txt",
        updated_at: "2026-06-02T12:34:57.101Z",
      }) + "\n",
      "utf8",
    );

    let stdout = "";
    const code = await runSweVerifiedBench(
      ["list", "--instance-id", "astropy__astropy-12907", "--output-root", "runs/swe-verified"],
      {
        spawn: (() => failedSpawn("should not spawn")) as never,
        env: {},
        cwd: tmp,
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: () => true },
      },
    );

    assert.equal(code, 0);
    assert.match(stdout, /latest attempt=20260602T123457101Z/u);
    assert.match(stdout, /attempt=20260602T123457101Z latest/u);
    assert.match(stdout, /attempt=20260602T123456789Z/u);
    assert.match(stdout, /20260602T123457101Z\/predictions\.jsonl \(missing\)/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function passedSpawn(stdout: string): import("node:child_process").SpawnSyncReturns<Buffer> {
  return {
    pid: 123,
    output: [null, Buffer.from(stdout), Buffer.from("")],
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
  };
}

function writeCompletedJobOutput(attemptDir: string): void {
  writeJobOutput(attemptDir, "job.completed", "COMPLETED");
}

function dockerAttemptDir(args: readonly string[]): string {
  const mount = String(args[args.indexOf("-v") + 1]);
  return mount.split(":")[0] as string;
}

function writeWorkspaceBaselineArtifacts(attemptDir: string): void {
  writeFileSync(
    path.join(attemptDir, "workspace-baseline-report.json"),
    JSON.stringify({
      schemaVersion: 1,
      status: "captured",
      sourceBaseCommit: TEST_SOURCE_BASE_COMMIT,
      baselineCommit: TEST_PREPARED_BASELINE_COMMIT,
      baselineTreeSha: TEST_PREPARED_BASELINE_TREE,
      excludedTransientPaths: [],
      unsupportedPaths: [],
      stages: [
        { name: "verify_source_baseline", status: "passed" },
        { name: "inventory_baseline", status: "passed" },
        { name: "stage_baseline", status: "passed" },
        { name: "publish_baseline", status: "passed" },
      ],
    }, null, 2) + "\n",
    "utf8",
  );
}

function writeWorkspacePatchArtifacts(
  attemptDir: string,
  patch: string,
  options: { kestrelExitCode?: number; status?: "produced" | "empty" | "failed" } = {},
): void {
  const status = options.status ?? (patch.length > 0 ? "produced" : "empty");
  const patchPath = path.join(attemptDir, "model.patch");
  if (status === "failed") {
    rmSync(patchPath, { force: true });
  } else {
    writeFileSync(patchPath, patch, "utf8");
  }
  writeFileSync(
    path.join(attemptDir, "workspace-patch-report.json"),
    JSON.stringify({
      schemaVersion: 1,
      status,
      sourceBaseCommit: TEST_SOURCE_BASE_COMMIT,
      baselineCommit: TEST_PREPARED_BASELINE_COMMIT,
      kestrelExitCode: options.kestrelExitCode ?? 0,
      patchBytes: status === "produced" ? Buffer.byteLength(patch) : 0,
      ...(status === "produced"
        ? { patchSha256: createHash("sha256").update(patch).digest("hex") }
        : {}),
      ...(status !== "failed" ? { targetTreeSha: "a".repeat(40) } : {}),
      changedPaths: status === "produced" ? [{ path: "example.py", status: "M" }] : [],
      excludedTransientPaths: [],
      unsupportedPaths: [],
      stages: status === "failed"
        ? [{ name: "render_patch", status: "failed", message: "injected harvest failure" }]
        : [
            { name: "verify_baseline", status: "passed" },
            { name: "inventory_workspace", status: "passed" },
            { name: "stage_workspace", status: "passed" },
            { name: "render_patch", status: "passed" },
            { name: "validate_patch", status: "passed" },
          ],
      validation: {
        applies: status !== "failed",
        treeMatches: status !== "failed",
      },
      ...(status === "failed"
        ? { failureStage: "render_patch", failureMessage: "injected harvest failure" }
        : {}),
    }, null, 2) + "\n",
    "utf8",
  );
}

function writeJobOutput(
  attemptDir: string,
  terminalEventType: "job.completed" | "job.failed",
  status: string,
  waitFor?: Record<string, unknown>,
): void {
  writeFileSync(
    path.join(attemptDir, "job-output.json"),
    JSON.stringify({
      version: "job_output_v1",
      terminalEventType,
      job: {
        version: "job_run_result_v1",
        sessionId: "session-under-test",
        threadId: "thread-under-test",
        runId: "run-under-test",
        status,
        ...(waitFor !== undefined ? { waitFor } : {}),
      },
    }) + "\n",
    "utf8",
  );
}

function failedSpawn(stderr: string): import("node:child_process").SpawnSyncReturns<Buffer> {
  return {
    pid: 123,
    output: [null, Buffer.from(""), Buffer.from(stderr)],
    stdout: Buffer.from(""),
    stderr: Buffer.from(stderr),
    status: 1,
    signal: null,
  };
}
