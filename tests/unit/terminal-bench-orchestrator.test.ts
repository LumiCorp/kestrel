import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRunNote,
  buildCodexExecArgs,
  buildDockerCleanupCommand,
  buildFailurePacket,
  buildTerminalBenchCommands,
  checkCleanWorktree,
  collectPreflightIssues,
  createTerminalBenchQueue,
  discoverTerminalBenchTaskIds,
  formatCommand,
  markQueueTaskFailed,
  markQueueTaskPassed,
  parseTerminalBenchArgs,
  readTerminalBenchOutcome,
  resolveBenchmarkModelProvider,
  resolveDockerHost,
  resolveTerminalBenchBinary,
  runTerminalBench,
  validateTerminalBenchRepairPolicy,
} from "../../scripts/terminal-bench.js";

test("terminal bench appends concise run notes", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-notes-"));
  try {
    const notesPath = path.join(tmp, "benchmarks", "terminal_bench", "term-bench-run-notes.md");
    appendRunNote({
      cwd: tmp,
      title: "Kestrel task unresolved",
      command: "pnpm run bench:terminal -- improve --full --adapter kestrel",
      outcome: "Stopped after play-zork was unresolved.",
      evidencePaths: ["runs/kestrel-cli-test/results.json"],
      next: "Repair play-zork before continuing the queue.",
    });

    const notes = readFileSync(notesPath, "utf8");
    assert.match(notes, /Kestrel task unresolved/u);
    assert.match(notes, /Stopped after play-zork was unresolved/u);
    assert.match(notes, /runs\/kestrel-cli-test\/results\.json/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench exposes a tb shortcut that loads env and defaults OpenRouter", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const wrapper = readFileSync(path.join(process.cwd(), "scripts", "tb.sh"), "utf8");

  assert.equal(packageJson.scripts?.tb, "bash scripts/tb.sh");
  assert.match(wrapper, /\. "\$\{REPO_ROOT\}\/\.env"/u);
  assert.match(wrapper, /OPENROUTER_API_KEY/u);
  assert.match(wrapper, /caller_openrouter_model="\$\{OPENROUTER_MODEL-\}"/u);
  assert.match(wrapper, /export OPENROUTER_MODEL="\$\{caller_openrouter_model\}"/u);
  assert.match(wrapper, /unset OPENROUTER_MODEL/u);
  assert.doesNotMatch(wrapper, /KESTREL_TBENCH_MODEL_PROVIDER/u);
  assert.match(wrapper, /pnpm run bench:terminal -- run --task-id "\$\{task_id\}"/u);
});

test("terminal bench orchestrator defaults to the canonical Kestrel adapter on hello-world", () => {
  const options = parseTerminalBenchArgs([]);
  const commands = buildTerminalBenchCommands(options);

  assert.deepEqual(options, {
    mode: "preflight",
    adapter: "kestrel",
    dataset: "terminal-bench-core==0.1.1",
    taskId: "hello-world",
    dryRun: false,
    tbBin: "tb",
    maxIterations: 10,
    executor: "codex",
  });
  assert.deepEqual(commands, [
    {
      adapter: "kestrel",
      args: [
        "run",
        "--dataset",
        "terminal-bench-core==0.1.1",
        "--agent-import-path",
        "benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent",
        "--task-id",
        "hello-world",
      ],
    },
  ]);
});

test("terminal bench improve defaults to Kestrel hello-world with a ten-iteration Codex loop", () => {
  const options = parseTerminalBenchArgs(["improve"]);
  assert.deepEqual(options, {
    mode: "improve",
    adapter: "kestrel",
    dataset: "terminal-bench-core==0.1.1",
    taskId: "hello-world",
    dryRun: false,
    tbBin: "tb",
    maxIterations: 10,
    executor: "codex",
  });
  assert.deepEqual(buildTerminalBenchCommands(options), [
    {
      adapter: "kestrel",
      args: [
        "run",
        "--dataset",
        "terminal-bench-core==0.1.1",
        "--agent-import-path",
        "benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent",
        "--task-id",
        "hello-world",
      ],
    },
  ]);
});

test("terminal bench improve accepts adapter, full dataset, and max iteration overrides", () => {
  const options = parseTerminalBenchArgs([
    "improve",
    "--adapter",
    "kestrel",
    "--full",
    "--max-iterations",
    "3",
    "--executor",
    "codex",
  ]);

  assert.equal(options.mode, "improve");
  assert.equal(options.adapter, "kestrel");
  assert.equal(options.taskId, undefined);
  assert.equal(options.maxIterations, 3);
});

test("terminal bench exposes cleanup mode", () => {
  const options = parseTerminalBenchArgs(["cleanup", "--dry-run"]);

  assert.equal(options.mode, "cleanup");
  assert.equal(options.dryRun, true);
  assert.equal(options.adapter, "kestrel");
});

test("terminal bench builds scoped docker cleanup command", () => {
  assert.deepEqual(buildDockerCleanupCommand({
    taskId: "play-zork",
    runId: "kestrel-cli-20260428231446",
    dataset: "terminal-bench-core==0.1.1",
    homeDir: "/Users/example",
    removeImages: false,
  }), {
    command: "docker",
    args: [
      "compose",
      "-p",
      "play-zork-1-of-1-kestrel-cli-20260428231446",
      "-f",
      "/Users/example/.cache/terminal-bench/terminal-bench-core/0.1.1/play-zork/docker-compose.yaml",
      "down",
      "--volumes",
    ],
    env: {
      T_BENCH_CONTAINER_AGENT_LOGS_PATH: "/agent-logs",
      T_BENCH_CONTAINER_LOGS_PATH: "/logs",
      T_BENCH_TASK_AGENT_LOGS_PATH: "/Users/example",
      T_BENCH_TASK_DOCKER_CLIENT_CONTAINER_NAME: "play-zork-1-of-1-kestrel-cli-20260428231446",
      T_BENCH_TASK_DOCKER_CLIENT_IMAGE_NAME: "tb__play-zork__client",
      T_BENCH_TASK_DOCKER_NAME_PREFIX: "tb__play-zork",
      T_BENCH_TASK_LOGS_PATH: "/Users/example",
      T_BENCH_TEST_DIR: "/tests",
    },
  });
});

test("terminal bench docker cleanup never uses global prune commands", () => {
  const cleanup = buildDockerCleanupCommand({
    taskId: "hello-world",
    runId: "kestrel-cli-test",
    dataset: "terminal-bench-core==0.1.1",
    homeDir: "/Users/example",
    removeImages: true,
  });

  assert.equal(cleanup.args.includes("system"), false);
  assert.equal(cleanup.args.includes("prune"), false);
  assert.deepEqual(cleanup.args.slice(-4), ["down", "--rmi", "all", "--volumes"]);
});

test("terminal bench docker cleanup rejects unsafe dataset segments", () => {
  for (const dataset of ["../x==0.1.1", "terminal-bench-core==../0.1.1"]) {
    assert.throws(
      () => buildDockerCleanupCommand({
        taskId: "hello-world",
        runId: "kestrel-cli-test",
        dataset,
        homeDir: "/Users/example",
        removeImages: false,
      }),
      /Unsafe Terminal-Bench dataset segment:/u,
    );
  }
});

test("terminal bench docker cleanup rejects unsafe task ids", () => {
  for (const taskId of ["../play-zork", "play/zork"]) {
    assert.throws(
      () => buildDockerCleanupCommand({
        taskId,
        runId: "kestrel-cli-test",
        dataset: "terminal-bench-core==0.1.1",
        homeDir: "/Users/example",
        removeImages: false,
      }),
      new Error(`Unsafe Terminal-Bench task id: ${taskId}`),
    );
  }
});

test("terminal bench docker cleanup rejects unsafe run ids", () => {
  for (const runId of ["kestrel.cli.test", "../kestrel-cli-test"]) {
    assert.throws(
      () => buildDockerCleanupCommand({
        taskId: "hello-world",
        runId,
        dataset: "terminal-bench-core==0.1.1",
        homeDir: "/Users/example",
        removeImages: false,
      }),
      new Error(`Unsafe Terminal-Bench run id: ${runId}`),
    );
  }
});

test("terminal bench improve full enables queue mode implicitly", () => {
  const options = parseTerminalBenchArgs(["improve", "--full", "--adapter", "kestrel"]);

  assert.equal(options.mode, "improve");
  assert.equal(options.taskId, undefined);
  assert.equal(options.adapter, "kestrel");
});

test("terminal bench builds deterministic task queue state", () => {
  const queue = createTerminalBenchQueue({
    dataset: "terminal-bench-core==0.1.1",
    adapter: "kestrel",
    taskIds: ["play-zork", "hello-world"],
    createdAt: "2026-04-28T00:00:00.000Z",
  });

  assert.deepEqual(queue.tasks.map((task) => task.task_id), ["play-zork", "hello-world"]);
  assert.deepEqual(queue.tasks.map((task) => task.status), ["pending", "pending"]);
});

test("terminal bench queue marks pass and first failure", () => {
  const queue = createTerminalBenchQueue({
    dataset: "terminal-bench-core==0.1.1",
    adapter: "kestrel",
    taskIds: ["play-zork", "hello-world"],
    createdAt: "2026-04-28T00:00:00.000Z",
  });

  markQueueTaskPassed(queue, "play-zork", "run-play");
  markQueueTaskFailed(queue, "hello-world", "run-hello", "tb_verifier_failed");

  assert.equal(queue.tasks[0]?.status, "passed");
  assert.equal(queue.tasks[0]?.last_run_id, "run-play");
  assert.equal(queue.tasks[0]?.last_failure_kind, null);
  assert.equal(queue.tasks[1]?.status, "failed");
  assert.equal(queue.tasks[1]?.last_run_id, "run-hello");
  assert.equal(queue.tasks[1]?.last_failure_kind, "tb_verifier_failed");
});

test("terminal bench improve full queue stops on first unresolved task", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-queue-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    const homeDir = path.join(tmp, "home");
    const cacheRoot = path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1");
    const composePath = path.join(cacheRoot, "hello-world", "docker-compose.yaml");
    for (const taskId of ["play-zork", "hello-world"]) {
      mkdirSync(path.join(cacheRoot, taskId), { recursive: true });
      writeFileSync(path.join(cacheRoot, taskId, "docker-compose.yaml"), "services: {}\n");
    }
    mkdirSync(homeDir, { recursive: true });

    const code = await runTerminalBench(["improve", "--full", "--adapter", "kestrel", "--max-iterations", "1"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") return passedSpawn("tb help\n");
        if (command === "uv" && args.join(" ") === "--version") return passedSpawn("uv ok\n");
        if (command === "docker" && args.join(" ") === "info") return passedSpawn("docker ok\n");
        if (command === "docker" && args[0] === "compose") return passedSpawn("cleanup ok\n");
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") return passedSpawn("");
        if (command === "tb" && args[0] === "run") {
          writeTbResults(tmp, args, false);
          return failedSpawn("unresolved\n");
        }
        if (command === "codex") return failedSpawn("stop before repair completes\n");
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", HOME: homeDir, DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 1);
    const tbRuns = calls.filter((call) => call.command === "tb" && call.args[0] === "run");
    assert.equal(tbRuns.length, 1);
    assert.ok(tbRuns[0]?.args.includes("--task-id"));
    assert.equal(tbRuns[0]?.args.filter((arg) => arg === "--task-id").length, 1);

    const dockerComposeCalls = calls.filter((call) => call.command === "docker" && call.args[0] === "compose");
    assert.equal(dockerComposeCalls.length >= 2, true);
    assert.equal(dockerComposeCalls.every((call) => call.args.includes("down")), true);
    assert.equal(dockerComposeCalls.every((call) => call.args.includes("--volumes")), true);
    assert.equal(dockerComposeCalls.every((call) => call.args[call.args.indexOf("-f") + 1] === composePath), true);
    const dockerCalls = calls.filter((call) => call.command === "docker");
    assert.equal(dockerCalls.every((call) => !call.args.includes("system")), true);
    assert.equal(dockerCalls.every((call) => !call.args.includes("prune")), true);
    assert.equal(dockerCalls.every((call) => !call.args.includes("--rmi")), true);

    const cleanupOutput = readFileSync(
      path.join(readLatestImproveRoot(tmp), "task-001-hello-world", "docker-cleanup.txt"),
      "utf8",
    );
    assert.match(cleanupOutput, new RegExp(escapeRegExp("docker compose -p hello-world-1-of-1-"), "u"));
    assert.match(cleanupOutput, new RegExp(escapeRegExp(composePath), "u"));
    assert.match(cleanupOutput, /status=0/u);
    assert.match(cleanupOutput, /cleanup ok/u);

    const queue = readLatestQueue(tmp);
    const failedTasks = queue.tasks.filter((task) => task.status === "failed");
    assert.equal(failedTasks.length, 1);
    assert.equal(failedTasks[0]?.last_failure_kind, "tb_verifier_failed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench improve full queue records canonical adapter metadata", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-queue-kestrel-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    const cacheRoot = path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1");
    mkdirSync(path.join(cacheRoot, "hello-world"), { recursive: true });
    writeFileSync(path.join(cacheRoot, "hello-world", "docker-compose.yaml"), "services: {}\n");

    const code = await runTerminalBench(["improve", "--full", "--adapter", "kestrel", "--max-iterations", "1"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") return passedSpawn("tb help\n");
        if (command === "uv" && args.join(" ") === "--version") return passedSpawn("uv ok\n");
        if (command === "docker" && args.join(" ") === "info") return passedSpawn("docker ok\n");
        if (command === "docker" && args[0] === "compose") return passedSpawn("cleanup ok\n");
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") return passedSpawn("");
        if (command === "tb" && args[0] === "run") {
          writeTbResults(tmp, args, false);
          return failedSpawn("unresolved\n");
        }
        if (command === "codex") return failedSpawn("stop before repair completes\n");
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", HOME: tmp, DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 1);
    const tbRuns = calls.filter((call) => call.command === "tb" && call.args[0] === "run");
    assert.equal(tbRuns.length, 1);
    for (const run of tbRuns) {
      assert.equal(run.args.filter((arg) => arg === "--task-id").length, 1);
    }

    const task = readLatestQueue(tmp).tasks[0];
    assert.equal(task?.status, "failed");
    assert.equal(task?.adapter_runs?.kestrel?.status, "failed");
    assert.equal(task?.adapter_runs?.kestrel?.last_failure_kind, "tb_verifier_failed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench improve full queue verifies the failed canonical adapter after repair", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-queue-failed-adapter-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  const verificationTbRuns: Array<{ command: string; args: string[] }> = [];
  let codexRan = false;
  let statusCalls = 0;
  try {
    const cacheRoot = path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1");
    mkdirSync(path.join(cacheRoot, "hello-world"), { recursive: true });
    writeFileSync(path.join(cacheRoot, "hello-world", "docker-compose.yaml"), "services: {}\n");

    const code = await runTerminalBench(["improve", "--full", "--adapter", "kestrel", "--max-iterations", "1"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") return passedSpawn("tb help\n");
        if (command === "uv" && args.join(" ") === "--version") return passedSpawn("uv ok\n");
        if (command === "docker" && args.join(" ") === "info") return passedSpawn("docker ok\n");
        if (command === "docker" && args[0] === "compose") return passedSpawn("cleanup ok\n");
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") {
          statusCalls += 1;
          return statusCalls === 1 ? passedSpawn("") : passedSpawn(" M src/example.ts\n");
        }
        if (command === "tb" && args[0] === "run") {
          if (codexRan) {
            verificationTbRuns.push({ command, args: [...args] });
            writeTbResults(tmp, args, true);
            return passedSpawn("resolved\n");
          }
          writeTbResults(tmp, args, false);
          return failedSpawn("unresolved\n");
        }
        if (command === "codex") {
          codexRan = true;
          return passedSpawn("patched\n");
        }
        if (command === "python3" || command === "node") return passedSpawn("tests ok\n");
        if (command === "git" && args.join(" ") === "add -- src/example.ts") return passedSpawn("");
        if (command === "git" && args[0] === "commit") {
          return passedSpawn("[main abc123] bench(terminal): improve kestrel hello-world iteration 1\n");
        }
        if (command === "git" && args.join(" ") === "rev-parse HEAD") return passedSpawn("abc123\n");
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", HOME: tmp, DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 0);
    assert.equal(verificationTbRuns.length, 1);
    const verificationRunId = readArg(verificationTbRuns[0]?.args ?? [], "--run-id");
    const verificationRunIndex = calls.findIndex((call) =>
      call.command === "tb" &&
      call.args[0] === "run" &&
      call.args.includes(verificationRunId)
    );
    assert.notEqual(verificationRunIndex, -1);
    const preVerificationCleanup = calls[verificationRunIndex - 1];
    const postVerificationCleanup = calls[verificationRunIndex + 1];
    assert.equal(preVerificationCleanup?.command, "docker");
    assert.equal(preVerificationCleanup?.args[0], "compose");
    assert.equal(preVerificationCleanup?.args.some((arg) => arg.includes(verificationRunId)), true);
    assert.equal(postVerificationCleanup?.command, "docker");
    assert.equal(postVerificationCleanup?.args[0], "compose");
    assert.equal(postVerificationCleanup?.args.some((arg) => arg.includes(verificationRunId)), true);
    assert.equal(
      verificationTbRuns[0]?.args.includes("benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent"),
      true,
    );
    assert.equal(verificationTbRuns[0]?.args.filter((arg) => arg === "--task-id").length, 1);
    const task = readLatestQueue(tmp).tasks[0];
    assert.equal(task?.status, "passed");
    assert.equal(task?.adapter_runs?.kestrel?.attempts, 2);
    const cleanupOutput = readFileSync(
      path.join(readLatestImproveRoot(tmp), "task-001-hello-world", "docker-cleanup.txt"),
      "utf8",
    );
    assert.match(cleanupOutput, new RegExp(escapeRegExp(verificationRunId), "u"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench improve full queue continues after a repaired task", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-queue-continue-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  let codexRan = false;
  let statusCalls = 0;
  try {
    const cacheRoot = path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1");
    for (const taskId of ["hello-world", "play-zork"]) {
      mkdirSync(path.join(cacheRoot, taskId), { recursive: true });
      writeFileSync(path.join(cacheRoot, taskId, "docker-compose.yaml"), "services: {}\n");
    }

    const code = await runTerminalBench(["improve", "--full", "--adapter", "kestrel", "--max-iterations", "2"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") return passedSpawn("tb help\n");
        if (command === "uv" && args.join(" ") === "--version") return passedSpawn("uv ok\n");
        if (command === "docker" && args.join(" ") === "info") return passedSpawn("docker ok\n");
        if (command === "docker" && args[0] === "compose") return passedSpawn("cleanup ok\n");
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") {
          statusCalls += 1;
          return statusCalls === 1 ? passedSpawn("") : passedSpawn(" M src/example.ts\n");
        }
        if (command === "tb" && args[0] === "run") {
          const taskId = readArg(args, "--task-id");
          const pass = taskId === "play-zork" || codexRan;
          writeTbResults(tmp, args, pass);
          return pass ? passedSpawn("resolved\n") : failedSpawn("unresolved\n");
        }
        if (command === "codex") {
          codexRan = true;
          return passedSpawn("patched\n");
        }
        if (command === "python3" || command === "node") return passedSpawn("tests ok\n");
        if (command === "git" && args.join(" ") === "add -- src/example.ts") return passedSpawn("");
        if (command === "git" && args[0] === "commit") {
          return passedSpawn("[main abc123] bench(terminal): improve kestrel hello-world iteration 1\n");
        }
        if (command === "git" && args.join(" ") === "rev-parse HEAD") return passedSpawn("abc123\n");
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", HOME: tmp, DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 0);
    const tbRuns = calls.filter((call) => call.command === "tb" && call.args[0] === "run");
    assert.equal(tbRuns.length, 3);
    assert.deepEqual(tbRuns.map((run) => readArg(run.args, "--task-id")), [
      "hello-world",
      "hello-world",
      "play-zork",
    ]);

    const queue = readLatestQueue(tmp);
    assert.equal(queue.tasks.find((task) => task.task_id === "hello-world")?.status, "passed");
    assert.equal(queue.tasks.find((task) => task.task_id === "play-zork")?.status, "passed");

    const summary = JSON.parse(
      readFileSync(path.join(readLatestImproveRoot(tmp), "summary.json"), "utf8"),
    ) as { status?: string };
    assert.equal(summary.status, "passed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench improve full queue uses distinct task-scoped run ids for fast same-adapter tasks", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-queue-runids-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    const cacheRoot = path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1");
    for (const taskId of ["play-zork", "hello-world"]) {
      mkdirSync(path.join(cacheRoot, taskId), { recursive: true });
      writeFileSync(path.join(cacheRoot, taskId, "docker-compose.yaml"), "services: {}\n");
    }

    const code = await runTerminalBench(["improve", "--full", "--adapter", "kestrel", "--max-iterations", "1"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") return passedSpawn("tb help\n");
        if (command === "uv" && args.join(" ") === "--version") return passedSpawn("uv ok\n");
        if (command === "docker" && args.join(" ") === "info") return passedSpawn("docker ok\n");
        if (command === "docker" && args[0] === "compose") return passedSpawn("cleanup ok\n");
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") return passedSpawn("");
        if (command === "tb" && args[0] === "run") {
          const taskId = readArg(args, "--task-id");
          const pass = taskId === "hello-world";
          writeTbResults(tmp, args, pass);
          return pass ? passedSpawn("resolved\n") : failedSpawn("unresolved\n");
        }
        if (command === "codex") return failedSpawn("stop before repair completes\n");
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", HOME: tmp, DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 1);
    const tbRuns = calls.filter((call) => call.command === "tb" && call.args[0] === "run");
    assert.equal(tbRuns.length, 2);
    const runIds = tbRuns.map((run) => readArg(run.args, "--run-id"));
    assert.equal(new Set(runIds).size, 2);
    assert.equal(new Set(runIds.map((runId) => path.join(tmp, "runs", runId))).size, 2);
    assert.ok(runIds.every((runId) => /kestrel-terminal-bench-(hello-world|play-zork)-queue-\d{14}-\d{3}-01/u.test(runId)));
    for (const run of tbRuns) {
      assert.equal(run.args.filter((arg) => arg === "--task-id").length, 1);
    }

    const queue = readLatestQueue(tmp);
    assert.equal(queue.tasks.find((task) => task.task_id === "hello-world")?.status, "passed");
    assert.equal(queue.tasks.find((task) => task.task_id === "play-zork")?.status, "failed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench discovers task ids from cached dataset folders", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-tasks-"));
  try {
    mkdirSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "hello-world"), { recursive: true });
    mkdirSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork"), { recursive: true });
    writeFileSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "README.md"), "ignore me");
    writeFileSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "hello-world", "docker-compose.yaml"), "services: {}\n");
    writeFileSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork", "docker-compose.yaml"), "services: {}\n");

    assert.deepEqual(discoverTerminalBenchTaskIds({
      dataset: "terminal-bench-core==0.1.1",
      homeDir: tmp,
      cwd: "/repo",
    }), ["hello-world", "play-zork"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench discovers task ids across split cache roots", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-home-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-cwd-"));
  try {
    mkdirSync(path.join(homeDir, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "hello-world"), { recursive: true });
    mkdirSync(path.join(cwd, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork"), { recursive: true });
    writeFileSync(path.join(homeDir, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "hello-world", "docker-compose.yaml"), "services: {}\n");
    writeFileSync(path.join(cwd, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork", "docker-compose.yaml"), "services: {}\n");

    assert.deepEqual(discoverTerminalBenchTaskIds({
      dataset: "terminal-bench-core==0.1.1",
      homeDir,
      cwd,
    }), ["hello-world", "play-zork"]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("terminal bench rejects malformed dataset specs during task discovery", () => {
  for (const dataset of [
    "terminal-bench-core",
    "terminal-bench-core==",
    "==0.1.1",
    "terminal-bench-core==0.1.1==extra",
  ]) {
    assert.throws(
      () => discoverTerminalBenchTaskIds({
        dataset,
        homeDir: "/home",
        cwd: "/repo",
      }),
      new Error(`Unsupported Terminal-Bench dataset format: ${dataset}`),
    );
  }
});

test("terminal bench orchestrator maps the deprecated runtime command to canonical run", () => {
  const options = parseTerminalBenchArgs(["runtime"]);
  const commands = buildTerminalBenchCommands(options);

  assert.equal(options.mode, "run");
  assert.equal(options.adapter, "kestrel");
  assert.equal(options.taskId, undefined);
  assert.deepEqual(commands, [
    {
      adapter: "kestrel",
      args: [
        "run",
        "--dataset",
        "terminal-bench-core==0.1.1",
        "--agent-import-path",
        "benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent",
      ],
    },
  ]);
});

test("terminal bench orchestrator supports targeted canonical adapter runs", () => {
  const options = parseTerminalBenchArgs([
    "--",
    "run",
    "--dataset",
    "terminal-bench-core==0.1.1",
    "--task-id",
    "custom-task",
    "--dry-run",
    "--tb-bin",
    "/opt/bin/tb",
  ]);

  assert.equal(options.adapter, "kestrel");
  assert.equal(options.taskId, "custom-task");
  assert.equal(options.dryRun, true);
  assert.equal(options.tbBin, "/opt/bin/tb");
  assert.equal(
    formatCommand(options.tbBin, buildTerminalBenchCommands(options)[0]?.args ?? []),
    "/opt/bin/tb run --dataset terminal-bench-core==0.1.1 --agent-import-path benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent --task-id custom-task",
  );
});

test("terminal bench orchestrator reports actionable preflight issues", () => {
  const issues = collectPreflightIssues({
    tbVersion: failedSpawn("ENOENT"),
    uvVersion: failedSpawn("uv missing"),
    dockerInfo: failedSpawn("docker down"),
    env: {},
  });

  assert.deepEqual(issues, [
    "Terminal-Bench CLI is not available, and uv is not installed. Run: pnpm run bench:terminal -- bootstrap",
    "Docker is not available. Run: pnpm run bench:terminal -- bootstrap",
    "Kestrel benchmarks require OPENROUTER_API_KEY.",
  ]);
});

test("terminal bench preflight reports unwritable Docker Buildx activity directory", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-buildx-preflight-"));
  const activityDir = path.join(tmp, "buildx", "activity");
  try {
    mkdirSync(activityDir, { recursive: true });
    chmodSync(activityDir, 0o500);

    const issues = collectPreflightIssues({
      tbVersion: passedSpawn(),
      dockerInfo: passedSpawn(),
      env: {
        DOCKER_CONFIG: tmp,
        OPENROUTER_API_KEY: "sk-test",
      },
    });

    assert.match(issues.join("\n"), /Docker Buildx activity directory is not writable/u);
    assert.match(issues.join("\n"), /host approval\/unsandboxed execution/u);
  } finally {
    chmodSync(activityDir, 0o700);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench orchestrator tells operators to install tb when uv exists", () => {
  const issues = collectPreflightIssues({
    tbVersion: failedSpawn("tb missing"),
    uvVersion: passedSpawn(),
    dockerInfo: passedSpawn(),
    env: { OPENROUTER_API_KEY: "sk-test" },
  });

  assert.deepEqual(issues, [
    "Terminal-Bench CLI is not available. Run: pnpm run bench:terminal -- bootstrap",
  ]);
});

test("terminal bench orchestrator resolves tb from uv tool bin when PATH misses it", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const resolution = resolveTerminalBenchBinary({
    requestedBinary: "tb",
    env: {},
    spawn: ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      if (command === "tb") {
        return failedSpawn("tb missing");
      }
      if (command === "uv" && args.join(" ") === "tool dir --bin") {
        return passedSpawn("/Users/example/.local/bin\n");
      }
      if (command === "/Users/example/.local/bin/tb") {
        return passedSpawn("tb 0.1.0\n");
      }
      return failedSpawn(`unexpected ${command}`);
    }) as unknown as typeof import("node:child_process").spawnSync,
  });

  assert.equal(resolution.binary, "/Users/example/.local/bin/tb");
  assert.equal(resolution.version.status, 0);
  assert.deepEqual(calls, [
    { command: "tb", args: ["--help"] },
    { command: "uv", args: ["tool", "dir", "--bin"] },
    { command: "/Users/example/.local/bin/tb", args: ["--help"] },
  ]);
});

test("terminal bench orchestrator uses resolved uv tool tb for runs", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let stdout = "";
  const code = await runTerminalBench(["preflight"], {
    spawn: ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      if (command === "tb") {
        return failedSpawn("tb missing");
      }
      if (command === "uv" && args.join(" ") === "tool dir --bin") {
        return passedSpawn("/Users/example/.local/bin\n");
      }
      if (command === "/Users/example/.local/bin/tb" && args.join(" ") === "--help") {
        return passedSpawn("tb 0.1.0\n");
      }
      if (command === "uv" && args.join(" ") === "--version") {
        return passedSpawn("uv 0.9.17\n");
      }
      if (command === "docker" && args.join(" ") === "info") {
        return passedSpawn("docker ok\n");
      }
      if (command === "/Users/example/.local/bin/tb" && args[0] === "run") {
        return passedSpawn("");
      }
      return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
    }) as unknown as typeof import("node:child_process").spawnSync,
    env: { OPENROUTER_API_KEY: "sk-test", DOCKER_HOST: "unix:///docker.sock" },
    cwd: "/repo",
    stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
    stderr: { write: () => true },
  });

  assert.equal(code, 0);
  assert.match(stdout, /\/Users\/example\/.local\/bin\/tb run/u);
  assert.equal(calls.filter((call) => call.command === "/Users/example/.local/bin/tb" && call.args[0] === "run").length, 1);
});

test("terminal bench reports artifact pass with failed Kestrel adapter as local failure", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-agent-failed-"));
  let stderr = "";
  try {
    const code = await runTerminalBench(["run", "--task-id", "hello-world"], {
      spawn: ((command: string, args: readonly string[]) => {
        if (command === "tb" && args.join(" ") === "--help") {
          return passedSpawn("tb 0.1.0\n");
        }
        if (command === "uv" && args.join(" ") === "--version") {
          return passedSpawn("uv 0.9.17\n");
        }
        if (command === "docker" && args.join(" ") === "info") {
          return passedSpawn("docker ok\n");
        }
        if (command === "tb" && args[0] === "run") {
          writeTbResults(tmp, args, true);
          writeAdapterResult(tmp, args, "kestrel", "failed");
          return passedSpawn("resolved\n");
        }
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    assert.equal(code, 1);
    assert.match(stderr, /artifact_passed_but_agent_failed/u);
    assert.match(stderr, /status=failed/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench reports unresolved task with failed Kestrel adapter kind", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-unresolved-agent-kind-"));
  let stderr = "";
  try {
    const code = await runTerminalBench(["run", "--task-id", "hello-world"], {
      spawn: ((command: string, args: readonly string[]) => {
        if (command === "tb" && args.join(" ") === "--help") {
          return passedSpawn("tb 0.1.0\n");
        }
        if (command === "uv" && args.join(" ") === "--version") {
          return passedSpawn("uv 0.9.17\n");
        }
        if (command === "docker" && args.join(" ") === "info") {
          return passedSpawn("docker ok\n");
        }
        if (command === "tb" && args[0] === "run") {
          writeTbResults(tmp, args, false);
          writeAdapterResult(tmp, args, "kestrel", "failed", "runtime_external_deadline_exhausted");
          return passedSpawn("unresolved\n");
        }
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    assert.equal(code, 1);
    assert.match(stderr, /runtime_external_deadline_exhausted/u);
    assert.match(stderr, /Terminal-Bench reported unresolved tasks: hello-world/u);
    assert.match(stderr, /kestrel-terminal-bench-hello-world\.json/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench reports verifier failure after completed Kestrel adapter", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-verifier-failed-"));
  let stderr = "";
  try {
    const code = await runTerminalBench(["run", "--task-id", "hello-world"], {
      spawn: ((command: string, args: readonly string[]) => {
        if (command === "tb" && args.join(" ") === "--help") {
          return passedSpawn("tb 0.1.0\n");
        }
        if (command === "uv" && args.join(" ") === "--version") {
          return passedSpawn("uv 0.9.17\n");
        }
        if (command === "docker" && args.join(" ") === "info") {
          return passedSpawn("docker ok\n");
        }
        if (command === "tb" && args[0] === "run") {
          writeTbResults(tmp, args, false, "test_timeout");
          writeAdapterResult(tmp, args, "kestrel", "completed");
          return passedSpawn("unresolved\n");
        }
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    assert.equal(code, 1);
    assert.match(stderr, /tb_verifier_failed_after_adapter_completed/u);
    assert.match(stderr, /Kestrel adapter completed/u);
    assert.match(stderr, /failure_mode=test_timeout/u);
    assert.doesNotMatch(stderr, /kestrel_run_failed/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench outcome retains verifier timeout after completed adapter", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-outcome-"));
  try {
    const args = ["run", "--run-id", "kestrel-cli-test"];
    writeTbResults(tmp, args, false, "test_timeout");
    writeAdapterResult(tmp, args, "kestrel", "completed");
    const runDir = path.join(tmp, "runs", "kestrel-cli-test");
    writeFileSync(
      path.join(runDir, "results.json"),
      JSON.stringify({
        n_resolved: 0,
        n_unresolved: 1,
        accuracy: 0,
        unresolved_ids: ["hello-world"],
        results: [{ task_id: "hello-world", failure_mode: "test_timeout" }],
      }),
    );

    const outcome = readTerminalBenchOutcome(path.join(runDir, "results.json"), runDir, "kestrel");

    assert.equal(outcome?.failureMode, "test_timeout");
    assert.equal(outcome?.adapterCompletedButBenchmarkFailed, true);
    assert.deepEqual(outcome?.adapterFailures, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench outcome classifies setup failure before adapter start", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-setup-before-adapter-"));
  try {
    const runDir = path.join(tmp, "runs", "kestrel-cli-test");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "run.log"), "docker buildx activity write failed\n", "utf8");
    writeFileSync(
      path.join(runDir, "results.json"),
      JSON.stringify({
        n_resolved: 0,
        n_unresolved: 1,
        accuracy: 0,
        unresolved_ids: ["blind-maze-explorer-5x5"],
        results: [{
          task_id: "blind-maze-explorer-5x5",
          is_resolved: null,
          failure_mode: "unknown_agent_error",
          agent_started_at: null,
        }],
      }),
      "utf8",
    );

    const outcome = readTerminalBenchOutcome(path.join(runDir, "results.json"), runDir, "kestrel");

    assert.equal(outcome?.benchmarkSetupFailure?.kind, "benchmark_setup_failed_before_adapter");
    assert.match(outcome?.benchmarkSetupFailure?.notes ?? "", /failure_mode=unknown_agent_error/u);
    assert.equal(outcome?.benchmarkSetupFailure?.runLogPath, "run.log");
    assert.equal(outcome?.adapterCompletedButBenchmarkFailed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench classifies tb run timeout before results as setup timeout", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-setup-timeout-"));
  let stderr = "";
  const timeouts: unknown[] = [];
  try {
    const code = await runTerminalBench(["run", "--task-id", "build-initramfs-qemu"], {
      spawn: ((command: string, args: readonly string[], options?: { timeout?: number }) => {
        if (command === "tb" && args.join(" ") === "--help") {
          return passedSpawn("tb 0.1.0\n");
        }
        if (command === "uv" && args.join(" ") === "--version") {
          return passedSpawn("uv 0.9.17\n");
        }
        if (command === "docker" && args.join(" ") === "info") {
          return passedSpawn("docker ok\n");
        }
        if (command === "tb" && args[0] === "run") {
          timeouts.push(options?.timeout);
          return timedOutSpawn("spawnSync tb ETIMEDOUT");
        }
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: {
        OPENROUTER_API_KEY: "sk-test",
        KESTREL_TBENCH_COMMAND_TIMEOUT_SEC: "12",
      },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    assert.equal(code, 1);
    assert.deepEqual(timeouts, [12_000]);
    assert.match(stderr, /benchmark_setup_timeout/u);
    assert.doesNotMatch(stderr, /kestrel_run_failed/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench cleanup no-ops without Docker when no queues exist", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-cleanup-empty-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  let stdout = "";
  try {
    const code = await runTerminalBench(["cleanup"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test" },
      cwd: tmp,
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: () => true },
    });

    assert.equal(code, 0);
    assert.match(stdout, /no recorded improvement queues found; cleaned=0/u);
    assert.equal(calls.some((call) => call.command === "docker" && call.args.join(" ") === "info"), false);
    assert.equal(calls.some((call) => call.command === "docker" && call.args[0] === "compose"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench cleanup removes only known queued run projects", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-cleanup-"));
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  try {
    const queueRoot = path.join(tmp, "runs", "terminal-bench-improve", "session");
    mkdirSync(queueRoot, { recursive: true });
    writeFileSync(path.join(queueRoot, "queue.json"), JSON.stringify({
      dataset: "terminal-bench-core==0.1.1",
      adapter: "both",
      created_at: "2026-04-28T00:00:00.000Z",
      tasks: [
        {
          task_id: "play-zork",
          status: "failed",
          attempts: 1,
          last_run_id: "kestrel-cli-test",
          last_failure_kind: "tb_verifier_failed",
          adapter_runs: {
            cli: {
              status: "failed",
              attempts: 1,
              last_run_id: "kestrel-cli-test",
              last_failure_kind: "tb_verifier_failed",
            },
            runtime: {
              status: "passed",
              attempts: 1,
              last_run_id: "kestrel-runtime-test",
              last_failure_kind: null,
            },
          },
        },
      ],
    }));
    mkdirSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork"), { recursive: true });
    writeFileSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork", "docker-compose.yaml"), "services: {}\n");

    const code = await runTerminalBench(["cleanup"], {
      spawn: ((command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({
          command,
          args: [...args],
          ...(options?.env !== undefined ? { env: options.env } : {}),
        });
        if (command === "docker" && args.join(" ") === "info") return passedSpawn("docker ok\n");
        if (command === "docker" && args[0] === "compose") return passedSpawn("cleaned\n");
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", HOME: tmp, DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 0);
    assert.equal(calls.some((call) => call.command === "tb" && call.args[0] === "run"), false);
    assert.equal(calls.some((call) => call.command === "git"), false);
    assert.equal(calls.some((call) => call.command === "docker" && call.args.includes("prune")), false);
    assert.equal(calls.some((call) => call.command === "docker" && call.args.includes("system")), false);
    assert.equal(calls.some((call) => call.command === "docker" && call.args.includes("--rmi")), false);
    const dockerComposeCalls = calls.filter((call) => call.command === "docker" && call.args[0] === "compose");
    assert.equal(dockerComposeCalls.length, 2);
    assert.equal(
      dockerComposeCalls.some((call) => call.args.includes("play-zork-1-of-1-kestrel-cli-test")),
      true,
    );
    assert.equal(
      dockerComposeCalls.some((call) => call.args.includes("play-zork-1-of-1-kestrel-runtime-test")),
      true,
    );
    assert.equal(
      dockerComposeCalls.every((call) => call.env?.T_BENCH_TASK_DOCKER_CLIENT_CONTAINER_NAME !== undefined),
      true,
    );
    assert.equal(
      dockerComposeCalls.every((call) => call.env?.T_BENCH_TASK_DOCKER_CLIENT_IMAGE_NAME === "tb__play-zork__client"),
      true,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench orchestrator exposes bootstrap mode", () => {
  const options = parseTerminalBenchArgs(["bootstrap", "--dry-run"]);

  assert.equal(options.mode, "bootstrap");
  assert.equal(options.dryRun, true);
  assert.equal(options.adapter, "kestrel");
});

test("terminal bench bootstrap dry-run owns uv, terminal-bench, and Docker setup", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let stdout = "";
  let stderr = "";
  const code = await runTerminalBench(["bootstrap", "--dry-run"], {
    spawn: ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      if (command === "tb") {
        return failedSpawn("tb missing");
      }
      if (command === "uv") {
        return failedSpawn("uv missing");
      }
      if (command === "brew") {
        return passedSpawn();
      }
      if (command === "docker") {
        return failedSpawn("docker down");
      }
      return passedSpawn();
    }) as unknown as typeof import("node:child_process").spawnSync,
    env: { DOCKER_HOST: "unix:///docker.sock" },
    cwd: "/repo",
    platform: "darwin",
    stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    { command: "tb", args: ["--help"] },
    { command: "uv", args: ["tool", "dir", "--bin"] },
    { command: "uv", args: ["--version"] },
    { command: "brew", args: ["--version"] },
    { command: "docker", args: ["info"] },
  ]);
  assert.match(stdout, /would run brew install uv/u);
  assert.match(stdout, /would run uv tool install --python 3\.13 --reinstall terminal-bench/u);
  assert.match(stdout, /would run open -a Docker/u);
  assert.match(stdout, /would run docker pull ghcr\.io\/laude-institute\/t-bench\/python-3-13:latest/u);
  assert.match(stderr, /bootstrap warning: Kestrel benchmarks require OPENROUTER_API_KEY/u);
});

test("terminal bench bootstrap repairs a broken uv tool install", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const code = await runTerminalBench(["bootstrap"], {
    spawn: ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      if (command === "tb") {
        return failedSpawn("tb missing from PATH");
      }
      if (command === "uv" && args.join(" ") === "tool dir --bin") {
        return passedSpawn("/Users/example/.local/bin\n");
      }
      if (command === "/Users/example/.local/bin/tb" && args.join(" ") === "--help") {
        const priorChecks = calls.filter(
          (call) => call.command === "/Users/example/.local/bin/tb" && call.args.join(" ") === "--help",
        ).length;
        return priorChecks === 1 ? failedSpawn("TypeError: 'function' object is not subscriptable") : passedSpawn("tb 0.1.0\n");
      }
      if (command === "uv" && args.join(" ") === "--version") {
        return passedSpawn("uv 0.9.17\n");
      }
      if (command === "uv" && args.join(" ") === "tool install --python 3.13 --reinstall terminal-bench") {
        return passedSpawn("installed\n");
      }
      if (command === "docker" && args.join(" ") === "info") {
        return passedSpawn("docker ok\n");
      }
      if (command === "docker" && args.join(" ") === "pull ghcr.io/laude-institute/t-bench/python-3-13:latest") {
        return passedSpawn("pulled\n");
      }
      return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
    }) as unknown as typeof import("node:child_process").spawnSync,
    env: { OPENROUTER_API_KEY: "sk-test", DOCKER_HOST: "unix:///docker.sock" },
    cwd: "/repo",
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(code, 0);
  assert.ok(
    calls.some((call) => call.command === "uv" && call.args.join(" ") === "tool install --python 3.13 --reinstall terminal-bench"),
  );
});

test("terminal bench orchestrator resolves Docker host from the active Docker context", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const dockerHost = resolveDockerHost({
    env: {},
    spawn: ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      if (command === "docker" && args.join(" ") === "context inspect --format {{json .Endpoints.docker.Host}}") {
        return passedSpawn('"unix:///Users/example/.docker/run/docker.sock"\n');
      }
      return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
    }) as unknown as typeof import("node:child_process").spawnSync,
  });

  assert.equal(dockerHost, "unix:///Users/example/.docker/run/docker.sock");
  assert.deepEqual(calls, [
    {
      command: "docker",
      args: ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
    },
  ]);
});

test("terminal bench orchestrator accepts OpenRouter provider key", () => {
  const issues = collectPreflightIssues({
    tbVersion: passedSpawn(),
    dockerInfo: passedSpawn(),
    env: { OPENROUTER_API_KEY: "sk-test" },
  });

  assert.deepEqual(issues, []);
});

test("terminal bench orchestrator resolves only the OpenRouter benchmark provider", () => {
  assert.equal(resolveBenchmarkModelProvider({ OPENROUTER_API_KEY: "sk-test" }), "openrouter");
  assert.equal(resolveBenchmarkModelProvider({ ANTHROPIC_API_KEY: "sk-test" }), undefined);
  assert.equal(resolveBenchmarkModelProvider({
    OPENROUTER_API_KEY: "sk-test",
    KESTREL_TBENCH_MODEL_PROVIDER: "openrouter",
  }), undefined);
});

test("terminal bench warns when non-OpenRouter provider keys are present with OpenRouter", async () => {
  let stderr = "";
  const code = await runTerminalBench(["run", "--task-id", "hello-world", "--dry-run"], {
    spawn: (() => failedSpawn("unexpected spawn")) as unknown as typeof import("node:child_process").spawnSync,
    env: {
      OPENROUTER_API_KEY: "sk-test",
      OPENAI_API_KEY: "ignored",
      DOCKER_HOST: "unix:///docker.sock",
    },
    cwd: "/repo",
    stdout: { write: () => true },
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
  });

  assert.equal(code, 0);
  assert.match(stderr, /Ignoring non-OpenRouter provider key\(s\) for Kestrel benchmarks: OPENAI_API_KEY/u);
});

test("terminal bench improve clean-worktree check reports dirty files", () => {
  const clean = checkCleanWorktree({
    spawn: ((command: string, args: readonly string[]) => {
      assert.equal(command, "git");
      assert.deepEqual([...args], ["status", "--porcelain", "--untracked-files=all"]);
      return passedSpawn(" M scripts/terminal-bench.ts\n");
    }) as unknown as typeof import("node:child_process").spawnSync,
    env: {},
    cwd: "/repo",
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(clean.clean, false);
  assert.match(clean.details, /scripts\/terminal-bench\.ts/u);
});

test("terminal bench improve builds Codex exec command", () => {
  assert.deepEqual(buildCodexExecArgs("/repo"), ["exec", "--full-auto", "-m", "gpt-5.4", "--cd", "/repo", "-"]);
  assert.deepEqual(
    buildCodexExecArgs("/repo", { KESTREL_TBENCH_CODEX_MODEL: "gpt-5.2" }),
    ["exec", "--full-auto", "-m", "gpt-5.2", "--cd", "/repo", "-"],
  );
});

test("terminal bench improve builds a raw evidence packet from run artifacts", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-packet-"));
  try {
    const runDir = path.join(tmp, "runs", "kestrel-cli-test");
    mkdirSync(path.join(runDir, "hello-world", "trial", "sessions"), { recursive: true });
    writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ n_unresolved: 1 }));
    writeFileSync(path.join(runDir, "run.log"), "Running task: hello-world\n");
    writeFileSync(path.join(runDir, "hello-world", "trial", "sessions", "tests.log"), "FAILED test_hello_file_content\n");

    const packet = buildFailurePacket({
      iteration: 1,
      dataset: "terminal-bench-core==0.1.1",
      taskId: "hello-world",
      cwd: tmp,
      runs: [
        {
          adapter: "kestrel",
          runId: "kestrel-cli-test",
          args: ["run", "--task-id", "hello-world"],
          runDir,
          status: 1,
          outcome: {
            nResolved: 0,
            nUnresolved: 1,
            accuracy: 0,
            unresolvedIds: ["hello-world"],
            adapterFailures: [],
            artifactPassedButAgentFailed: false,
            adapterCompletedButBenchmarkFailed: false,
          },
        },
      ],
    });

    assert.match(packet, /Terminal-Bench Failure Packet/u);
    assert.match(packet, /FAILED test_hello_file_content/u);
    assert.match(packet, /runs\/kestrel-cli-test\/run\.log/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench improve refuses to start from a dirty worktree", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-dirty-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  let stderr = "";
  try {
    const code = await runTerminalBench(["improve"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") {
          return passedSpawn("tb help\n");
        }
        if (command === "uv" && args.join(" ") === "--version") {
          return passedSpawn("uv ok\n");
        }
        if (command === "docker" && args.join(" ") === "info") {
          return passedSpawn("docker ok\n");
        }
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") {
          return passedSpawn(" M package.json\n");
        }
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    assert.equal(code, 1);
    assert.match(stderr, /requires a clean git worktree/u);
    assert.equal(calls.some((call) => call.command === "tb" && call.args[0] === "run"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench improve does not commit when Codex repair fails", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-codex-fail-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    const code = await runTerminalBench(["improve", "--max-iterations", "1"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") {
          return passedSpawn("tb help\n");
        }
        if (command === "uv" && args.join(" ") === "--version") {
          return passedSpawn("uv ok\n");
        }
        if (command === "docker" && args.join(" ") === "info") {
          return passedSpawn("docker ok\n");
        }
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") {
          return passedSpawn("");
        }
        if (command === "tb" && args[0] === "run") {
          writeTbResults(tmp, args, false);
          return failedSpawn("unresolved\n");
        }
        if (command === "codex") {
          assert.deepEqual([...args], ["exec", "--full-auto", "-m", "gpt-5.4", "--cd", tmp, "-"]);
          return failedSpawn("codex failed\n");
        }
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 1);
    assert.equal(calls.some((call) => call.command === "git" && call.args[0] === "commit"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench improve does not commit when verification fails", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-verify-fail-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  let statusCalls = 0;
  try {
    const code = await runTerminalBench(["improve", "--max-iterations", "1"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") {
          return passedSpawn("tb help\n");
        }
        if (command === "uv" && args.join(" ") === "--version") {
          return passedSpawn("uv ok\n");
        }
        if (command === "docker" && args.join(" ") === "info") {
          return passedSpawn("docker ok\n");
        }
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") {
          statusCalls += 1;
          return statusCalls === 1 ? passedSpawn("") : passedSpawn(" M src/example.ts\n");
        }
        if (command === "tb" && args[0] === "run") {
          writeTbResults(tmp, args, false);
          return failedSpawn("unresolved\n");
        }
        if (command === "codex") {
          return passedSpawn("patched\n");
        }
        if (command === "python3") {
          return failedSpawn("unit failed\n");
        }
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 1);
    assert.equal(calls.some((call) => call.command === "git" && call.args[0] === "commit"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench repair policy rejects benchmark artifacts", () => {
  const result = validateTerminalBenchRepairPolicy([
    " M src/runtime/kestrelHome.ts",
    " M runs/kestrel-cli-test/results.json",
    "?? benchmarks/terminal_bench/__pycache__/agents.cpython-313.pyc",
    "",
  ].join("\n"));

  assert.equal(result.passed, false);
  assert.deepEqual(result.violations, [
    "Forbidden Terminal-Bench repair path: runs/kestrel-cli-test/results.json",
    "Forbidden Terminal-Bench repair path: benchmarks/terminal_bench/__pycache__/agents.cpython-313.pyc",
  ]);
  assert.deepEqual(result.changedPaths, [
    "src/runtime/kestrelHome.ts",
    "runs/kestrel-cli-test/results.json",
    "benchmarks/terminal_bench/__pycache__/agents.cpython-313.pyc",
  ]);
});

test("terminal bench repair policy allows Kestrel runtime and tooling hardening", () => {
  const result = validateTerminalBenchRepairPolicy([
    " M src/devshell/TerminalBenchDevShellService.ts",
    " M cli/contracts.ts",
    " M tests/unit/terminal-bench-dev-shell-service.test.ts",
    "?? docs/plans/runtime-contract-hardening.md",
    "",
  ].join("\n"));

  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.changedPaths, [
    "src/devshell/TerminalBenchDevShellService.ts",
    "cli/contracts.ts",
    "tests/unit/terminal-bench-dev-shell-service.test.ts",
    "docs/plans/runtime-contract-hardening.md",
  ]);
});

test("terminal bench improve stops when Codex edits forbidden benchmark artifacts", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-policy-fail-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  let statusCalls = 0;
  let stderr = "";
  try {
    const code = await runTerminalBench(["improve", "--max-iterations", "1"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") {
          return passedSpawn("tb help\n");
        }
        if (command === "uv" && args.join(" ") === "--version") {
          return passedSpawn("uv ok\n");
        }
        if (command === "docker" && args.join(" ") === "info") {
          return passedSpawn("docker ok\n");
        }
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") {
          statusCalls += 1;
          return statusCalls === 1
            ? passedSpawn("")
            : passedSpawn(" M runs/kestrel-cli-test/results.json\n");
        }
        if (command === "tb" && args[0] === "run") {
          writeTbResults(tmp, args, false);
          return failedSpawn("unresolved\n");
        }
        if (command === "codex") {
          return passedSpawn("patched\n");
        }
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    assert.equal(code, 1);
    assert.match(stderr, /repair changed forbidden benchmark\/artifact paths/u);
    assert.equal(calls.some((call) => call.command === "python3"), false);
    assert.equal(calls.some((call) => call.command === "git" && call.args[0] === "commit"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal bench improve commits a verified repair iteration", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-commit-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  let statusCalls = 0;
  let tbRuns = 0;
  let stdout = "";
  try {
    const code = await runTerminalBench(["improve", "--max-iterations", "2"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") {
          return passedSpawn("tb help\n");
        }
        if (command === "uv" && args.join(" ") === "--version") {
          return passedSpawn("uv ok\n");
        }
        if (command === "docker" && args.join(" ") === "info") {
          return passedSpawn("docker ok\n");
        }
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") {
          statusCalls += 1;
          return statusCalls === 1 ? passedSpawn("") : passedSpawn(" M src/example.ts\n");
        }
        if (command === "tb" && args[0] === "run") {
          tbRuns += 1;
          const pass = tbRuns > 1;
          writeTbResults(tmp, args, pass);
          return pass ? passedSpawn("resolved\n") : failedSpawn("unresolved\n");
        }
        if (command === "codex") {
          return passedSpawn("patched\n");
        }
        if (command === "python3" || command === "node") {
          return passedSpawn("tests ok\n");
        }
        if (command === "git" && args.join(" ") === "add -- src/example.ts") {
          return passedSpawn("");
        }
        if (command === "git" && args[0] === "commit") {
          return passedSpawn("[main abc123] bench(terminal): improve kestrel hello-world iteration 1\n");
        }
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return passedSpawn("abc123\n");
        }
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENROUTER_API_KEY: "sk-test", DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: () => true },
    });

    assert.equal(code, 0);
    assert.ok(calls.some((call) => call.command === "git" && call.args.join(" ") === "add -- src/example.ts"));
    assert.equal(calls.some((call) => call.command === "git" && call.args.join(" ") === "add -A -- ."), false);
    assert.ok(calls.some((call) => call.command === "git" && call.args.join(" ") === "commit -m bench(terminal): improve kestrel hello-world iteration 1"));
    assert.equal(tbRuns, 3);
    assert.match(stdout, /improve: failure packet written/u);
    assert.match(stdout, /improve: Codex repair started: codex exec --full-auto/u);
    assert.match(stdout, /improve: Codex repair exited status=0/u);
    assert.match(stdout, /improve: repair policy passed/u);
    assert.match(stdout, /improve: verification check started: python3 -m unittest/u);
    assert.match(stdout, /improve: benchmark verification passed: kestrel/u);
    assert.match(stdout, /improve: committing verified repair/u);
    assert.match(stdout, /improve: committed abc123/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function passedSpawn(stdout = "ok") {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
  };
}

function failedSpawn(message: string) {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(message),
    status: 1,
    signal: null,
    error: new Error(message),
  };
}

function timedOutSpawn(message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = "ETIMEDOUT";
  return {
    pid: 1,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(message),
    status: null,
    signal: "SIGTERM",
    error,
  };
}

interface QueueFile {
  tasks: Array<{
    task_id: string;
    status: string;
    last_run_id: string | null;
    last_failure_kind: string | null;
    adapter_runs?: Record<string, {
      status: string;
      attempts: number;
      last_run_id: string | null;
      last_failure_kind: string | null;
    }>;
  }>;
}

function readLatestQueue(cwd: string): QueueFile {
  return JSON.parse(readFileSync(path.join(readLatestImproveRoot(cwd), "queue.json"), "utf8")) as QueueFile;
}

function readLatestImproveRoot(cwd: string): string {
  const improveRoot = path.join(cwd, "runs", "terminal-bench-improve");
  const [timestamp] = readdirSync(improveRoot);
  assert.equal(typeof timestamp, "string");
  return path.join(improveRoot, timestamp as string);
}

function readArg(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  assert.equal(typeof value, "string");
  return value as string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function writeTbResults(cwd: string, args: readonly string[], pass: boolean, failureMode?: string): void {
  const runIdIndex = args.indexOf("--run-id");
  const runId = runIdIndex >= 0 ? args[runIdIndex + 1] : undefined;
  assert.equal(typeof runId, "string");
  const runDir = path.join(cwd, "runs", runId as string);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, "results.json"),
    JSON.stringify(
      {
        n_resolved: pass ? 1 : 0,
        n_unresolved: pass ? 0 : 1,
        accuracy: pass ? 1 : 0,
        unresolved_ids: pass ? [] : ["hello-world"],
        ...(failureMode !== undefined ? { failure_mode: failureMode } : {}),
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(runDir, "run.log"), pass ? "resolved\n" : "unresolved\n");
}

function writeAdapterResult(
  cwd: string,
  args: readonly string[],
  adapter: "kestrel",
  status: string,
  failureKind?: string,
): void {
  const runIdIndex = args.indexOf("--run-id");
  const runId = runIdIndex >= 0 ? args[runIdIndex + 1] : undefined;
  assert.equal(typeof runId, "string");
  const runDir = path.join(cwd, "runs", runId as string);
  const logsDir = path.join(runDir, "hello-world", `hello-world.1-of-1.${runId as string}`, "agent-logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, "kestrel-terminal-bench-hello-world.json"),
    JSON.stringify(
      {
        adapter: "kestrel-terminal-bench",
        task_id: "hello-world",
        status,
        failure_kind: status === "completed" ? "none" : failureKind ?? "kestrel_run_failed",
      },
      null,
      2,
    ),
  );
}
