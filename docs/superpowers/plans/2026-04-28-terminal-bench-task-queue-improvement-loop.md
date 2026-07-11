---
id: plan-terminal-bench-task-queue-improvement-loop-implementation-2026-04-28
domain: benchmarking
status: draft
owner: kestrel-runtime
last_verified_at: 2026-06-16
depends_on: [../../PLANS.md, ../../plans/2026-04-28-terminal-bench-task-queue-improvement-loop-design.md, ../../../scripts/terminal-bench.ts, ../../../benchmarks/terminal_bench/README.md]
---

# Terminal-Bench Task Queue Improvement Loop Implementation Plan

See also: [Docs index](../../index.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `pnpm run bench:terminal -- improve --full` into a deterministic single-task queue loop with scoped Docker cleanup and living run notes.

**Architecture:** Keep the public orchestrator in `scripts/terminal-bench.ts`, but split new behavior into small exported helpers so unit tests can drive the implementation. Full improvement mode creates a task queue, runs one `tb run --task-id` at a time, stops at the first unresolved task, cleans that task's Docker resources, asks Codex to repair, verifies by rerunning the same task, and commits only after verification passes.

**Tech Stack:** TypeScript, Node `node:test`, Terminal-Bench CLI, Docker Compose, existing Python Terminal-Bench adapters.

---

## File Structure

- Modify: `scripts/terminal-bench.ts`
  - Add `cleanup` mode.
  - Add queue types and helper functions.
  - Add single-task queue execution for `improve --full`.
  - Add scoped Docker compose cleanup helpers.
  - Add run-note append helpers.
- Modify: `tests/unit/terminal-bench-orchestrator.test.ts`
  - Add tests for queue construction, queue transitions, fail-fast task execution, Docker cleanup command construction, cleanup mode, run notes, and commit behavior.
- Modify: `benchmarks/terminal_bench/README.md`
  - Document queue behavior, cleanup mode, and run notes.
- Create: `benchmarks/terminal_bench/term-bench-run-notes.md`
  - Seed the living benchmark-progress journal with the current run history and usage rules.

## Task 1: Add Queue Types And Argument Surface

**Files:**
- Modify: `scripts/terminal-bench.ts`
- Modify: `tests/unit/terminal-bench-orchestrator.test.ts`

- [ ] **Step 1: Write failing parser tests**

Add tests near the existing parser tests:

```ts
test("terminal bench exposes cleanup mode", () => {
  const options = parseTerminalBenchArgs(["cleanup", "--dry-run"]);

  assert.equal(options.mode, "cleanup");
  assert.equal(options.dryRun, true);
  assert.equal(options.adapter, "both");
});

test("terminal bench improve full enables queue mode implicitly", () => {
  const options = parseTerminalBenchArgs(["improve", "--full", "--adapter", "cli"]);

  assert.equal(options.mode, "improve");
  assert.equal(options.taskId, undefined);
  assert.equal(options.adapter, "cli");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: FAIL because `cleanup` is not an accepted command mode.

- [ ] **Step 3: Add the command mode**

In `scripts/terminal-bench.ts`, update:

```ts
type CommandMode = "bootstrap" | "preflight" | "runtime" | "cli" | "both" | "improve" | "cleanup";
```

Update the mode parsing condition to include `cleanup`.

Update `adapterFromMode` so cleanup defaults to both:

```ts
function adapterFromMode(mode: CommandMode): AdapterSelection {
  if (mode === "runtime" || mode === "cli") {
    return mode;
  }
  if (mode === "improve") {
    return "cli";
  }
  return "both";
}
```

- [ ] **Step 4: Run tests to verify parser passes**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: parser tests pass or remaining failures point to later planned behavior.

- [ ] **Step 5: Commit**

```bash
git add scripts/terminal-bench.ts tests/unit/terminal-bench-orchestrator.test.ts
git commit -m "bench(terminal): add cleanup command surface"
```

## Task 2: Implement Queue State Helpers

**Files:**
- Modify: `scripts/terminal-bench.ts`
- Modify: `tests/unit/terminal-bench-orchestrator.test.ts`

- [ ] **Step 1: Write queue helper tests**

Add tests:

```ts
test("terminal bench builds deterministic task queue state", () => {
  const queue = createTerminalBenchQueue({
    dataset: "terminal-bench-core==0.1.1",
    adapter: "cli",
    taskIds: ["play-zork", "hello-world"],
    createdAt: "2026-04-28T00:00:00.000Z",
  });

  assert.deepEqual(queue.tasks.map((task) => task.task_id), ["play-zork", "hello-world"]);
  assert.deepEqual(queue.tasks.map((task) => task.status), ["pending", "pending"]);
});

test("terminal bench queue marks pass and first failure", () => {
  const queue = createTerminalBenchQueue({
    dataset: "terminal-bench-core==0.1.1",
    adapter: "cli",
    taskIds: ["play-zork", "hello-world"],
    createdAt: "2026-04-28T00:00:00.000Z",
  });

  markQueueTaskPassed(queue, "play-zork", "run-play");
  markQueueTaskFailed(queue, "hello-world", "run-hello", "tb_verifier_failed");

  assert.equal(queue.tasks[0]?.status, "passed");
  assert.equal(queue.tasks[0]?.last_run_id, "run-play");
  assert.equal(queue.tasks[1]?.status, "failed");
  assert.equal(queue.tasks[1]?.last_failure_kind, "tb_verifier_failed");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: FAIL because queue helpers do not exist.

- [ ] **Step 3: Add queue types and helpers**

Export these types and functions from `scripts/terminal-bench.ts`:

```ts
export type TerminalBenchQueueTaskStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface TerminalBenchQueueTask {
  task_id: string;
  status: TerminalBenchQueueTaskStatus;
  attempts: number;
  last_run_id: string | null;
  last_failure_kind: string | null;
}

export interface TerminalBenchQueueState {
  dataset: string;
  adapter: AdapterSelection;
  created_at: string;
  tasks: TerminalBenchQueueTask[];
}

export function createTerminalBenchQueue(input: {
  dataset: string;
  adapter: AdapterSelection;
  taskIds: string[];
  createdAt: string;
}): TerminalBenchQueueState {
  return {
    dataset: input.dataset,
    adapter: input.adapter,
    created_at: input.createdAt,
    tasks: input.taskIds.map((taskId) => ({
      task_id: taskId,
      status: "pending",
      attempts: 0,
      last_run_id: null,
      last_failure_kind: null,
    })),
  };
}

export function markQueueTaskPassed(queue: TerminalBenchQueueState, taskId: string, runId: string): void {
  const task = requireQueueTask(queue, taskId);
  task.status = "passed";
  task.last_run_id = runId;
  task.last_failure_kind = null;
}

export function markQueueTaskFailed(
  queue: TerminalBenchQueueState,
  taskId: string,
  runId: string,
  failureKind: string,
): void {
  const task = requireQueueTask(queue, taskId);
  task.status = "failed";
  task.last_run_id = runId;
  task.last_failure_kind = failureKind;
}

function requireQueueTask(queue: TerminalBenchQueueState, taskId: string): TerminalBenchQueueTask {
  const task = queue.tasks.find((candidate) => candidate.task_id === taskId);
  if (task === undefined) {
    throw new Error(`Queue task not found: ${taskId}`);
  }
  return task;
}
```

- [ ] **Step 4: Update imports in the test**

Import the new helpers:

```ts
  createTerminalBenchQueue,
  markQueueTaskFailed,
  markQueueTaskPassed,
```

- [ ] **Step 5: Run tests to verify pass**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/terminal-bench.ts tests/unit/terminal-bench-orchestrator.test.ts
git commit -m "bench(terminal): add improvement queue state"
```

## Task 3: Build Full-Dataset Task Discovery

**Files:**
- Modify: `scripts/terminal-bench.ts`
- Modify: `tests/unit/terminal-bench-orchestrator.test.ts`

- [ ] **Step 1: Write task discovery tests**

Add:

```ts
test("terminal bench discovers task ids from cached dataset folders", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-tasks-"));
  try {
    mkdirSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "hello-world"), { recursive: true });
    mkdirSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork"), { recursive: true });
    writeFileSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "README.md"), "ignore me");

    assert.deepEqual(discoverTerminalBenchTaskIds({
      dataset: "terminal-bench-core==0.1.1",
      homeDir: tmp,
      cwd: "/repo",
    }), ["hello-world", "play-zork"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: FAIL because `discoverTerminalBenchTaskIds` does not exist.

- [ ] **Step 3: Implement discovery helper**

Add:

```ts
export function discoverTerminalBenchTaskIds(input: {
  dataset: string;
  homeDir: string;
  cwd: string;
}): string[] {
  const parsed = parseDatasetSpec(input.dataset);
  const candidates = [
    path.join(input.homeDir, ".cache", "terminal-bench", parsed.name, parsed.version),
    path.join(input.cwd, ".cache", "terminal-bench", parsed.name, parsed.version),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const taskIds = readdirSync(candidate)
      .filter((entry) => {
        const fullPath = path.join(candidate, entry);
        return statSync(fullPath).isDirectory() && existsSync(path.join(fullPath, "docker-compose.yaml"));
      })
      .sort();
    if (taskIds.length > 0) {
      return taskIds;
    }
  }
  throw new Error(`Unable to discover Terminal-Bench task ids for ${input.dataset}. Run a preflight task or provide --task-id.`);
}

function parseDatasetSpec(dataset: string): { name: string; version: string } {
  const [name, version] = dataset.split("==");
  if (name === undefined || name.length === 0 || version === undefined || version.length === 0) {
    throw new Error(`Unsupported Terminal-Bench dataset format: ${dataset}`);
  }
  return { name, version };
}
```

- [ ] **Step 4: Fix the test fixture**

The test needs `docker-compose.yaml` files because discovery intentionally
filters real task directories:

```ts
writeFileSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "hello-world", "docker-compose.yaml"), "services: {}\n");
writeFileSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork", "docker-compose.yaml"), "services: {}\n");
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/terminal-bench.ts tests/unit/terminal-bench-orchestrator.test.ts
git commit -m "bench(terminal): discover queued terminal bench tasks"
```

## Task 4: Add Scoped Docker Cleanup Helpers

**Files:**
- Modify: `scripts/terminal-bench.ts`
- Modify: `tests/unit/terminal-bench-orchestrator.test.ts`

- [ ] **Step 1: Write cleanup command tests**

Add:

```ts
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
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: FAIL because `buildDockerCleanupCommand` does not exist.

- [ ] **Step 3: Implement cleanup helper**

Add:

```ts
export function buildDockerCleanupCommand(input: {
  taskId: string;
  runId: string;
  dataset: string;
  homeDir: string;
  removeImages: boolean;
}): { command: "docker"; args: string[] } {
  const parsed = parseDatasetSpec(input.dataset);
  const project = `${slugTaskId(input.taskId)}-1-of-1-${input.runId}`;
  const composePath = path.join(
    input.homeDir,
    ".cache",
    "terminal-bench",
    parsed.name,
    parsed.version,
    input.taskId,
    "docker-compose.yaml",
  );
  return {
    command: "docker",
    args: [
      "compose",
      "-p",
      project,
      "-f",
      composePath,
      "down",
      ...(input.removeImages ? ["--rmi", "all"] : []),
      "--volumes",
    ],
  };
}

function slugTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]+/gu, "-").toLowerCase();
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/terminal-bench.ts tests/unit/terminal-bench-orchestrator.test.ts
git commit -m "bench(terminal): add scoped docker cleanup helpers"
```

## Task 5: Implement Run Notes

**Files:**
- Create: `benchmarks/terminal_bench/term-bench-run-notes.md`
- Modify: `scripts/terminal-bench.ts`
- Modify: `tests/unit/terminal-bench-orchestrator.test.ts`

- [ ] **Step 1: Create the notes file**

Create `benchmarks/terminal_bench/term-bench-run-notes.md`:

```md
# Terminal-Bench Run Notes

Living notes for Kestrel Terminal-Bench improvement work.

Rules:
- Record commands, outcomes, evidence paths, and next decisions.
- Do not infer root cause without evidence.
- Keep entries concise enough to scan during iterative runs.

## 2026-04-28 - Full CLI run stopped for queue-loop redesign

Command:
`pnpm run bench:terminal -- improve --full --adapter cli`

Outcome:
Stopped manually after early unresolved tasks showed the full-run loop was too slow for iteration.

What went right:
- Docker Desktop recovered and `tb run` started.
- Kestrel CLI installed inside task containers.
- Terminal-Bench produced task-level `results.json` evidence.

What went wrong:
- The orchestrator kept running the full suite after unresolved tasks were already visible.
- Unresolved tasks included `play-zork`, `build-linux-kernel-qemu`, and `super-benchmark-upet`.

Evidence:
- `runs/kestrel-cli-20260428231446/results.json`

Decision:
Replace full-run improve behavior with a single-task queue that stops at the first unresolved task.
```

- [ ] **Step 2: Write run-note append test**

Add:

```ts
test("terminal bench appends concise run notes", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-notes-"));
  try {
    const notesPath = path.join(tmp, "benchmarks", "terminal_bench", "term-bench-run-notes.md");
    appendRunNote({
      cwd: tmp,
      title: "CLI task unresolved",
      command: "pnpm run bench:terminal -- improve --full --adapter cli",
      outcome: "Stopped after play-zork was unresolved.",
      evidencePaths: ["runs/kestrel-cli-test/results.json"],
      next: "Repair play-zork before continuing the queue.",
    });

    const notes = readFileSync(notesPath, "utf8");
    assert.match(notes, /CLI task unresolved/u);
    assert.match(notes, /Stopped after play-zork was unresolved/u);
    assert.match(notes, /runs\/kestrel-cli-test\/results\.json/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Implement run-note helper**

Add:

```ts
export function appendRunNote(input: {
  cwd: string;
  title: string;
  command: string;
  outcome: string;
  evidencePaths: string[];
  next: string;
}): void {
  const notesPath = path.join(input.cwd, "benchmarks", "terminal_bench", "term-bench-run-notes.md");
  mkdirSync(path.dirname(notesPath), { recursive: true });
  const header = existsSync(notesPath)
    ? ""
    : "# Terminal-Bench Run Notes\n\nLiving notes for Kestrel Terminal-Bench improvement work.\n\n";
  const evidence = input.evidencePaths.length === 0
    ? "- none recorded"
    : input.evidencePaths.map((evidencePath) => `- \`${evidencePath}\``).join("\n");
  const entry = [
    header,
    `## ${new Date().toISOString().slice(0, 10)} - ${input.title}`,
    "",
    "Command:",
    `\`${input.command}\``,
    "",
    "Outcome:",
    input.outcome,
    "",
    "Evidence:",
    evidence,
    "",
    "Next:",
    input.next,
    "",
  ].join("\n");
  writeFileSync(notesPath, entry, { encoding: "utf8", flag: "a" });
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/terminal-bench.ts tests/unit/terminal-bench-orchestrator.test.ts benchmarks/terminal_bench/term-bench-run-notes.md
git commit -m "bench(terminal): add run notes journal"
```

## Task 6: Execute Full Improvement As A Single-Task Queue

**Files:**
- Modify: `scripts/terminal-bench.ts`
- Modify: `tests/unit/terminal-bench-orchestrator.test.ts`

- [ ] **Step 1: Write stop-on-first-unresolved test**

Add a test that stubs two task IDs and asserts only the first task runs when it
fails:

```ts
test("terminal bench improve full queue stops on first unresolved task", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-queue-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    const cacheRoot = path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1");
    for (const taskId of ["play-zork", "hello-world"]) {
      mkdirSync(path.join(cacheRoot, taskId), { recursive: true });
      writeFileSync(path.join(cacheRoot, taskId, "docker-compose.yaml"), "services: {}\n");
    }

    const code = await runTerminalBench(["improve", "--full", "--adapter", "cli", "--max-iterations", "1"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") return passedSpawn("tb help\n");
        if (command === "uv" && args.join(" ") === "--version") return passedSpawn("uv ok\n");
        if (command === "docker" && args.join(" ") === "info") return passedSpawn("docker ok\n");
        if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=all") return passedSpawn("");
        if (command === "docker" && args[0] === "compose") return passedSpawn("cleaned\n");
        if (command === "tb" && args[0] === "run") {
          writeTbResults(tmp, args, false);
          return failedSpawn("unresolved\n");
        }
        if (command === "codex") return failedSpawn("stop before repair completes\n");
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENAI_API_KEY: "sk-test", HOME: tmp, DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 1);
    const tbRuns = calls.filter((call) => call.command === "tb" && call.args[0] === "run");
    assert.equal(tbRuns.length, 1);
    assert.ok(tbRuns[0]?.args.includes("--task-id"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: FAIL because `improve --full` still runs one full `tb run`.

- [ ] **Step 3: Add queue branch in `runImproveLoop`**

At the start of `runImproveLoop`, after clean-worktree check and artifact root
creation, branch when `options.taskId === undefined`:

```ts
if (options.taskId === undefined) {
  return runImproveQueueLoop({
    options,
    deps,
    env,
    tbBin,
    artifactRoot,
    commands,
  });
}
```

- [ ] **Step 4: Implement `runImproveQueueLoop` minimal behavior**

Implement one adapter first; if `adapter=both`, process runtime then CLI as
separate queue items by using each command's adapter. The minimal version should:

```ts
function runImproveQueueLoop(input: {
  options: TerminalBenchOptions;
  deps: RuntimeDeps;
  env: NodeJS.ProcessEnv;
  tbBin: string;
  artifactRoot: string;
  commands: TerminalBenchCommand[];
}): number {
  const taskIds = discoverTerminalBenchTaskIds({
    dataset: input.options.dataset,
    homeDir: input.env.HOME ?? "",
    cwd: input.deps.cwd,
  });
  const queue = createTerminalBenchQueue({
    dataset: input.options.dataset,
    adapter: input.options.adapter,
    taskIds,
    createdAt: new Date().toISOString(),
  });
  writeQueue(input.artifactRoot, queue);

  for (let iteration = 1; iteration <= input.options.maxIterations; iteration += 1) {
    for (const task of queue.tasks.filter((candidate) => candidate.status !== "passed")) {
      task.status = "running";
      task.attempts += 1;
      writeQueue(input.artifactRoot, queue);

      const command = { ...input.commands[0], args: [...input.commands[0].args, "--task-id", task.task_id] };
      const run = runBenchmarkCommand({ command, tbBin: input.tbBin, deps: input.deps, env: input.env, dryRun: false });
      task.last_run_id = run.runId;

      if (run.status === 0 && run.outcome !== undefined && run.outcome.nUnresolved === 0) {
        markQueueTaskPassed(queue, task.task_id, run.runId);
        writeQueue(input.artifactRoot, queue);
        continue;
      }

      markQueueTaskFailed(queue, task.task_id, run.runId, classifyBenchmarkFailure(run));
      writeQueue(input.artifactRoot, queue);
      return repairSingleFailedQueueTask({ ...input, iteration, queue, failedRun: run, failedTaskId: task.task_id });
    }
    writeFileSync(path.join(input.artifactRoot, "summary.json"), JSON.stringify({ status: "passed", queue }, null, 2) + "\n");
    return 0;
  }
  return 1;
}
```

Then add small helpers:

```ts
function writeQueue(artifactRoot: string, queue: TerminalBenchQueueState): void {
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(path.join(artifactRoot, "queue.json"), JSON.stringify(queue, null, 2) + "\n", "utf8");
}

function classifyBenchmarkFailure(run: BenchmarkRunRecord): string {
  if (run.outcome !== undefined && run.outcome.nUnresolved > 0) {
    return "tb_verifier_failed";
  }
  return "tb_run_failed";
}
```

- [ ] **Step 5: Wire repair helper by reusing existing code**

Extract the existing failure-packet, Codex, verification, and commit block from
`runImproveLoop` into `repairSingleFailedQueueTask`. Keep behavior identical
except the verification command list must use the failed task's `--task-id`.

- [ ] **Step 6: Run tests**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/terminal-bench.ts tests/unit/terminal-bench-orchestrator.test.ts
git commit -m "bench(terminal): run full improve as task queue"
```

## Task 7: Integrate Docker Cleanup Into Queue Runs

**Files:**
- Modify: `scripts/terminal-bench.ts`
- Modify: `tests/unit/terminal-bench-orchestrator.test.ts`

- [ ] **Step 1: Write cleanup integration test**

Extend the queue test to assert Docker cleanup runs before and after the task:

```ts
const dockerComposeCalls = calls.filter((call) => call.command === "docker" && call.args[0] === "compose");
assert.equal(dockerComposeCalls.length >= 2, true);
assert.equal(dockerComposeCalls.every((call) => call.args.includes("down")), true);
assert.equal(dockerComposeCalls.every((call) => call.args.includes("--volumes")), true);
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: FAIL because cleanup is not invoked by queue execution.

- [ ] **Step 3: Add cleanup runner**

Add:

```ts
function runDockerCleanup(input: {
  taskId: string;
  runId: string;
  dataset: string;
  deps: RuntimeDeps;
  env: NodeJS.ProcessEnv;
  removeImages: boolean;
}): SpawnSyncReturns<Buffer> {
  const cleanup = buildDockerCleanupCommand({
    taskId: input.taskId,
    runId: input.runId,
    dataset: input.dataset,
    homeDir: input.env.HOME ?? "",
    removeImages: input.removeImages,
  });
  return input.deps.spawn(cleanup.command, cleanup.args, {
    cwd: input.deps.cwd,
    env: input.env,
  });
}
```

- [ ] **Step 4: Call cleanup around each task**

In `runImproveQueueLoop`, call `runDockerCleanup` with a pre-run synthetic run
ID only after the run ID exists. To support pre-clean, create the run ID before
running:

```ts
const runId = `kestrel-${command.adapter}-${runStamp()}`;
runDockerCleanup({ taskId: task.task_id, runId, dataset: input.options.dataset, deps: input.deps, env: input.env, removeImages: false });
const run = runBenchmarkCommand({ command, tbBin: input.tbBin, deps: input.deps, env: input.env, dryRun: false, runId });
runDockerCleanup({ taskId: task.task_id, runId, dataset: input.options.dataset, deps: input.deps, env: input.env, removeImages: false });
```

This requires extending `runBenchmarkCommand` to accept optional `runId`.

- [ ] **Step 5: Record cleanup output**

Write cleanup output into `docker-cleanup.txt` inside the current iteration
directory when a task fails.

- [ ] **Step 6: Run tests**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/terminal-bench.ts tests/unit/terminal-bench-orchestrator.test.ts
git commit -m "bench(terminal): clean docker resources per queued task"
```

## Task 8: Add Cleanup Mode

**Files:**
- Modify: `scripts/terminal-bench.ts`
- Modify: `tests/unit/terminal-bench-orchestrator.test.ts`

- [ ] **Step 1: Write cleanup mode test**

Add:

```ts
test("terminal bench cleanup removes only known queued run projects", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-tbench-cleanup-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    const queueRoot = path.join(tmp, "runs", "terminal-bench-improve", "session");
    mkdirSync(queueRoot, { recursive: true });
    writeFileSync(path.join(queueRoot, "queue.json"), JSON.stringify({
      dataset: "terminal-bench-core==0.1.1",
      adapter: "cli",
      created_at: "2026-04-28T00:00:00.000Z",
      tasks: [{ task_id: "play-zork", status: "failed", attempts: 1, last_run_id: "kestrel-cli-test", last_failure_kind: "tb_verifier_failed" }],
    }));
    mkdirSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork"), { recursive: true });
    writeFileSync(path.join(tmp, ".cache", "terminal-bench", "terminal-bench-core", "0.1.1", "play-zork", "docker-compose.yaml"), "services: {}\n");

    const code = await runTerminalBench(["cleanup"], {
      spawn: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (command === "tb" && args.join(" ") === "--help") return passedSpawn("tb help\n");
        if (command === "uv" && args.join(" ") === "--version") return passedSpawn("uv ok\n");
        if (command === "docker" && args.join(" ") === "info") return passedSpawn("docker ok\n");
        if (command === "docker" && args[0] === "compose") return passedSpawn("cleaned\n");
        return failedSpawn(`unexpected ${command} ${args.join(" ")}`);
      }) as unknown as typeof import("node:child_process").spawnSync,
      env: { OPENAI_API_KEY: "sk-test", HOME: tmp, DOCKER_HOST: "unix:///docker.sock" },
      cwd: tmp,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    assert.equal(code, 0);
    assert.equal(calls.some((call) => call.command === "docker" && call.args.includes("prune")), false);
    assert.equal(calls.some((call) => call.command === "docker" && call.args[0] === "compose"), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Implement cleanup mode branch**

In `runTerminalBench`, before normal benchmark command execution:

```ts
if (options.mode === "cleanup") {
  return runTerminalBenchCleanup({ options, deps, env });
}
```

Implement cleanup by scanning `runs/terminal-bench-improve/**/queue.json`,
reading `last_run_id` values, and running `runDockerCleanup` for those tasks.

- [ ] **Step 3: Run tests**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/terminal-bench.ts tests/unit/terminal-bench-orchestrator.test.ts
git commit -m "bench(terminal): add scoped cleanup mode"
```

## Task 9: Update Operator Docs

**Files:**
- Modify: `benchmarks/terminal_bench/README.md`
- Modify: `docs/plans/2026-04-28-terminal-bench-task-queue-improvement-loop-design.md` only if implementation differs from design.

- [ ] **Step 1: Update README improvement loop section**

Replace the current improvement-loop paragraph with:

```md
For `--full`, the improvement loop runs the dataset as a deterministic queue of
single-task Terminal-Bench runs. It stops at the first unresolved task, writes a
failure packet, cleans the task's Docker resources, invokes Codex, verifies by
rerunning that same task, commits if green, then continues the queue.
```

Add:

```md
Run scoped cleanup for Kestrel Terminal-Bench resources:

```bash
pnpm run bench:terminal -- cleanup
```

The cleanup command only targets queue-recorded Kestrel Terminal-Bench compose
projects. It does not run global Docker prune commands.
```

- [ ] **Step 2: Run docs diff check**

Run:

```bash
git diff -- benchmarks/terminal_bench/README.md docs/plans/2026-04-28-terminal-bench-task-queue-improvement-loop-design.md
```

Expected: README reflects the new operator behavior.

- [ ] **Step 3: Commit**

```bash
git add benchmarks/terminal_bench/README.md docs/plans/2026-04-28-terminal-bench-task-queue-improvement-loop-design.md
git commit -m "docs(terminal): document task queue benchmark loop"
```

## Task 10: Final Verification

**Files:**
- No planned edits unless verification reveals a defect.

- [ ] **Step 1: Run focused TypeScript tests**

Run:

```bash
node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Python adapter tests**

Run:

```bash
python3 -m unittest benchmarks.terminal_bench.test_results benchmarks.terminal_bench.test_kestrel_protocol
```

Expected: PASS.

- [ ] **Step 3: Run dry-run operator checks**

Run:

```bash
pnpm run bench:terminal -- improve --full --adapter cli --dry-run
pnpm run bench:terminal -- cleanup --dry-run
```

Expected: commands print planned queue/cleanup behavior without starting tasks.

- [ ] **Step 4: Run one-task smoke**

Run:

```bash
pnpm run bench:terminal -- improve --adapter cli --task-id hello-world --max-iterations 1
```

Expected: passes or stops with evidence-backed failure packet. If it fails, do
not commit further changes until the evidence is inspected.

- [ ] **Step 5: Start full queue smoke**

Run:

```bash
pnpm run bench:terminal -- improve --full --adapter cli --max-iterations 1
```

Expected: runs one task at a time and stops at the first unresolved task instead
of continuing through all 80 tasks.

- [ ] **Step 6: Inspect run notes**

Run:

```bash
tail -80 benchmarks/terminal_bench/term-bench-run-notes.md
```

Expected: notes include the queue start and task outcome with evidence paths.

- [ ] **Step 7: Clean generated caches**

Run:

```bash
rm -rf benchmarks/terminal_bench/__pycache__
```

Expected: no generated Python cache remains in `git status --short`.

- [ ] **Step 8: Commit final integration fixes if needed**

If verification required fixes:

```bash
git add scripts/terminal-bench.ts tests/unit/terminal-bench-orchestrator.test.ts benchmarks/terminal_bench/README.md benchmarks/terminal_bench/term-bench-run-notes.md
git commit -m "bench(terminal): verify task queue improvement loop"
```

## Self-Review

Spec coverage:
- Queue-driven full improve behavior: Tasks 2, 3, and 6.
- Stop on first unresolved task: Task 6.
- Docker discipline and cleanup mode: Tasks 4, 7, and 8.
- Living run notes: Task 5.
- Operator docs: Task 9.
- Verification: Task 10.

Placeholder scan:
- No `TBD`, `TODO`, or unspecified "add tests" steps remain.

Type consistency:
- Queue types use snake_case fields to match the approved design doc.
- Failure kinds remain plain strings in helpers to avoid expanding public result contracts in this slice.
