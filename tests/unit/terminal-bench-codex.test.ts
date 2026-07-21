import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildTerminalBenchCodexCommand,
  parseTerminalBenchCodexArgs,
  readRecentCodexAdapterFailures,
  readRecentHarborRunFailure,
  runTerminalBenchCodex,
} from "../../scripts/terminal-bench-codex.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "terminal bench exposes a tb2-codex shortcut", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const wrapper = readFileSync(path.join(process.cwd(), "scripts", "tb2-codex.sh"), "utf8");

  assert.equal(packageJson.scripts?.["tb2-codex"], "bash scripts/tb2-codex.sh");
  assert.equal(packageJson.scripts?.["bench:terminal:codex"], "node --import tsx scripts/terminal-bench-codex.ts");
  assert.match(wrapper, /\. "\$\{REPO_ROOT\}\/\.env"/u);
  assert.match(wrapper, /pnpm run bench:terminal:codex -- "\$@"/u);
});

contractTest("runtime.hermetic", "terminal bench codex builds Harbor custom agent command", () => {
  const command = buildTerminalBenchCodexCommand(
    parseTerminalBenchCodexArgs(["overfull-hbox", "--artifact", "/app/input.tex"]),
  );

  assert.deepEqual(command.args, [
    "run",
    "-d",
    "terminal-bench@2.0",
    "--agent-import-path",
    "benchmarks.terminal_bench.codex_harbor_agent:CodexHarborCliInstalledAgent",
    "--include-task-name",
    "overfull-hbox",
    "--artifact",
    "/app/input.tex",
  ]);
});

contractTest("runtime.hermetic", "terminal bench codex supports full dataset dry-run", () => {
  const options = parseTerminalBenchCodexArgs(["--full", "--dry-run"]);
  const command = buildTerminalBenchCodexCommand(options);

  assert.equal(options.taskId, undefined);
  assert.equal(options.dryRun, true);
  assert.deepEqual(command.args, [
    "run",
    "-d",
    "terminal-bench@2.0",
    "--agent-import-path",
    "benchmarks.terminal_bench.codex_harbor_agent:CodexHarborCliInstalledAgent",
  ]);
});

contractTest("runtime.hermetic", "terminal bench codex dry-run does not require harbor binary", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let spawnCalls = 0;

  const code = await runTerminalBenchCodex(["overfull-hbox", "--dry-run"], {
    spawn: (() => {
      spawnCalls += 1;
      return { status: 1, stdout: Buffer.from(""), stderr: Buffer.from(""), signal: null, pid: 1, output: [] };
    }) as never,
    env: {},
    cwd: process.cwd(),
    stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
  });

  assert.equal(code, 0);
  assert.equal(spawnCalls, 0);
  assert.match(stdout.join(""), /harbor run -d terminal-bench@2\.0/u);
  assert.match(stdout.join(""), /CodexHarborCliInstalledAgent/u);
  assert.equal(stderr.join(""), "");
});

contractTest("runtime.hermetic", "terminal bench codex detects recent failed adapter artifacts", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-codex-failures-"));
  try {
    const jobArtifactDir = path.join(tmp, "jobs", "2026-06-17__09-49-30", "overfull-hbox__abc123", "agent");
    mkdirSync(jobArtifactDir, { recursive: true });
    writeFileSync(
      path.join(jobArtifactDir, "kestrel-codex-harbor-cli-overfull-hbox.json"),
      JSON.stringify({
        adapter: "codex-harbor-cli",
        dataset: "terminal-bench@2.0",
        task_id: "overfull-hbox",
        status: "failed",
        failure_kind: "cli_command_failed",
      }),
    );

    assert.deepEqual(readRecentCodexAdapterFailures(tmp, Date.now() - 1000), [
      {
        path: path.join("jobs", "2026-06-17__09-49-30", "overfull-hbox__abc123", "agent", "kestrel-codex-harbor-cli-overfull-hbox.json"),
        status: "failed",
        failureKind: "cli_command_failed",
        taskId: "overfull-hbox",
      },
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "terminal bench codex detects Harbor trial exceptions", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-codex-exception-"));
  try {
    const jobDir = path.join(tmp, "jobs", "2026-06-17__10-58-17");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      path.join(jobDir, "result.json"),
      JSON.stringify({
        stats: {
          n_errored_trials: 1,
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

contractTest("runtime.hermetic", "terminal bench codex detects single-task zero reward", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-harbor-codex-zero-reward-"));
  try {
    const jobDir = path.join(tmp, "jobs", "2026-06-17__11-00-09");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      path.join(jobDir, "result.json"),
      JSON.stringify({
        stats: {
          n_errored_trials: 0,
          evals: {
            "codex-harbor-cli__terminal-bench": {
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
