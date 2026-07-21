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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const REPORT_DIR = path.join(ROOT, "test-results", "validation");
const COVERAGE_DIR = path.join(REPORT_DIR, "coverage");
const REPORT_PATH = path.join(REPORT_DIR, "report.json");
const PACKED_CONSUMER_DIR = path.join(REPORT_DIR, "packed-consumer");
const TEMP_DIR = path.join(REPORT_DIR, "tmp");
const startedAt = Date.now();
const active = new Set();
const measurements = [];
let dockerStarts = 0;
let browserStarts = 0;
let buildInvocations = 0;
let processLaunches = 0;
let postgres;

validateGraphContract();
const request = parseRequest(process.argv.slice(2));
if (request.mode === "plan") {
  printPlan();
  process.exit(0);
}

await runValidation(request);

async function runValidation(validationRequest) {
  cleanupValidationProcesses();
  rmSync(REPORT_DIR, { recursive: true, force: true });
  mkdirSync(COVERAGE_DIR, { recursive: true });

  process.once("SIGINT", () => abortAll("SIGINT"));
  process.once("SIGTERM", () => abortAll("SIGTERM"));

  try {
    requireNode22();
    if (validationRequest.mode === "full") await runFullValidation();
    else await runLeaf(validationRequest.boundary, validationRequest.workspace);
    enforceRequestInvariants(validationRequest);
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
    task("governance", PNPM, ["run", "governance:check"]),
    task("ruhroh configuration", PNPM, ["run", "ruhroh:validate"]),
  ]);

  buildInvocations += 1;
  await phase("sharedBuild", [
    task("shared artifacts", PNPM, [
      "-r",
      "--workspace-concurrency=4",
      "--filter",
      "@lumi/kestrel-environment-auth",
      "--filter",
      "@kestrel/mcp-security",
      "--filter",
      "@kestrel-agents/protocol",
      "--filter",
      "@kestrel-agents/sdk",
      "--filter",
      "@kestrel-agents/ai-sdk",
      "--filter",
      "@kestrel-agents/next",
      "--filter",
      "@kestrel-agents/observability",
      "run",
      "build:self",
    ]),
    task("root artifact", PNPM, ["run", "build:self"]),
    task("workspace type analysis", PNPM, [
      "-r",
      "--parallel",
      "--if-present",
      "--filter",
      "@kestrel/desktop",
      "--filter",
      "@lumi/kestrel-environment-auth",
      "--filter",
      "@kestrel/mcp-security",
      "--filter",
      "@kestrel/environment-router",
      "--filter",
      "@kestrel/workspace-runtime",
      "--filter",
      "@kestrel/mcp-service",
      "run",
      "typecheck:self",
    ]),
  ]);

  await phase("productionBuilds", productionBuildTasks());
  await phase("hermetic", hermeticTasks());
  await phase("process", processTasks(), { setup: processSetupTasks() });

  postgres = await startPostgres();
  await phase("postgres", postgresTasks(postgres));
  await phase("chromium", await chromiumTasks(postgres));
  await phase("audit", auditTasks());
}

function hermeticTasks() {
  return testTasksForBoundary("hermetic");
}

function productionBuildTasks() {
  return [
    task(
      "Web production build",
      PNPM,
      ["--filter", "@kestrel/kestrel-one", "run", "build:self"],
      {
        env: {
          BETTER_AUTH_SECRET:
            "kestrel-validation-build-secret-0000000000000000",
          BETTER_AUTH_URL: "http://127.0.0.1:43103",
          DATABASE_URL:
            "postgresql://postgres:postgres@127.0.0.1:1/kestrel_build_guard",
          KESTREL_DISABLE_DOTENV: "1",
          NEXT_PUBLIC_APP_URL: "http://127.0.0.1:43103",
        },
      },
    ),
    task("Desktop portable build", PNPM, [
      "--filter",
      "@kestrel/desktop",
      "run",
      "build:self",
    ]),
    task("documentation build", PNPM, [
      "--filter",
      "@kestrel/docs",
      "run",
      "build:self",
    ]),
    task("service builds", PNPM, [
      "-r",
      "--workspace-concurrency=1",
      "--filter",
      "./apps/environment-router",
      "--filter",
      "./apps/workspace-runtime",
      "--filter",
      "./apps/mcp-service",
      "run",
      "build:self",
    ]),
  ];
}

function processTasks() {
  return testTasksForBoundary("process");
}

function processSetupTasks() {
  return [
    task("packed consumer fixture", process.execPath, [
      "--import",
      "tsx",
      "scripts/validation/prepare-packed-consumer.ts",
    ]),
    nodeTests("TUI PTY journeys", ROOT, ["tests/ops/tui/tui.ops.ts"], 1, [], {
      coverage: false,
    }),
  ];
}

function testTasksForBoundary(boundary) {
  const groups = new Map();
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
    const group = groups.get(execution.cwd) ?? { ...execution, files: [] };
    group.files.push(execution.relativeFile);
    groups.set(execution.cwd, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .flatMap((group) => {
      const files = group.files.sort();
      if (boundary !== "process") {
        return [
          nodeTests(
            `${group.label} ${boundary}`,
            group.cwd,
            files,
            4,
            group.prefix,
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
          singleThreaded.has(file) ? { coverage: false } : undefined,
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
    /^(apps\/(?:desktop|docs|environment-router|workspace-runtime|mcp-service)|packages\/[^/]+)\//u,
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
    task(
      "prepare PostgreSQL templates",
      process.execPath,
      ["--import", "tsx", "scripts/validation/prepare-postgres.ts"],
      {
        env: context.environment,
      },
    ),
    task(
      "PostgreSQL contracts",
      process.execPath,
      ["--import", "tsx", "scripts/validation/run-postgres.ts"],
      {
        env: context.environment,
        coverage: true,
      },
    ),
  ];
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
        coverage: true,
      },
    ),
  ];
}

function auditTasks() {
  return [
    task("coverage baseline", process.execPath, [
      "scripts/validation/check-coverage.mjs",
      COVERAGE_DIR,
    ]),
    task("critical mutations", process.execPath, [
      "scripts/validation/audit-mutations.mjs",
    ]),
    task("contract registry", process.execPath, [
      "scripts/check-contract-proofs.mjs",
    ]),
  ];
}

async function phase(name, tasks, options = {}) {
  const phaseStart = Date.now();
  process.stdout.write(`\n[validate:${name}]\n`);
  for (const item of options.setup ?? []) await runTask(name, item);
  for (const item of tasks) await runTask(name, item);
  const durationMs = Date.now() - phaseStart;
  measurements.push({ kind: "phase", name, durationMs });
  process.stdout.write(
    `[validate:${name}] completed in ${formatMs(durationMs)}\n`,
  );
}

function runTask(phaseName, item) {
  const taskStart = Date.now();
  const coveragePath = path.join(
    COVERAGE_DIR,
    safeName(`${phaseName}-${item.label}`),
  );
  mkdirSync(coveragePath, { recursive: true });
  const env = {
    ...process.env,
    CI: "true",
    NODE_V8_COVERAGE: coveragePath,
    KESTREL_CONTRACT_TIMINGS: path.join(REPORT_DIR, "contract-timings.jsonl"),
    KESTREL_PACKED_CONSUMER_DIR: PACKED_CONSUMER_DIR,
    KESTREL_VALIDATION_TEMP_ROOT: TEMP_DIR,
    ...item.env,
  };
  if (item.coverage === false) delete env.NODE_V8_COVERAGE;
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
  return { label, command, args, coverage: false, ...options };
}

function nodeTests(label, cwd, files, concurrency, prefix = [], options = {}) {
  if (files.length === 0) throw new Error(`${label} discovered no tests`);
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
    { cwd, coverage: true, ...options },
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
      KESTREL_VALIDATION_POSTGRES_CONTAINER: name,
      KESTREL_VALIDATION_POSTGRES_BASE_URL: base,
      KESTREL_TURN_DB_TEST_URL: `${base}/kestrel_turns`,
      KESTREL_ENVIRONMENT_DB_TEST_URL: `${base}/kestrel_environment`,
      KESTREL_APPS_DB_TEST_URL: `${base}/kestrel_apps`,
      KESTREL_PRODUCT_DATABASE_URL: `${base}/kestrel_product`,
      KESTREL_PRODUCT_RUNNER_DATABASE_URL: `${base}/kestrel_runtime`,
    },
  };
}

async function allocateProductEnvironment(context) {
  const [appPort, fakePort, runnerPort] = await allocatePorts(3);
  const runId = `${process.pid}-${Date.now()}`;
  const storageRoot = path.join(REPORT_DIR, "product-storage");
  mkdirSync(storageRoot, { recursive: true });
  return {
    KESTREL_PRODUCT_APP_PORT: String(appPort),
    KESTREL_PRODUCT_FAKE_OPENROUTER_PORT: String(fakePort),
    KESTREL_PRODUCT_RUNNER_PORT: String(runnerPort),
    KESTREL_PRODUCT_WORKER_READY_FILE: path.join(
      REPORT_DIR,
      `worker-${runId}.ready`,
    ),
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

function enforceInvariant(value, message) {
  if (!value) throw new Error(message);
}

function safeName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function formatMs(value) {
  return `${(value / 1000).toFixed(1)}s`;
}

function writeReport(status, error, validationRequest) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const tasks = measurements
    .filter((item) => item.kind === "task")
    .sort((a, b) => b.durationMs - a.durationMs);
  const testTimings = readContractTimings();
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
          assertionTimeMs: testTimings.reduce(
            (sum, item) => sum + item.durationMs,
            0,
          ),
          environmentSetupTimeMs: measurements
            .filter(
              (item) =>
                item.kind === "task" &&
                /prepare|build|type analysis/u.test(item.name),
            )
            .reduce((sum, item) => sum + item.durationMs, 0),
        },
        slowestTasks: tasks.slice(0, 20),
        slowestTests: testTimings
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, 20),
        measurements,
        error:
          error instanceof Error ? error.message : error ? String(error) : null,
      },
      null,
      2,
    )}\n`,
  );
}

function readContractTimings() {
  const file = path.join(REPORT_DIR, "contract-timings.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function printPlan() {
  process.stdout.write(
    "preflight\nshared build and type analysis\nproduction builds (sequential)\nhermetic groups (sequential, test concurrency <= 4)\nprocess groups (sequential, test concurrency <= 4)\npostgres: one container\nchromium: one browser\naudit: contracts, coverage, mutations\ndurations: recorded, never blocking\noperational watchdog: GitHub Actions job timeout\n",
  );
}

function validateGraphContract() {
  const packageFiles = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "package.json",
      "apps/*/package.json",
      "packages/*/package.json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (packageFiles.status !== 0)
    throw new Error("Unable to inspect workspace validation leaves");
  for (const file of packageFiles.stdout.split("\0").filter(Boolean)) {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (name.startsWith("ci:"))
        throw new Error(`${file}: obsolete ${name} command is prohibited`);
      if (
        [
          "build:self",
          "typecheck:self",
          "test:unit",
          "test:integration",
        ].includes(name)
      ) {
        if (/\bdocker\b|\bcompose\b/u.test(command))
          throw new Error(
            `${file}: ${name} must not start shared infrastructure`,
          );
        if (
          name !== "build:self" &&
          /\b(?:pnpm|npm|yarn)\b[^\n]*\bbuild(?::self)?\b/u.test(command)
        )
          throw new Error(`${file}: ${name} must not build dependencies`);
      }
    }
  }
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  const validationCalls = workflow.match(/\bpnpm validate\b/gu)?.length ?? 0;
  if (validationCalls !== 1)
    throw new Error(
      `CI must invoke pnpm validate exactly once; found ${validationCalls}`,
    );
  const productConfig = readFileSync(
    path.join(ROOT, "apps/web/playwright.product.config.ts"),
    "utf8",
  );
  for (const forbidden of [
    "globalSetup",
    "REDIS_URL",
    "MINIO",
    "next dev",
    "product-dev-all",
  ]) {
    if (productConfig.includes(forbidden))
      throw new Error(
        `Product validation config must not contain ${forbidden}`,
      );
  }
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
    await phase(
      "productionBuilds",
      productionBuildTasks().filter(
        (item) => item.label === "Web production build",
      ),
    );
    await phase("hermetic", hermeticTasks());
    await phase("process", processTasks(), { setup: processSetupTasks() });
    postgres = await startPostgres();
    await phase("postgres", postgresTasks(postgres));
    await phase("chromium", await chromiumTasks(postgres));
    await phase("audit", auditTasks());
    return;
  }
  if (boundary === "postgres") {
    postgres = await startPostgres();
    await phase("postgres", postgresTasks(postgres));
    return;
  }
  if (boundary === "chromium") {
    await phase(
      "productionBuilds",
      productionBuildTasks().filter(
        (item) => item.label === "Web production build",
      ),
    );
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
    await phase(
      boundary,
      allTasks,
      boundary === "process" ? { setup: processSetupTasks() } : undefined,
    );
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
  await phase(boundary, tasks, { setup });
}

function parseRequest(args) {
  if (args.length === 0) return { mode: "full" };
  if (args.length === 1 && args[0] === "--plan") return { mode: "plan" };
  if (args.length === 3 && args[0] === "--leaf") {
    return { mode: "leaf", boundary: args[1], workspace: args[2] };
  }
  throw new Error(
    "usage: node scripts/validate.mjs [--plan | --leaf <boundary> <workspace|all|.>]",
  );
}

function enforceRequestInvariants(validationRequest) {
  if (validationRequest.mode !== "full") return;
  enforceInvariant(
    buildInvocations === 1,
    `expected one shared build invocation, observed ${buildInvocations}`,
  );
  enforceInvariant(
    dockerStarts === 1,
    `expected one PostgreSQL startup, observed ${dockerStarts}`,
  );
  enforceInvariant(
    browserStarts === 1,
    `expected one Chromium startup, observed ${browserStarts}`,
  );
}
