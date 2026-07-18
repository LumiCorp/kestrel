import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";
import { createAgent } from "../packages/sdk/src/index.js";
import { KestrelClient } from "../packages/sdk/src/runner.js";
import { resolveKestrelCoreHome } from "../src/localCore/home.js";
import { ModelPolicyStore } from "../src/profile/modelPolicy.js";
import type {
  KestrelRequestContext,
  RunnerRunStreamEvent,
  RunnerRunTerminalEvent,
} from "../packages/sdk/src/index.js";
import {
  SDK_AGENT_SHAKEDOWN_CODING_CHANGELOG_ENTRY,
  SDK_AGENT_SHAKEDOWN_DEFAULT_MODEL,
  readSdkAgentShakedownToolObservation,
  selectSdkAgentShakedownScenarios,
  summarizeSdkAgentShakedownLifecycle,
  validateSdkAgentShakedownObservation,
  type SdkAgentShakedownScenario,
  type SdkAgentShakedownToolObservation,
} from "./lib/sdk-agent-shakedown.js";

const SCENARIO_TIMEOUT_MS = 180_000;

interface CliOptions {
  model: string;
  scenarios: string[];
  keepWorkspace: boolean;
}

interface ScenarioReport {
  id: string;
  title: string;
  status: "passed" | "failed";
  durationMs: number;
  terminalType: string;
  runId?: string | undefined;
  outputStatus?: string | undefined;
  assistantText?: string | null | undefined;
  telemetry?: Record<string, unknown> | undefined;
  visibleTodos?: unknown;
  runtimeError?: unknown;
  lifecycle: ReturnType<typeof summarizeSdkAgentShakedownLifecycle>;
  tools: SdkAgentShakedownToolObservation[];
  errors: string[];
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  await loadShellAndDotEnv(process.cwd(), {
    preferDotEnvKeys: [
      "OPENROUTER_API_KEY",
      "OPENROUTER_BASE_URL",
      "OPENROUTER_SITE_URL",
      "OPENROUTER_APP_NAME",
    ],
  });
  requireEnvironmentValue("OPENROUTER_API_KEY");

  const scenarios = selectSdkAgentShakedownScenarios(options.scenarios);
  const reportDir = path.join(process.cwd(), "tmp", "sdk-agent-shakedown", timestampKey());
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-sdk-shakedown-workspace-"));
  await mkdir(reportDir, { recursive: true });
  await seedSdkAgentShakedownWorkspace(workspaceRoot);

  const runner = await startIsolatedWebRunner(options.model);
  const context: KestrelRequestContext = {
    actor: {
      actorId: "sdk-agent-shakedown",
      actorType: "operator",
      displayName: "SDK Agent Shake-down",
      tenantId: "internal",
    },
    tenantId: "internal",
    durability: "continue_on_disconnect",
  };
  const client = new KestrelClient({
    target: { kind: "remote", baseUrl: runner.url, authToken: runner.token },
  });
  const reports: ScenarioReport[] = [];
  let keepWorkspace = options.keepWorkspace;

  try {
    const health = await client.getHealth();
    const profiles = await client.listProfiles(context);
    const profile = profiles.find((candidate) => candidate.id === "reference");
    assert.ok(profile, `Reference profile is missing. Profiles: ${profiles.map((item) => item.id).join(", ")}`);
    assert.equal(
      profile.model,
      options.model,
      `Shake-down requested ${options.model}, but the reference profile resolved ${profile.model ?? "no model"}.`,
    );
    process.stdout.write(
      `[sdk-shakedown] runner=${runner.url} service=${health.service.name}@${health.service.version} profile=${profile.id} model=${profile.model}\n`,
    );

    const agent = createAgent({
      id: "sdk-agent-shakedown",
      profileId: profile.id,
      target: { kind: "remote", baseUrl: runner.url, authToken: runner.token },
    });
    try {
      for (const scenario of scenarios) {
        const report = await runScenario({ agent, client, scenario, context, workspaceRoot });
        reports.push(report);
        process.stdout.write(
          `[sdk-shakedown] ${report.status === "passed" ? "PASS" : "FAIL"} ${scenario.id} durationMs=${report.durationMs} modelCalls=${readTelemetryNumber(report.telemetry, "modelCalls")} toolCalls=${readTelemetryNumber(report.telemetry, "toolCalls")}\n`,
        );
        for (const error of report.errors) {
          process.stderr.write(`[sdk-shakedown]   ${error}\n`);
        }
      }
    } finally {
      await agent.close();
    }
  } finally {
    await client.close();
    await runner.close();
  }

  const failed = reports.filter((report) => report.status === "failed");
  keepWorkspace ||= failed.length > 0;
  const reportPath = path.join(reportDir, "report.json");
  const summary = {
    version: "sdk_agent_shakedown_v1",
    generatedAt: new Date().toISOString(),
    model: options.model,
    profileId: "reference",
    workspaceRoot: keepWorkspace ? workspaceRoot : null,
    scenarioCount: reports.length,
    passed: reports.length - failed.length,
    failed: failed.length,
    telemetry: sumTelemetry(reports),
    scenarios: reports,
  };
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  if (keepWorkspace === false) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
  process.stdout.write(
    `[sdk-shakedown] summary pass=${summary.passed} fail=${summary.failed} report=${reportPath}${keepWorkspace ? ` workspace=${workspaceRoot}` : ""}\n`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function runScenario(input: {
  agent: ReturnType<typeof createAgent>;
  client: KestrelClient;
  scenario: SdkAgentShakedownScenario;
  context: KestrelRequestContext;
  workspaceRoot: string;
}): Promise<ScenarioReport> {
  const startedAt = Date.now();
  const sessionId = `sdk-shakedown-${input.scenario.id}-${randomUUID()}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.scenario.timeoutMs ?? SCENARIO_TIMEOUT_MS,
  );
  const tools: SdkAgentShakedownToolObservation[] = [];
  let terminal: RunnerRunTerminalEvent | undefined;
  let thrownError: unknown;
  let visibleTodos: unknown;
  let sessionDescriptionError: unknown;

  process.stdout.write(`[sdk-shakedown] START ${input.scenario.id} ${input.scenario.title}\n`);
  try {
    const stream = input.agent.stream(
      {
        sessionId,
        message: input.scenario.prompt,
        eventType: "job.run",
        interactionMode: "build",
        actSubmode: "full_auto",
        systemInstructions: [
          "This is a deterministic systems check. Use every named tool exactly as requested, keep the visible plan current, settle live exec_command sessions, validate after the final mutation, and do not ask the user questions.",
        ],
        workspace: {
          workspaceId: sessionId,
          workspaceRoot: input.workspaceRoot,
          appRoot: ".",
          commands: {},
          label: `SDK shake-down ${input.scenario.id}`,
          managedWorktreeRequired: false,
          planDocumentSync: false,
        },
        signal: controller.signal,
      },
      input.context,
    );
    for await (const event of stream) {
      observeToolEvent(event, tools);
    }
    terminal = await stream.result;
  } catch (error) {
    thrownError = error;
  } finally {
    clearTimeout(timeout);
  }

  if (terminal !== undefined) {
    try {
      const session = await input.client.describeSession(sessionId, input.context);
      visibleTodos = (session as Record<string, unknown>).visibleTodos;
    } catch (error) {
      sessionDescriptionError = error;
    }
  }

  const terminalRecord = terminal as RunnerRunTerminalEvent | undefined;
  const result = terminalRecord?.payload.result;
  const runtimeError = terminalRecord?.type === "run.failed"
    ? terminalRecord.payload.error
    : undefined;
  const observationErrors = terminalRecord === undefined || result === undefined
    ? [formatError(thrownError ?? new Error(
        terminalRecord === undefined
          ? "SDK stream ended without a terminal event."
          : "SDK terminal event did not include a run result.",
      ))]
    : validateSdkAgentShakedownObservation(input.scenario, {
        terminalType: terminalRecord.type,
        outputStatus: result.output.status,
        assistantText: result.assistantText,
        visibleTodos,
        tools,
      });
  const workspaceErrors = await verifyScenarioWorkspace(input.scenario.id, input.workspaceRoot);
  const errors = [
    ...(runtimeError !== undefined ? [`Runtime failed: ${formatError(runtimeError)}`] : []),
    ...observationErrors,
    ...(sessionDescriptionError !== undefined
      ? [`Could not describe final session state: ${formatError(sessionDescriptionError)}`]
      : []),
    ...workspaceErrors,
  ];
  return {
    id: input.scenario.id,
    title: input.scenario.title,
    status: errors.length === 0 ? "passed" : "failed",
    durationMs: Date.now() - startedAt,
    terminalType: terminalRecord?.type ?? "missing",
    ...(result?.output.runId !== undefined ? { runId: result.output.runId } : {}),
    ...(result?.output.status !== undefined ? { outputStatus: result.output.status } : {}),
    ...(result !== undefined ? { assistantText: result.assistantText } : {}),
    ...(result?.output.telemetry !== undefined ? { telemetry: result.output.telemetry } : {}),
    ...(visibleTodos !== undefined ? { visibleTodos } : {}),
    ...(runtimeError !== undefined ? { runtimeError } : {}),
    lifecycle: summarizeSdkAgentShakedownLifecycle(tools),
    tools,
    errors,
  };
}

function observeToolEvent(
  event: RunnerRunStreamEvent,
  tools: SdkAgentShakedownToolObservation[],
): void {
  if (
    event.type !== "run.tool.started" &&
    event.type !== "run.tool.completed" &&
    event.type !== "run.tool.failed"
  ) {
    return;
  }
  const observation = readSdkAgentShakedownToolObservation(event);
  if (observation === undefined) {
    return;
  }
  tools.push(observation);
  if (observation.phase !== "started") {
    process.stdout.write(
      `[sdk-shakedown]   tool=${observation.toolName} phase=${observation.phase} result=${observation.resultStatus ?? "unknown"} output=${observation.outputStatus ?? "n/a"} durationMs=${observation.durationMs ?? 0}\n`,
    );
  }
}

async function verifyScenarioWorkspace(
  scenarioId: SdkAgentShakedownScenario["id"],
  workspaceRoot: string,
): Promise<string[]> {
  if (scenarioId === "read") {
    const seed = await readFile(path.join(workspaceRoot, "seed", "readme.txt"), "utf8");
    return seed === "SHAKEDOWN_NEEDLE=alpha\n"
      ? []
      : ["Read scenario changed its seed fixture."];
  }

  if (scenarioId === "filesystem") {
    const errors: string[] = [];
    const work = path.join(workspaceRoot, ".kestrel-shakedown", "work");
    const finalJson = await readJsonOrError(path.join(work, "final.json"), errors);
    const dataJson = await readJsonOrError(path.join(work, "data.json"), errors);
    const expected = { items: [{ id: "beta", url: "https://example.com/beta" }] };
    if (JSON.stringify(finalJson) !== JSON.stringify(expected)) {
      errors.push(`final.json did not match ${JSON.stringify(expected)}.`);
    }
    if (JSON.stringify(dataJson) !== JSON.stringify(expected)) {
      errors.push(`data.json did not match ${JSON.stringify(expected)}.`);
    }
    if (await pathExists(path.join(work, "scratch.txt"))) {
      errors.push("scratch.txt still exists after fs.delete.");
    }
    if (await pathExists(path.join(work, "copy.json"))) {
      errors.push("copy.json still exists after fs.move.");
    }
    return errors;
  }

  if (scenarioId === "coding") {
    return await verifySdkAgentShakedownCodingWorkspace(workspaceRoot);
  }

  const errors: string[] = [];
  const execJson = await readJsonOrError(
    path.join(workspaceRoot, ".kestrel-shakedown", "exec.json"),
    errors,
  );
  if (JSON.stringify(execJson) !== JSON.stringify({ items: [{ status: "ok" }] })) {
    errors.push("exec.json did not contain the expected status payload.");
  }
  return errors;
}

export async function seedSdkAgentShakedownWorkspace(workspaceRoot: string): Promise<void> {
  await mkdir(path.join(workspaceRoot, "seed"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "seed", "readme.txt"),
    "SHAKEDOWN_NEEDLE=alpha\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    `${JSON.stringify({ name: "kestrel-sdk-shakedown-fixture", private: true }, null, 2)}\n`,
    "utf8",
  );
  const codingRoot = path.join(workspaceRoot, "coding-fixture");
  await mkdir(path.join(codingRoot, "src"), { recursive: true });
  await mkdir(path.join(codingRoot, "test"), { recursive: true });
  await writeFile(
    path.join(codingRoot, "package.json"),
    `${JSON.stringify({
      name: "kestrel-sdk-coding-lifecycle-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test test/inventory.test.mjs" },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(codingRoot, "src", "inventory.mjs"),
    [
      "export function formatInventory(items) {",
      "  return items",
      "    .filter((item) => item.quantity)",
      "    .map((item) => `${item.name.trim()}=${item.quantity}`)",
      "    .join(\"\\n\");",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(codingRoot, "test", "inventory.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { setTimeout as delay } from "node:timers/promises";',
      "",
      'import { formatInventory } from "../src/inventory.mjs";',
      "",
      'test("preserves zero-quantity rows without mutating the input", async () => {',
      "  await delay(350);",
      '  const items = [{ name: " bolts ", quantity: 0 }, { name: "Nuts", quantity: 2 }];',
      "  const before = structuredClone(items);",
      '  assert.equal(formatInventory(items), "bolts=0\\nNuts=2");',
      "  assert.deepEqual(items, before);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(codingRoot, "CHANGELOG.md"), "# Changelog\n", "utf8");
  await initializeFixtureRepository(workspaceRoot);
}

async function initializeFixtureRepository(workspaceRoot: string): Promise<void> {
  const commands: Array<{ args: string[]; label: string }> = [
    { args: ["init", "--quiet"], label: "initialize" },
    { args: ["add", "."], label: "stage" },
    {
      args: [
        "-c", "user.name=Kestrel SDK Shake-down",
        "-c", "user.email=kestrel-shakedown@example.invalid",
        "commit", "--quiet", "-m", "Seed SDK shake-down fixture",
      ],
      label: "commit",
    },
  ];
  for (const command of commands) {
    const result = await runFixtureProcess("git", command.args, workspaceRoot, 10_000);
    if (result.code !== 0) {
      throw new Error(`Could not ${command.label} the SDK shake-down fixture repository: ${renderFixtureProcess(result)}`);
    }
  }
}

export async function verifySdkAgentShakedownCodingWorkspace(workspaceRoot: string): Promise<string[]> {
  const errors: string[] = [];
  const codingRoot = path.join(workspaceRoot, "coding-fixture");
  const statusResult = await runFixtureProcess(
    "git",
    ["status", "--short", "--untracked-files=all"],
    workspaceRoot,
    5_000,
  );
  const changedPaths = statusResult.stdout
    .split("\n")
    .filter((line) => line.length >= 4)
    .map((line) => line.slice(3))
    .sort();
  const expectedChangedPaths = [
    "coding-fixture/CHANGELOG.md",
    "coding-fixture/src/inventory.mjs",
  ];
  if (statusResult.code !== 0 || JSON.stringify(changedPaths) !== JSON.stringify(expectedChangedPaths)) {
    errors.push(
      `Expected only the coding source and changelog to change; received ${renderFixtureProcess(statusResult)} paths=${JSON.stringify(changedPaths)}.`,
    );
  }
  const testResult = await runFixtureProcess(
    process.execPath,
    ["--test", "test/inventory.test.mjs"],
    codingRoot,
    10_000,
  );
  if (testResult.code !== 0) {
    errors.push(`Coding fixture tests failed after agent completion: ${renderFixtureProcess(testResult)}`);
  }

  const sourcePath = path.join(codingRoot, "src", "inventory.mjs");
  const oracleSource = [
    'import { pathToFileURL } from "node:url";',
    "const module = await import(pathToFileURL(process.argv[1]).href);",
    'const items = [{ name: " bolts ", quantity: 0 }, { name: "Nuts", quantity: 2 }];',
    "const before = JSON.stringify(items);",
    "const output = module.formatInventory(items);",
    'if (output !== "bolts=0\\nNuts=2" || JSON.stringify(items) !== before) process.exit(1);',
    'process.stdout.write("ORACLE_OK");',
  ].join("\n");
  const oracleResult = await runFixtureProcess(
    process.execPath,
    ["--input-type=module", "--eval", oracleSource, sourcePath],
    codingRoot,
    5_000,
  );
  if (oracleResult.code !== 0 || oracleResult.stdout !== "ORACLE_OK") {
    errors.push(`Coding fixture hidden behavior check failed: ${renderFixtureProcess(oracleResult)}`);
  }

  try {
    const changelog = await readFile(path.join(codingRoot, "CHANGELOG.md"), "utf8");
    const entryCount = changelog.split("\n")
      .filter((line) => line === SDK_AGENT_SHAKEDOWN_CODING_CHANGELOG_ENTRY)
      .length;
    if (entryCount !== 1) {
      errors.push(`Expected the coding changelog entry exactly once; received ${entryCount}.`);
    }
  } catch (error) {
    errors.push(`Could not read coding-fixture/CHANGELOG.md: ${formatError(error)}`);
  }
  return errors;
}

async function runFixtureProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }> {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const exit = await waitForChildExit(child);
    return {
      ...exit,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function renderFixtureProcess(result: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): string {
  return JSON.stringify({
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-2000),
  });
}

async function startIsolatedWebRunner(model: string): Promise<{
  url: string;
  token: string;
  close(): Promise<void>;
}> {
  const kestrelHome = await mkdtemp(path.join(os.tmpdir(), "kestrel-sdk-shakedown-home-"));
  const runnerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KESTREL_HOME: kestrelHome,
    KESTREL_CORE_HOME: undefined,
    KESTREL_LOCAL_CORE_API_SOCKET: undefined,
    KESTREL_LOCAL_CORE_API_TOKEN: undefined,
    KESTREL_DEV_SHELL_SOCKET_PATH: undefined,
    KESTREL_DEV_SHELL_LOG_PATH: undefined,
    KESTREL_DEV_SHELL_STATUS_PATH: undefined,
    KESTREL_DATABASE_URL_SOURCE: undefined,
    KESTREL_LOCAL_CORE_DIRECT: "1",
    KESTREL_STORE_DRIVER: "sqlite",
    DATABASE_URL: undefined,
    OPENROUTER_MODEL: model,
    FORCE_COLOR: "0",
  };
  const isolatedCoreHome = resolveKestrelCoreHome(runnerEnv, process.platform).homePath;
  new ModelPolicyStore(isolatedCoreHome).write({
    version: 1,
    provider: "openrouter",
    model,
    modelByStage: {},
    modelCapabilities: {
      visionInputEnabled: false,
    },
  });
  const port = await reservePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.resolve(process.cwd(), "cli/tui.ts"), "web", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: runnerEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  const exitPromise = waitForChildExit(child);

  try {
    const startupOutput = await waitForOutput(stdout, /export KESTREL_RUNNER_SERVICE_TOKEN=/u);
    const url = startupOutput.match(/export KESTREL_RUNNER_SERVICE_URL='([^']+)'/u)?.[1];
    const token = startupOutput.match(/export KESTREL_RUNNER_SERVICE_TOKEN='([^']+)'/u)?.[1];
    assert.match(String(url ?? ""), /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.match(String(token ?? ""), /^[0-9a-f]{48}$/u);
    return {
      url: url as string,
      token: token as string,
      async close() {
        child.kill("SIGINT");
        const exit = await exitPromise;
        await rm(kestrelHome, { recursive: true, force: true });
        assert.equal(exit.code, 0, `Kestrel web exited unexpectedly: ${stderr.join("")}`);
      },
    };
  } catch (error) {
    child.kill("SIGINT");
    await exitPromise;
    await rm(kestrelHome, { recursive: true, force: true });
    throw new Error(`${formatError(error)}\n${stderr.join("")}`.trim());
  }
}

async function waitForOutput(chunks: string[], pattern: RegExp, timeoutMs = 30_000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = chunks.join("");
    if (pattern.test(output)) {
      return output;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for runner output matching ${pattern.toString()}.`);
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to reserve an ephemeral port."));
        return;
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

async function waitForChildExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    model: SDK_AGENT_SHAKEDOWN_DEFAULT_MODEL,
    scenarios: [],
    keepWorkspace: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--keep-workspace") {
      options.keepWorkspace = true;
      continue;
    }
    if (arg === "--model") {
      options.model = requireCliValue(args, ++index, "--model");
      continue;
    }
    if (arg === "--scenario") {
      options.scenarios.push(
        ...requireCliValue(args, ++index, "--scenario").split(",").map((value) => value.trim()).filter(Boolean),
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? ""}`);
  }
  return options;
}

function printUsage(): void {
  process.stdout.write([
    "Usage: pnpm run sdk:shakedown -- [options]",
    "",
    "Options:",
    `  --model <id>          OpenRouter model (default: ${SDK_AGENT_SHAKEDOWN_DEFAULT_MODEL})`,
    "  --scenario <ids>     Comma-separated: read,filesystem,exec,coding (default: all)",
    "  --keep-workspace     Preserve the temporary fixture after a passing run",
    "  --help               Show this help",
    "",
  ].join("\n"));
}

function requireCliValue(args: string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function requireEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the live SDK agent shake-down.`);
  }
  return value;
}

async function readJsonOrError(filePath: string, errors: string[]): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    errors.push(`Could not read valid JSON from ${filePath}: ${formatError(error)}`);
    return ;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function readTelemetryNumber(telemetry: Record<string, unknown> | undefined, field: string): number {
  const value = telemetry?.[field];
  return typeof value === "number" ? value : 0;
}

function sumTelemetry(reports: ScenarioReport[]): Record<string, number> {
  const fields = ["stepsExecuted", "toolCalls", "modelCalls", "durationMs", "inputTokens", "outputTokens", "totalTokens"];
  return Object.fromEntries(fields.map((field) => [
    field,
    reports.reduce((total, report) => total + readTelemetryNumber(report.telemetry, field), 0),
  ]));
}

function timestampKey(): string {
  return new Date().toISOString().replace(/[-:.TZ]/gu, "");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {}
  }
  return String(error);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    process.stderr.write(`[sdk-shakedown] failed: ${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
