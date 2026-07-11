import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectTerminalBenchEvidence,
  summarizeTerminalBenchRun,
} from "../../scripts/terminal-bench-evidence.js";

test("terminal bench evidence classifies adapter failure before verifier", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter }) => {
    await writeTask({
      is_resolved: false,
      failure_mode: "unknown_agent_error",
      agent_started_at: "2026-07-01T00:00:00.000Z",
      agent_ended_at: "2026-07-01T00:00:10.000Z",
    });
    await writeAdapter({ status: "failed", failure_kind: "runtime_external_deadline_exhausted" });

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "runtime_adapter_failed");
    assert.equal(evidence.adapterFailureKindCounts.runtime_external_deadline_exhausted, 1);
    assert.equal(evidence.agentDurationMs[0], 10_000);
  });
});

test("terminal bench evidence classifies setup failure before adapter start", async () => {
  await withSyntheticRun(async ({ runDir, writeTask }) => {
    await writeTask({ is_resolved: false, failure_mode: "test_timeout" });

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "benchmark_setup_failed_before_adapter");
  });
});

test("terminal bench evidence classifies adapter-completed verifier timeout", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter }) => {
    await writeTask({
      is_resolved: false,
      failure_mode: "test_timeout",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({ status: "completed", failure_kind: "none" });

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "adapter_completed_but_verifier_unresolved");
    assert.equal(evidence.verifierFailureModeCounts.test_timeout, 1);
  });
});

test("terminal bench evidence classifies artifact pass with failed adapter", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter }) => {
    await writeTask({
      is_resolved: true,
      failure_mode: "none",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({ status: "failed", failure_kind: "kestrel_run_failed" });

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "artifact_passed_but_agent_failed");
  });
});

test("terminal bench evidence classifies provider/config failures explicitly", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter }) => {
    await writeTask({
      is_resolved: false,
      failure_mode: "unknown_agent_error",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({ status: "failed", failure_kind: "provider_rate_limited" });

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "provider_config_or_quota");
    assert.equal(evidence.adapterFailureKindCounts.provider_rate_limited, 1);
  });
});

test("terminal bench evidence classifies clean unresolved completed adapter as model-quality backlog", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter, writeEvents }) => {
    await writeTask({
      is_resolved: false,
      failure_mode: "unknown_agent_error",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({ status: "completed", failure_kind: "none", model_provider: "openrouter", model: "openai/gpt-5.4" });
    await writeEvents([
      { payload: { update: { stepIndex: 0 } } },
      { payload: { entry: { stepIndex: 4 } } },
    ]);

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "model_quality_or_task_strategy");
    assert.equal(evidence.tasks[0]?.runtimeStepCount, 5);
    assert.equal(evidence.tasks[0]?.modelProvider, "openrouter");
  });
});

test("terminal bench evidence classifies event-log waiting as adapter failure", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter, writeEvents }) => {
    await writeTask({
      is_resolved: false,
      failure_mode: "unset",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({ status: "completed", failure_kind: "none" });
    await writeEvents([
      {
        payload: {
          update: {
            code: "WAITING_FOR_EVENT",
            waitFor: { eventType: "user.reply" },
          },
        },
      },
    ]);

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "runtime_adapter_failed");
    assert.equal(evidence.tasks[0]?.adapterFailureKind, "runtime_waiting_for_user");
    assert.equal(evidence.adapterFailureKindCounts.runtime_waiting_for_user, 1);
  });
});

test("terminal bench evidence classifies exact bridge fetch failures from event logs", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter, writeEvents }) => {
    await writeTask({
      is_resolved: false,
      failure_mode: "unset",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({ status: "completed", failure_kind: "none" });
    await writeEvents([
      {
        payload: {
          entry: {
            eventName: "state_transition",
            metadata: {
              latestEvidence: {
                summary: "Terminal-Bench dev shell bridge request failed: fetch failed ",
              },
            },
          },
        },
      },
    ]);

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "runtime_adapter_failed");
    assert.equal(evidence.tasks[0]?.adapterFailureKind, "terminal_bench_bridge_fetch_failed");
    assert.equal(evidence.adapterFailureKindCounts.terminal_bench_bridge_fetch_failed, 1);
  });
});

test("terminal bench evidence classifies protected path misuse from event logs", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter, writeEvents }) => {
    await writeTask({
      is_resolved: false,
      failure_mode: "unset",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({ status: "completed", failure_kind: "none" });
    await writeEvents([
      {
        payload: {
          update: {
            toolName: "dev.shell.run",
            input: {
              command: "python3 /protected/maze_helper.py",
            },
          },
        },
      },
    ]);

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "runtime_adapter_failed");
    assert.equal(evidence.tasks[0]?.adapterFailureKind, "terminal_bench_protected_path_misuse");
    assert.equal(evidence.adapterFailureKindCounts.terminal_bench_protected_path_misuse, 1);
  });
});

test("terminal bench evidence ignores protected path mentions in file content", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter, writeEvents }) => {
    await writeTask({
      is_resolved: true,
      failure_mode: "none",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({ status: "completed", failure_kind: "none" });
    await writeEvents([
      {
        payload: {
          update: {
            toolName: "fs.write_text",
            input: {
              path: "/app/generate_maze_map.py",
              content: "subprocess.run(['python3', '/protected/maze_helper.py'])",
            },
          },
        },
      },
    ]);

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "passed");
    assert.equal(evidence.tasks[0]?.adapterFailureKind, undefined);
    assert.equal(evidence.adapterFailureKindCounts.terminal_bench_protected_path_misuse, undefined);
  });
});

test("terminal bench evidence records public-test protected denial as diagnostic only", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter, writeEvents }) => {
    await writeTask({
      is_resolved: true,
      failure_mode: "none",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({
      status: "completed",
      failure_kind: "none",
      failure_details: {
        protected_path_denial_observed_in_output: {
          kind: "protected_path_denial_observed_in_output",
          source: "bridge_log",
        },
      },
    });
    await writeEvents([
      {
        payload: {
          update: {
            toolName: "exec_command",
            output: {
              stdout: "python3: can't open file '/protected/maze_helper.py': Permission denied\n",
            },
          },
        },
      },
    ]);

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "passed");
    assert.equal(evidence.tasks[0]?.adapterFailureKind, undefined);
    assert.equal(evidence.tasks[0]?.protectedPathDenialObserved, true);
    assert.equal(evidence.adapterFailureKindCounts.terminal_bench_protected_path_misuse, undefined);
  });
});

test("terminal bench evidence classifies cannot_satisfy from event logs", async () => {
  await withSyntheticRun(async ({ runDir, writeTask, writeAdapter, writeEvents }) => {
    await writeTask({
      is_resolved: false,
      failure_mode: "unset",
      agent_started_at: "2026-07-01T00:00:00.000Z",
    });
    await writeAdapter({ status: "completed", failure_kind: "none" });
    await writeEvents([
      {
        payload: {
          entry: {
            eventName: "state_transition",
            metadata: {
              decisionCode: "cannot_satisfy",
              next: {
                nextAction: {
                  kind: "cannot_satisfy",
                },
              },
            },
          },
        },
      },
    ]);

    const evidence = await summarizeTerminalBenchRun(runDir);

    assert.equal(evidence.tasks[0]?.classification, "runtime_adapter_failed");
    assert.equal(evidence.tasks[0]?.adapterFailureKind, "model_contract_cannot_satisfy");
    assert.equal(evidence.adapterFailureKindCounts.model_contract_cannot_satisfy, 1);
  });
});

test("terminal bench evidence collector ignores nested task results as run roots", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "kestrel-tbench-evidence-"));
  try {
    const runDir = path.join(tmp, "runs", "kestrel-cli-sample");
    await writeSyntheticRun(runDir, {
      task: {
        is_resolved: true,
        failure_mode: "none",
        agent_started_at: "2026-07-01T00:00:00.000Z",
      },
      adapter: { status: "completed", failure_kind: "none" },
    });

    const evidence = await collectTerminalBenchEvidence(path.join(tmp, "runs"));

    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.runId, "kestrel-cli-sample");
    assert.equal(evidence[0]?.classificationCounts.passed, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

async function withSyntheticRun(callback: (helpers: {
  runDir: string;
  writeTask: (overrides: Record<string, unknown>) => Promise<void>;
  writeAdapter: (overrides: Record<string, unknown>) => Promise<void>;
  writeEvents: (records: Array<Record<string, unknown>>) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "kestrel-tbench-evidence-"));
  try {
    const runDir = path.join(tmp, "runs", "kestrel-cli-sample");
    await writeSyntheticRun(runDir, {});
    await callback({
      runDir,
      writeTask: (overrides) => writeTaskResult(runDir, overrides),
      writeAdapter: (overrides) => writeAdapterArtifact(runDir, overrides),
      writeEvents: (records) => writeEventLog(runDir, records),
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function writeSyntheticRun(runDir: string, input: {
  task?: Record<string, unknown>;
  adapter?: Record<string, unknown>;
}): Promise<void> {
  await mkdir(taskDir(runDir), { recursive: true });
  await writeJson(path.join(runDir, "results.json"), {
    n_resolved: input.task?.is_resolved === true ? 1 : 0,
    n_unresolved: input.task?.is_resolved === true ? 0 : 1,
    accuracy: input.task?.is_resolved === true ? 1 : 0,
    results: [
      {
        task_id: "sample-task",
        is_resolved: input.task?.is_resolved === true,
        failure_mode: input.task?.failure_mode ?? "unknown_agent_error",
      },
    ],
  });
  await writeTaskResult(runDir, input.task ?? {});
  if (input.adapter !== undefined) {
    await writeAdapterArtifact(runDir, input.adapter);
  }
}

async function writeTaskResult(runDir: string, overrides: Record<string, unknown>): Promise<void> {
  await mkdir(taskDir(runDir), { recursive: true });
  const isResolved = overrides.is_resolved === true;
  await writeJson(path.join(taskDir(runDir), "results.json"), {
    task_id: "sample-task",
    is_resolved: isResolved,
    failure_mode: isResolved ? "none" : "unknown_agent_error",
    ...overrides,
  });
}

async function writeAdapterArtifact(runDir: string, overrides: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(taskDir(runDir), "agent-logs"), { recursive: true });
  await writeJson(path.join(taskDir(runDir), "agent-logs", "kestrel-cli-sample-task.json"), {
    adapter: "cli",
    task_id: "sample-task",
    status: "completed",
    failure_kind: "none",
    ...overrides,
  });
}

async function writeEventLog(runDir: string, records: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(path.join(taskDir(runDir), "agent-logs"), { recursive: true });
  await writeFile(
    path.join(taskDir(runDir), "agent-logs", "kestrel-cli-sample-task.events.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

async function writeJson(file: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function taskDir(runDir: string): string {
  return path.join(runDir, "sample-task", "sample-task.1-of-1.kestrel-cli-sample");
}
