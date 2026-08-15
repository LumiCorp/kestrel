import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_HERMETIC_LANE_IDS,
  RUNTIME_HERMETIC_ISOLATION,
  RUNTIME_HERMETIC_WORKERS,
  validateRuntimeHermeticLaneManifest,
} from "./validation/runtime-hermetic-lanes.mjs";
import { runWeightedTaskQueue } from "./validation/weighted-task-queue.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const REPORT_DIR = path.join(ROOT, "test-results", "validation");
const REPORT_PATH = path.join(REPORT_DIR, "report.json");
const PACKED_CONSUMER_DIR = path.join(REPORT_DIR, "packed-consumer");
const TEMP_DIR = path.join(REPORT_DIR, "tmp");
const NODE_TEST_GROUP_RUNNER = path.join(
  ROOT,
  "scripts/validation/run-node-test-group.mjs",
);
const HERMETIC_RESOURCE_BUDGET = 12;
const HERMETIC_TASK_CONCURRENCY = 4;
const RUNTIME_HERMETIC_LANE_MANIFEST = JSON.parse(
  readFileSync(
    path.join(ROOT, "scripts/validation/runtime-hermetic-lanes.json"),
    "utf8",
  ),
);
const startedAt = Date.now();
const active = new Set();
const measurements = [];
let dockerStarts = 0;
let browserStarts = 0;
let buildInvocations = 0;
let processLaunches = 0;
let postgres;

const request = parseRequest(process.argv.slice(2));
if (request.mode === "plan") {
  printPlan();
  process.exit(0);
}

await runValidation(request);

async function runValidation(validationRequest) {
  cleanupValidationProcesses();
  if (validationRequest.mode === "full") {
    rmSync(REPORT_DIR, { recursive: true, force: true });
  }
  mkdirSync(REPORT_DIR, { recursive: true });

  process.once("SIGINT", () => abortAll("SIGINT"));
  process.once("SIGTERM", () => abortAll("SIGTERM"));

  try {
    requireNode22();
    if (validationRequest.mode === "full") await runFullValidation();
    else if (validationRequest.mode === "lane")
      await runHermeticLane(validationRequest.lane);
    else await runLeaf(validationRequest.boundary, validationRequest.workspace);
    const elapsedMs = Date.now() - startedAt;
    writeReport("passed", undefined, validationRequest);
    process.stdout.write(`\n[validate] passed in ${formatMs(elapsedMs)}\n`);
  } catch (error) {
    abortAll("SIGTERM");
    writeReport("failed", error, validationRequest);
    process.stderr.write(
      `\n[validate] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    stopPostgres();
    cleanupValidationProcesses();
  }
}

async function runFullValidation() {
  await phase("preflight", [
    task("suite version", PNPM, ["run", "version:check"]),
    task("public boundary", PNPM, ["run", "check:public-boundary"]),
  ]);

  buildInvocations += 1;
  await phase(
    "sharedBuild",
    [
      task("root artifact", PNPM, ["run", "build:self"]),
      task("workspace type analysis", PNPM, [
        "-r",
        "--parallel",
        "--if-present",
        "--filter",
        "@kestrel/desktop",
        "--filter",
        "@kestrel/environment-router",
        "--filter",
        "@kestrel/preview-edge",
        "--filter",
        "@kestrel/workspace-runtime",
        "--filter",
        "@kestrel/mcp-service",
        "run",
        "typecheck:self",
      ]),
    ],
    {
      setup: [task("shared artifacts", PNPM, ["run", "build:shared"])],
      resourceBudget: 2,
    },
  );

  await phase("hermetic", hermeticTasks(), {
    resourceBudget: HERMETIC_RESOURCE_BUDGET,
  });
}

function hermeticTasks() {
  return orderHermeticTasks(testTasksForBoundary("hermetic"));
}

function orderHermeticTasks(tasks) {
  const priority = new Map([
    ["Web hermetic", 0],
    ["runtime/runtime-core hermetic", 1],
    ["runtime/eval-replay hermetic", 2],
    ["runtime/cli-command-mode hermetic", 3],
    ["runtime/local-core-store hermetic", 4],
    ["runtime/provider-tool-contracts hermetic", 5],
    ["apps/desktop hermetic", 6],
  ]);
  return [...tasks].sort(
    (a, b) =>
      (priority.get(a.label) ?? 100) - (priority.get(b.label) ?? 100) ||
      a.label.localeCompare(b.label),
  );
}

function webProductionBuildTask() {
  return task(
    "Web production build",
    PNPM,
    ["--filter", "@kestrel/kestrel-one", "run", "build:self"],
    {
      env: {
        BETTER_AUTH_SECRET: "kestrel-validation-build-secret-0000000000000000",
        BETTER_AUTH_URL: "http://127.0.0.1:43103",
        DATABASE_URL:
          "postgresql://postgres:postgres@127.0.0.1:1/kestrel_build_guard",
        KESTREL_DISABLE_DOTENV: "1",
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:43103",
      },
    },
  );
}

function processTasks() {
  return testTasksForBoundary("process");
}

function processSetupTasks() {
  buildInvocations += 2;
  return [
    task("shared and root artifacts", PNPM, ["run", "build"]),
    task("Workspace Runtime artifact", PNPM, [
      "--filter",
      "@kestrel/workspace-runtime",
      "run",
      "build:self",
    ]),
    task("packed consumer fixture", process.execPath, [
      "--import",
      "tsx",
      "scripts/validation/prepare-packed-consumer.ts",
    ]),
    nodeTests("TUI PTY journeys", ROOT, ["tests/ops/tui/tui.ops.ts"], 1),
  ];
}

function testTasksForBoundary(boundary) {
  const groups = new Map();
  const rootHermeticFiles = [];
  for (const file of trackedTests([
    "tests/",
    "agents/",
    "tools/",
    "packages/",
    "apps/",
  ])) {
    if (
      file.startsWith("tests/macos/") ||
      file.includes("/tests/product/") ||
      file.endsWith(".postgres.test.ts")
    )
      continue;
    const source = readFileSync(path.join(ROOT, file), "utf8");
    if (testBoundary(file, source) !== boundary) continue;
    if (boundary === "process" && file === "tests/ops/tui/tui.ops.ts") continue;
    const execution = executionRoot(file);
    if (boundary === "hermetic" && execution.label === "runtime") {
      rootHermeticFiles.push(execution.relativeFile);
      continue;
    }
    const group = groups.get(execution.cwd) ?? { ...execution, files: [] };
    group.files.push(execution.relativeFile);
    groups.set(execution.cwd, group);
  }

  if (boundary === "hermetic") {
    const laneDefinitions = validateRuntimeHermeticLaneManifest(
      RUNTIME_HERMETIC_LANE_MANIFEST,
      rootHermeticFiles,
    );
    for (const lane of RUNTIME_HERMETIC_LANE_IDS) {
      const definition = laneDefinitions[lane];
      groups.set(`runtime/${lane}`, {
        cwd: ROOT,
        label: `runtime/${lane}`,
        prefix: [],
        files: definition.files,
        isolation: definition.isolation,
        workers: definition.workers,
      });
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .flatMap((group) => {
      const files = group.files.sort();
      if (boundary !== "process") {
        const sharedProcess =
          group.label === "Web"
            ? {
                isolation: RUNTIME_HERMETIC_ISOLATION,
                workers: RUNTIME_HERMETIC_WORKERS,
              }
            : group.isolation !== undefined
              ? { isolation: group.isolation, workers: group.workers }
              : {};
        return [
          nodeTests(
            `${group.label} ${boundary}`,
            group.cwd,
            files,
            HERMETIC_TASK_CONCURRENCY,
            group.prefix,
            {
              resourceCost: HERMETIC_TASK_CONCURRENCY,
              ...sharedProcess,
            },
          ),
        ];
      }
      const singleThreaded = new Set([
        "tests/unit/local-core-api.test.ts",
        "tests/integration/web-command.test.ts",
        "tests/smoke/local-dev-shell-service.smoke.ts",
        "tests/e2e/sdk-ecosystem/next-fixture.test.ts",
      ]);
      return files.map((file) =>
        nodeTests(
          `${group.label} process: ${file}`,
          group.cwd,
          [file],
          singleThreaded.has(file) ? 1 : 4,
          group.prefix,
        ),
      );
    });
}

function executionRoot(file) {
  if (file.startsWith("apps/web/"))
    return {
      cwd: path.join(ROOT, "apps/web"),
      relativeFile: file.slice("apps/web/".length),
      label: "Web",
      prefix: ["--import", "./scripts/register-server-only.mjs"],
    };
  const match = file.match(
    /^(apps\/(?:desktop|docs|environment-router|preview-edge|workspace-runtime|mcp-service)|packages\/[^/]+)\//u,
  );
  if (match)
    return {
      cwd: path.join(ROOT, match[1]),
      relativeFile: file.slice(match[1].length + 1),
      label: match[1],
      prefix: [],
    };
  return { cwd: ROOT, relativeFile: file, label: "runtime", prefix: [] };
}

function testBoundary(file, source) {
  if (
    /^tests\/(?:integration|smoke|ops|e2e)\//u.test(file) ||
    file === "tests/unit/local-core-api.test.ts"
  )
    return "process";
  if (
    /from ["']node:(?:child_process|net|http|https|readline)["']|\b(?:spawn|spawnSync|execFile|execFileSync|createServer)\s*\(/u.test(
      source,
    )
  )
    return "process";
  return "hermetic";
}

function postgresTasks(context) {
  return [
    preparePostgresTask(context),
    task(
      "PostgreSQL contracts",
      process.execPath,
      ["--import", "tsx", "scripts/validation/run-postgres.ts"],
      {
        env: context.environment,
      },
    ),
  ];
}

function preparePostgresTask(context) {
  return task(
    "prepare PostgreSQL templates",
    process.execPath,
    ["--import", "tsx", "scripts/validation/prepare-postgres.ts"],
    {
      env: context.environment,
    },
  );
}

async function chromiumTasks(context) {
  browserStarts += 1;
  const productEnvironment = await allocateProductEnvironment(context);
  return [
    task(
      "Chromium product contracts",
      PNPM,
      [
        "exec",
        "playwright",
        "test",
        "--config",
        "playwright.product.config.ts",
      ],
      {
        cwd: path.join(ROOT, "apps/web"),
        env: { ...context.environment, ...productEnvironment },
      },
    ),
  ];
}

function auditTasks(context) {
  return [
    task(
      "critical mutations",
      process.execPath,
      ["scripts/validation/audit-mutations.mjs"],
      { env: context.environment },
    ),
  ];
}

async function phase(name, tasks, options = {}) {
  const phaseStart = Date.now();
  process.stdout.write(`\n[validate:${name}]\n`);
  for (const item of options.setup ?? []) await runTask(name, item);
  await runWeightedTaskQueue(tasks, {
    budget: options.resourceBudget ?? 1,
    run: (item) => runTask(name, item),
    onFailure: () => abortAll("SIGTERM"),
  });
  const durationMs = Date.now() - phaseStart;
  measurements.push({ kind: "phase", name, durationMs });
  process.stdout.write(
    `[validate:${name}] completed in ${formatMs(durationMs)}\n`,
  );
}

function runTask(phaseName, item) {
  const taskStart = Date.now();
  const env = {
    ...process.env,
    CI: "true",
    KESTREL_PACKED_CONSUMER_DIR: PACKED_CONSUMER_DIR,
    KESTREL_VALIDATION_TEMP_ROOT: TEMP_DIR,
    ...item.env,
  };
  process.stdout.write(
    `[validate:${phaseName}] ${item.label}: ${item.command} ${item.args.join(" ")}\n`,
  );
  processLaunches += 1;
  return new Promise((resolve, reject) => {
    const child = spawn(item.command, item.args, {
      cwd: item.cwd ?? ROOT,
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    active.add(child);
    child.once("error", (error) => {
      active.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      active.delete(child);
      const durationMs = Date.now() - taskStart;
      measurements.push({
        kind: "task",
        phase: phaseName,
        name: item.label,
        durationMs,
      });
      process.stdout.write(
        `[validate:${phaseName}] ${item.label} completed in ${formatMs(durationMs)}\n`,
      );
      if (code === 0) resolve();
      else if (signal)
        reject(new Error(`${item.label} process ended from ${signal}`));
      else reject(new Error(`${item.label} failed with exit ${code ?? 1}`));
    });
  });
}

function task(label, command, args, options = {}) {
  return { label, command, args, ...options };
}

function nodeTests(label, cwd, files, concurrency, prefix = [], options = {}) {
  if (files.length === 0) throw new Error(`${label} discovered no tests`);
  const { isolation, workers, ...taskOptions } = options;
  if (isolation !== undefined) {
    return task(
      label,
      process.execPath,
      [
        NODE_TEST_GROUP_RUNNER,
        `--workers=${workers}`,
        `--isolation=${isolation}`,
        "--prefix",
        ...prefix,
        "--files",
        ...files,
      ],
      {
        cwd,
        fileCount: files.length,
        isolation,
        workerCount: workers,
        ...taskOptions,
      },
    );
  }
  return task(
    label,
    process.execPath,
    [
      ...prefix,
      "--import",
      "tsx",
      "--test",
      `--test-concurrency=${concurrency}`,
      "--test-reporter=spec",
      ...files,
    ],
    { cwd, fileCount: files.length, ...taskOptions },
  );
}

function trackedTests(prefixes) {
  const output = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (output.status !== 0)
    throw new Error(
      "git ls-files failed while building the fixed validation graph",
    );
  return output.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => prefixes.some((prefix) => file.startsWith(prefix)))
    .filter((file) =>
      /(?:\.(?:test|spec)\.[cm]?[jt]sx?|\.ops\.ts)$/u.test(file),
    )
    .filter(
      (file) =>
        !file.startsWith("tests/macos/") && !file.includes("/.external/"),
    )
    .sort();
}

async function startPostgres() {
  const port = await allocatePort();
  const name = `kestrel-validation-${randomUUID()}`;
  dockerStarts += 1;
  runSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    `${port}:5432`,
    "pgvector/pgvector:pg16",
  ]);
  while (true) {
    const ready = spawnSync(
      "docker",
      ["exec", name, "pg_isready", "-U", "postgres", "-d", "postgres"],
      { stdio: "ignore" },
    );
    if (ready.status === 0) break;
    const running = spawnSync(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", name],
      { encoding: "utf8" },
    );
    if (running.status !== 0 || running.stdout.trim() !== "true") {
      throw new Error("PostgreSQL container exited before it became ready");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const base = `postgresql://postgres:postgres@127.0.0.1:${port}`;
  return {
    name,
    port,
    environment: {
      KESTREL_DISABLE_DOTENV: "1",
      KESTREL_VALIDATION_POSTGRES_CONTAINER: name,
      KESTREL_VALIDATION_POSTGRES_BASE_URL: base,
      KESTREL_DISABLE_DOTENV: "1",
      KESTREL_TURN_DB_TEST_URL: `${base}/kestrel_turns`,
      KESTREL_ENVIRONMENT_DB_TEST_URL: `${base}/kestrel_environment`,
      KESTREL_APPS_DB_TEST_URL: `${base}/kestrel_apps`,
      KESTREL_PRODUCT_DATABASE_URL: `${base}/kestrel_product`,
      KESTREL_PRODUCT_RUNNER_DATABASE_URL: `${base}/kestrel_runtime`,
    },
  };
}

async function allocateProductEnvironment(context) {
  const [appPort, fakePort, runnerPort, workerHealthPort] =
    await allocatePorts(4);
  const storageRoot = path.join(REPORT_DIR, "product-storage");
  mkdirSync(storageRoot, { recursive: true });
  return {
    KESTREL_PRODUCT_APP_PORT: String(appPort),
    KESTREL_PRODUCT_FAKE_OPENROUTER_PORT: String(fakePort),
    KESTREL_PRODUCT_RUNNER_PORT: String(runnerPort),
    KESTREL_PRODUCT_WORKER_HEALTH_PORT: String(workerHealthPort),
    KESTREL_PRODUCT_STORAGE_ROOT: storageRoot,
    ...context.environment,
  };
}

function allocatePorts(count) {
  return Promise.all(Array.from({ length: count }, allocatePort)).then(
    (ports) => {
      if (new Set(ports).size !== ports.length) return allocatePorts(count);
      return ports;
    },
  );
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function runSync(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status ?? 1}`,
    );
}

function stopPostgres() {
  if (!postgres?.name) return;
  spawnSync("docker", ["stop", postgres.name], { stdio: "ignore" });
  postgres = undefined;
}

function abortAll(signal) {
  for (const child of active) terminate(child, signal);
  cleanupValidationProcesses();
}

function cleanupValidationProcesses() {
  if (!existsSync(TEMP_DIR)) return;
  const pending = [TEMP_DIR];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.name !== "lock.json") continue;
      try {
        const lock = JSON.parse(readFileSync(entryPath, "utf8"));
        if (Number.isInteger(lock.ownerPid) && lock.ownerPid !== process.pid)
          process.kill(lock.ownerPid, "SIGTERM");
      } catch {}
    }
  }
}

function terminate(child, signal = "SIGTERM") {
  if (!child.pid) return;
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    else process.kill(-child.pid, signal);
  } catch {}
}

function requireNode22() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 22)
    throw new Error(
      `Kestrel validation requires Node.js 22.x; received ${process.versions.node}. Install Node 22 and run pnpm install --frozen-lockfile.`,
    );
}

function formatMs(value) {
  return `${(value / 1000).toFixed(1)}s`;
}

function writeReport(status, error, validationRequest) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const tasks = measurements
    .filter((item) => item.kind === "task")
    .sort((a, b) => b.durationMs - a.durationMs);
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify(
      {
        version: 1,
        status,
        request: validationRequest,
        durationMs: Date.now() - startedAt,
        invariants: { buildInvocations, dockerStarts, browserStarts },
        telemetry: {
          managedProcessLaunches: processLaunches,
          environmentSetupTimeMs: measurements
            .filter(
              (item) =>
                item.kind === "task" &&
                /prepare|build|type analysis/u.test(item.name),
            )
            .reduce((sum, item) => sum + item.durationMs, 0),
        },
        slowestTasks: tasks.slice(0, 20),
        measurements,
        error:
          error instanceof Error ? error.message : error ? String(error) : null,
      },
      null,
      2,
    )}\n`,
  );
}

function printPlan() {
  const laneCounts = new Map(
    hermeticTasks()
      .filter((item) => item.label.startsWith("runtime/"))
      .map((item) => [
        item.label.slice("runtime/".length, -" hermetic".length),
        item.fileCount,
      ]),
  );
  process.stdout.write(
    [
      "public boundary",
      "shared artifacts, then root artifact + workspace type analysis (parallel budget 2)",
      `hermetic groups (global resource budget ${HERMETIC_RESOURCE_BUDGET}, resource cost ${HERMETIC_TASK_CONCURRENCY})`,
      `Web: ${RUNTIME_HERMETIC_WORKERS} shared-process shards`,
      "root hermetic lanes:",
      ...RUNTIME_HERMETIC_LANE_IDS.map(
        (lane) =>
          `  ${lane}: ${laneCounts.get(lane)} files, ${RUNTIME_HERMETIC_WORKERS} ${RUNTIME_HERMETIC_ISOLATION} shards`,
      ),
      "remaining hermetic groups: process-per-file isolation",
      "focused manual boundaries: process, postgres, chromium, audit",
      "durations: recorded, never blocking",
      "operational watchdog: GitHub Actions job timeout",
      "",
    ].join("\n"),
  );
}

async function runHermeticLane(lane) {
  if (!RUNTIME_HERMETIC_LANE_IDS.includes(lane)) {
    throw new Error(
      `unknown runtime hermetic lane '${lane}'; expected one of ${RUNTIME_HERMETIC_LANE_IDS.join(", ")}`,
    );
  }
  const expectedLabel = `runtime/${lane} hermetic`;
  const selected = hermeticTasks().filter(
    (item) => item.label === expectedLabel,
  );
  if (selected.length !== 1) {
    throw new Error(
      `runtime hermetic lane '${lane}' did not resolve exactly once`,
    );
  }
  await phase("hermetic", selected, {
    resourceBudget: HERMETIC_RESOURCE_BUDGET,
  });
}

async function runLeaf(boundary, workspace) {
  if (
    !["hermetic", "process", "postgres", "chromium", "audit"].includes(
      boundary,
    ) ||
    !workspace
  ) {
    throw new Error(
      "usage: node scripts/validate.mjs --leaf <hermetic|process|postgres|chromium|audit> <workspace|all|.>",
    );
  }
  if (
    ["postgres", "chromium", "audit"].includes(boundary) &&
    workspace !== "all"
  ) {
    throw new Error(`${boundary} focused validation requires workspace 'all'`);
  }
  if (boundary === "audit") {
    postgres = await startPostgres();
    await phase("audit", auditTasks(postgres), {
      setup: [preparePostgresTask(postgres)],
    });
    return;
  }
  if (boundary === "postgres") {
    postgres = await startPostgres();
    await phase("postgres", postgresTasks(postgres));
    return;
  }
  if (boundary === "chromium") {
    await phase("productionBuilds", [webProductionBuildTask()]);
    postgres = await startPostgres();
    await phase(
      "postgres",
      postgresTasks(postgres).filter(
        (item) => item.label === "prepare PostgreSQL templates",
      ),
    );
    await phase("chromium", await chromiumTasks(postgres));
    return;
  }
  const allTasks = boundary === "hermetic" ? hermeticTasks() : processTasks();
  if (workspace === "all") {
    const options =
      boundary === "process"
        ? { setup: processSetupTasks() }
        : boundary === "hermetic"
          ? { resourceBudget: HERMETIC_RESOURCE_BUDGET }
          : undefined;
    await phase(boundary, allTasks, options);
    return;
  }
  const expectedCwd = workspace === "." ? ROOT : path.join(ROOT, workspace);
  const tasks = allTasks.filter((item) => (item.cwd ?? ROOT) === expectedCwd);
  if (tasks.length === 0)
    throw new Error(`${workspace} has no ${boundary} tests`);
  const setup =
    boundary === "process" && workspace === "."
      ? processSetupTasks()
      : undefined;
  await phase(boundary, tasks, {
    setup,
    resourceBudget:
      boundary === "hermetic" ? HERMETIC_RESOURCE_BUDGET : undefined,
  });
}

function parseRequest(args) {
  if (args.length === 0) return { mode: "full" };
  if (args.length === 1 && args[0] === "--plan") return { mode: "plan" };
  if (args.length === 2 && args[0] === "--lane") {
    return { mode: "lane", lane: args[1] };
  }
  if (args.length === 3 && args[0] === "--leaf") {
    return { mode: "leaf", boundary: args[1], workspace: args[2] };
  }
  throw new Error(
    "usage: node scripts/validate.mjs [--plan | --lane <runtime-lane> | --leaf <boundary> <workspace|all|.>]",
  );
}
