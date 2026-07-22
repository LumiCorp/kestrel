import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildTerminalBenchHarborCommand,
  parseTerminalBenchHarborArgs,
  readRecentHarborAdapterFailures,
  readRecentHarborRunFailure,
  readRecentHarborRunSummary,
  runTerminalBenchHarbor,
  terminalBenchTaskInputHash,
} from "../../scripts/terminal-bench-harbor.js";
import { formatTb2ReadableSummary } from "../../scripts/tb2-result-summary.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "terminal bench exposes a tb2 shortcut for Harbor", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const wrapper = readFileSync(path.join(process.cwd(), "scripts", "tb2.sh"), "utf8");

  assert.equal(packageJson.scripts?.tb2, "bash scripts/tb2.sh");
  assert.equal(packageJson.scripts?.["bench:terminal:harbor"], "node --import tsx scripts/terminal-bench-harbor.ts");
  assert.match(wrapper, /\. "\$\{REPO_ROOT\}\/\.env"/u);
  assert.match(wrapper, /OPENROUTER_API_KEY/u);
  assert.match(wrapper, /caller_openrouter_model="\$\{OPENROUTER_MODEL-\}"/u);
  assert.match(wrapper, /export OPENROUTER_MODEL="\$\{caller_openrouter_model\}"/u);
  assert.match(wrapper, /unset OPENROUTER_MODEL/u);
  assert.doesNotMatch(wrapper, /KESTREL_TBENCH_MODEL_PROVIDER/u);
  assert.match(wrapper, /pnpm run bench:terminal:harbor -- "\$@"/u);
});

contractTest("runtime.hermetic", "terminal bench task identity excludes randomized job envelope fields", () => {
  const baseline = terminalBenchTaskInputHash("terminal-bench@2.0", "fix-git");
  const candidate = terminalBenchTaskInputHash("terminal-bench@2.0", "fix-git");

  assert.equal(baseline, candidate);
  assert.notEqual(baseline, terminalBenchTaskInputHash("terminal-bench@2.0", "prove-plus-comm"));
});

contractTest("runtime.hermetic", "terminal bench exposes a tb2 passing regression script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const wrapper = readFileSync(path.join(process.cwd(), "scripts", "tb2-passing.sh"), "utf8");

  assert.equal(packageJson.scripts?.["tb2-passing"], "bash scripts/tb2-passing.sh");
  assert.match(wrapper, /run_tb2_passing_case cobol-modernization --artifact \/app\/program\.py/u);
  assert.match(wrapper, /run_tb2_passing_case fix-git/u);
  assert.match(wrapper, /run_tb2_passing_case prove-plus-comm/u);
  assert.match(wrapper, /pnpm run tb2 "\$\{task_id\}" "\$@"/u);
});

contractTest("runtime.hermetic", "terminal bench exposes a tb2 medium-low candidate script", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const wrapper = readFileSync(path.join(process.cwd(), "scripts", "tb2-medium-low.sh"), "utf8");

  assert.equal(packageJson.scripts?.["tb2-medium-low"], "bash scripts/tb2-medium-low.sh");
  for (const taskId of [
    "caffe-cifar-10",
    "crack-7z-hash",
    "mteb-leaderboard",
    "raman-fitting",
    "constraints-scheduling",
    "kv-store-grpc",
    "mteb-retrieve",
    "pytorch-model-recovery",
  ]) {
    assert.match(wrapper, new RegExp(`${taskId}`, "u"));
  }
  assert.match(wrapper, /for task_index in "\$\{!tasks\[@\]\}"; do/u);
  assert.match(wrapper, /tb2_preflight_reason/u);
  assert.match(wrapper, /SKIP_INFRA \$\{tasks\[remaining_index\]\} reason=\$\{preflight_reason\}/u);
  assert.match(wrapper, /pnpm exec tsx scripts\/tb2-result-summary\.ts --since-ms/u);
  assert.match(wrapper, /DRY_RUN \$\{task_id\}/u);
  assert.match(wrapper, /\[tb2-medium-low\] summary/u);
  assert.match(wrapper, /pnpm run tb2 "\$\{task_id\}" "\$@"/u);
});

contractTest("runtime.hermetic", "terminal bench harbor parses single task defaults", () => {
  const options = parseTerminalBenchHarborArgs(["cobol-modernization"]);

  assert.deepEqual(options, {
    mode: "run",
    dataset: "terminal-bench@2.0",
    taskId: "cobol-modernization",
    dryRun: false,
    harborBin: "harbor",
    agentEnv: [],
    artifacts: [],
  });
});

contractTest("runtime.hermetic", "terminal bench harbor builds Harbor custom agent command", () => {
  const command = buildTerminalBenchHarborCommand(
    parseTerminalBenchHarborArgs(["cobol-modernization", "--harbor-bin", "/tmp/harbor", "--artifact", "/app/program.py"]),
  );

  assert.deepEqual(command.args, [
    "run",
    "-d",
    "terminal-bench@2.0",
    "--agent-import-path",
    "benchmarks.terminal_bench.harbor_agents:KestrelHarborCliInstalledAgent",
    "--include-task-name",
    "cobol-modernization",
    "--artifact",
    "/app/program.py",
  ]);
});

contractTest("runtime.hermetic", "terminal bench harbor supports full dataset dry-run", () => {
  const options = parseTerminalBenchHarborArgs(["--full", "--dry-run"]);
  const command = buildTerminalBenchHarborCommand(options);

  assert.equal(options.taskId, undefined);
  assert.equal(options.dryRun, true);
  assert.deepEqual(command.args, [
    "run",
    "-d",
    "terminal-bench@2.0",
    "--agent-import-path",
    "benchmarks.terminal_bench.harbor_agents:KestrelHarborCliInstalledAgent",
  ]);
});

contractTest("runtime.hermetic", "terminal bench harbor rejects unsafe artifact paths", () => {
  assert.throws(
    () => parseTerminalBenchHarborArgs(["cobol-modernization", "--artifact", "../program.py"]),
    /Unsafe Harbor artifact path/u,
  );
});

contractTest("runtime.hermetic", "terminal bench harbor dry-run does not require harbor binary", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let spawnCalls = 0;

  const code = await runTerminalBenchHarbor(["cobol-modernization", "--dry-run"], {
    spawn: (() => {
      spawnCalls += 1;
      return { status: 1, stdout: Buffer.from(""), stderr: Buffer.from(""), signal: null, pid: 1, output: [] };
    }) as never,
    env: { OPENROUTER_API_KEY: "sk-test" },
    cwd: process.cwd(),
    stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
  });

  assert.equal(code, 0);
  assert.equal(spawnCalls, 0);
  assert.match(stdout.join(""), /harbor run -d terminal-bench@2\.0/u);
  assert.equal(stderr.join(""), "");
});

contractTest("runtime.hermetic", "terminal bench harbor transports the selected profile into the task container", async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-profile-"));
  try {
    const profileFile = path.join(temporary, "profiles.json");
    writeFileSync(profileFile, JSON.stringify({ profiles: [{ id: "candidate", harnessEconomics: { version: 1 } }] }));
    const stdout: string[] = [];
    const code = await runTerminalBenchHarbor(["fix-git", "--dry-run"], {
      spawn: (() => { throw new Error("unexpected spawn"); }) as never,
      env: {
        OPENROUTER_API_KEY: "sk-test",
        KESTREL_BENCHMARK_HARNESS_REVISION: "abc123",
        KESTREL_BENCHMARK_PROFILE_FILE: profileFile,
        KESTREL_BENCHMARK_PROFILE_ID: "candidate",
      },
      cwd: process.cwd(),
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
      stderr: { write: () => true },
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /KESTREL_BENCHMARK_PROFILE_JSON_BASE64=/u);
    assert.match(stdout.join(""), /KESTREL_BENCHMARK_HARNESS_REVISION/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "terminal bench harbor warns when non-OpenRouter provider keys are present with OpenRouter", async () => {
  const stderr: string[] = [];
  const code = await runTerminalBenchHarbor(["cobol-modernization", "--dry-run"], {
    spawn: (() => {
      throw new Error("unexpected spawn");
    }) as never,
    env: {
      OPENROUTER_API_KEY: "sk-test",
      ANTHROPIC_API_KEY: "ignored",
    },
    cwd: process.cwd(),
    stdout: { write: () => true },
    stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
  });

  assert.equal(code, 0);
  assert.match(stderr.join(""), /Ignoring non-OpenRouter provider key\(s\) for Kestrel benchmarks: ANTHROPIC_API_KEY/u);
});

contractTest("runtime.hermetic", "terminal bench harbor installs missing default harbor binary and continues", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  let installed = false;
  const code = await runTerminalBenchHarbor(["cobol-modernization"], {
    spawn: ((command: string, args: string[]) => {
      calls.push({ command, args });
      if ((command === "harbor" || command === "/Users/example/.local/bin/harbor") && args[0] === "--help" && !installed) {
        return { status: 1, stdout: Buffer.from(""), stderr: Buffer.from(""), signal: null, pid: 1, output: [] };
      }
      if (command === "uv" && args.join(" ") === "tool install harbor") {
        installed = true;
      }
      return { status: 0, stdout: Buffer.from("ok"), stderr: Buffer.from(""), signal: null, pid: 1, output: [] };
    }) as never,
    env: { HOME: "/Users/example", OPENROUTER_API_KEY: "sk-test" },
    cwd: process.cwd(),
    stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => [call.command, ...call.args]), [
    ["harbor", "--help"],
    ["/Users/example/.local/bin/harbor", "--help"],
    ["uv", "--version"],
    ["uv", "tool", "install", "harbor"],
    ["harbor", "--help"],
    [
      "harbor",
      "run",
      "-d",
      "terminal-bench@2.0",
      "--agent-import-path",
      "benchmarks.terminal_bench.harbor_agents:KestrelHarborCliInstalledAgent",
      "--agent-env",
      "KESTREL_TBENCH_RESULT_ADAPTER=harbor-cli",
      "--agent-env",
      "KESTREL_TBENCH_RESULT_DATASET=terminal-bench@2.0",
      "--agent-env",
      "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}",
      "--agent-env",
      "KESTREL_BENCHMARK_MODEL_PROVIDER=${KESTREL_BENCHMARK_MODEL_PROVIDER}",
      "--agent-env",
      "KESTREL_BENCHMARK_MODEL=${KESTREL_BENCHMARK_MODEL}",
      "--agent-env",
      "KESTREL_BENCHMARK_CREDENTIAL_ENV=${KESTREL_BENCHMARK_CREDENTIAL_ENV}",
      "--agent-env",
      "KESTREL_BENCHMARK_CREDENTIAL_FINGERPRINT=${KESTREL_BENCHMARK_CREDENTIAL_FINGERPRINT}",
      "--include-task-name",
      "cobol-modernization",
    ],
  ]);
  assert.match(stdout.join(""), /installing with uv tool install harbor/u);
  assert.equal(stderr.join(""), "");
});

contractTest("runtime.hermetic", "terminal bench harbor reports missing uv when harbor install cannot run", async () => {
  const stderr: string[] = [];
  const code = await runTerminalBenchHarbor(["cobol-modernization"], {
    spawn: (() => ({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from(""), signal: null, pid: 1, output: [] })) as never,
    env: { OPENROUTER_API_KEY: "sk-test" },
    cwd: process.cwd(),
    stdout: { write: () => true },
    stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
  });

  assert.equal(code, 1);
  assert.match(stderr.join(""), /uv is not installed/u);
});

contractTest("runtime.hermetic", "terminal bench harbor detects recent failed Kestrel adapter artifacts", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-failures-"));
  try {
    const staleNestedArtifactDir = path.join(
      tmp,
      "runs",
      "swe-verified",
      "attempt",
      "runner-image",
      "kestrel-src",
      "jobs",
      "2026-06-15__09-49-30",
      "cobol-modernization__abc123",
      "agent",
    );
    mkdirSync(staleNestedArtifactDir, { recursive: true });
    writeFileSync(
      path.join(staleNestedArtifactDir, "kestrel-harbor-cli-cobol-modernization.json"),
      JSON.stringify({
        adapter: "harbor-cli",
        dataset: "terminal-bench@2.0",
        task_id: "cobol-modernization",
        status: "failed",
        failure_kind: "cli_command_failed",
      }),
    );

    assert.deepEqual(readRecentHarborAdapterFailures(tmp, Date.now() - 1000), []);

    const jobArtifactDir = path.join(tmp, "jobs", "2026-06-15__09-49-30", "cobol-modernization__abc123", "agent");
    mkdirSync(jobArtifactDir, { recursive: true });
    writeFileSync(
      path.join(jobArtifactDir, "kestrel-harbor-cli-cobol-modernization.json"),
      JSON.stringify({
        adapter: "harbor-cli",
        dataset: "terminal-bench@2.0",
        task_id: "cobol-modernization",
        status: "failed",
        failure_kind: "kestrel_run_failed",
      }),
    );

    assert.deepEqual(readRecentHarborAdapterFailures(tmp, Date.now() - 1000), [
      {
        path: path.join("jobs", "2026-06-15__09-49-30", "cobol-modernization__abc123", "agent", "kestrel-harbor-cli-cobol-modernization.json"),
        status: "failed",
        failureKind: "kestrel_run_failed",
        taskId: "cobol-modernization",
      },
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "terminal bench harbor detects recent errored Harbor trial", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-errored-"));
  try {
    const jobDir = path.join(tmp, "jobs", "2026-06-17__10-58-17");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      path.join(jobDir, "result.json"),
      JSON.stringify({
        stats: {
          n_errored_trials: 1,
          evals: {},
        },
      }),
    );

    assert.equal(
      readRecentHarborRunFailure(tmp, Date.now() - 1000),
      path.join("jobs", "2026-06-17__10-58-17", "result.json") + " reports 1 errored trial(s)",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "terminal bench harbor detects single-task zero reward", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-zero-reward-"));
  try {
    const jobDir = path.join(tmp, "jobs", "2026-06-17__11-00-09");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      path.join(jobDir, "result.json"),
      JSON.stringify({
        stats: {
          n_errored_trials: 0,
          evals: {
            "kestrel-harbor-cli__terminal-bench": {
              metrics: [{ mean: 0 }],
            },
          },
        },
      }),
    );

    assert.equal(readRecentHarborRunFailure(tmp, Date.now() - 1000), undefined);
    assert.equal(
      readRecentHarborRunFailure(tmp, Date.now() - 1000, true),
      path.join("jobs", "2026-06-17__11-00-09", "result.json") + " reports reward mean 0",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "terminal bench harbor summarizes reward, adapter, exceptions, and process failure", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-summary-"));
  try {
    const jobDir = path.join(tmp, "jobs", "2026-06-17__13-08-08");
    const artifactDir = path.join(jobDir, "kv-store-grpc__abc123", "agent");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(jobDir, "result.json"),
      JSON.stringify({
        stats: {
          n_completed_trials: 1,
          n_errored_trials: 1,
          evals: {
            "kestrel-harbor-cli__terminal-bench": {
              metrics: [{ mean: 0 }],
              exception_stats: {
                AgentTimeoutError: ["kv-store-grpc__abc123"],
              },
            },
          },
        },
      }),
    );
    writeFileSync(
      path.join(artifactDir, "kestrel-harbor-cli-kv-store-grpc.json"),
      JSON.stringify({
        task_id: "kv-store-grpc",
        status: "completed",
        failure_kind: "none",
      }),
    );
    writeFileSync(
      path.join(artifactDir, "kestrel-cli-result.json"),
      JSON.stringify({
        status: "completed",
        failure_kind: "none",
        failure_details: {
          process_failure: {
            command: "python3 - <<'PY'\nimport grpc\nPY",
            exit_code: 127,
            status: "FAILED",
          },
        },
      }),
    );

    const summary = readRecentHarborRunSummary(tmp, Date.now() - 1000, "kv-store-grpc");

    assert.equal(summary.status, "FAIL");
    assert.equal(summary.reason, "harbor_reward_or_error");
    assert.equal(summary.taskId, "kv-store-grpc");
    assert.equal(summary.jobPath, path.join("jobs", "2026-06-17__13-08-08"));
    assert.equal(summary.resultPath, path.join("jobs", "2026-06-17__13-08-08", "result.json"));
    assert.equal(summary.completedTrials, 1);
    assert.equal(summary.erroredTrials, 1);
    assert.equal(summary.rewardMean, 0);
    assert.deepEqual(summary.exceptionStats, { AgentTimeoutError: ["kv-store-grpc__abc123"] });
    assert.equal(summary.adapterStatus, "completed");
    assert.equal(summary.adapterFailureKind, "none");
    assert.equal(summary.processFailure?.exitCode, 127);
    assert.equal(summary.processFailure?.status, "FAILED");
    assert.match(summary.processFailure?.commandPreview ?? "", /import grpc/u);
    assert.match(formatTb2ReadableSummary(summary), /exceptions=AgentTimeoutError/u);
    assert.match(formatTb2ReadableSummary(summary), /process_exit=127/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "terminal bench harbor summarizes missing and incomplete results as infrastructure skips", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-no-result-"));
  try {
    assert.deepEqual(readRecentHarborRunSummary(tmp, Date.now() - 1000, "mteb-retrieve"), {
      status: "SKIP_INFRA",
      reason: "infra_no_result",
      taskId: "mteb-retrieve",
    });

    const jobDir = path.join(tmp, "jobs", "2026-06-17__13-11-33");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      path.join(jobDir, "result.json"),
      JSON.stringify({
        stats: {
          n_completed_trials: 0,
          n_errored_trials: 0,
          evals: {},
        },
      }),
    );

    const summary = readRecentHarborRunSummary(tmp, Date.now() - 1000, "mteb-retrieve");
    assert.equal(summary.status, "SKIP_INFRA");
    assert.equal(summary.reason, "infra_no_result");
    assert.equal(summary.completedTrials, 0);
    assert.equal(summary.erroredTrials, 0);
    assert.equal(summary.rewardMean, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "terminal bench harbor fails single-task run when Harbor reward is zero", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-zero-reward-run-"));
  try {
    const code = await runTerminalBenchHarbor(["caffe-cifar-10"], {
      spawn: ((command: string, args: string[]) => {
        if (command === "harbor" && args[0] === "run") {
          const jobDir = path.join(tmp, "jobs", "2026-06-17__11-56-58");
          mkdirSync(jobDir, { recursive: true });
          writeFileSync(
            path.join(jobDir, "result.json"),
            JSON.stringify({
              stats: {
                n_errored_trials: 0,
                evals: {
                  "kestrel-harbor-cli__terminal-bench": {
                    metrics: [{ mean: 0 }],
                  },
                },
              },
            }),
          );
        }
        return { status: 0, stdout: Buffer.from("ok"), stderr: Buffer.from(""), signal: null, pid: 1, output: [] };
      }) as never,
      env: { OPENROUTER_API_KEY: "sk-test" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
