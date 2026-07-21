import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TuiSessionMeta } from "../../../cli/contracts.js";
import { SessionStore } from "../../../cli/session/SessionStore.js";
import { LocalCoreClient } from "../../../src/localCore/client.js";
import { resolveLocalCorePaths } from "../../../src/localCore/home.js";
import { seedTuiHome } from "./tuiHome.js";

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu;

export interface TuiScenarioStep {
  waitFor: RegExp | string;
  fromCursor?: boolean | undefined;
  send?: string | undefined;
  actions?: TuiScenarioAction[] | undefined;
  abortPatterns?: TuiAbortPattern[] | undefined;
}

export interface TuiScenarioAction {
  typeText?: string | undefined;
  key?: "enter" | "esc" | "up" | "down" | "left" | "right" | "tab" | "shift-tab" | "ctrl-p" | "ctrl-2" | undefined;
}

export interface TuiAbortPattern {
  pattern: RegExp | string;
  reason?: string | undefined;
  fromCursor?: boolean | undefined;
  maxMatches?: number | undefined;
}

export function toDriverActions(actions: TuiScenarioAction[] | undefined): Array<Record<string, unknown>> {
  return (actions ?? []).map((action) => ({
    ...(action.typeText !== undefined ? { typeText: action.typeText } : {}),
    ...(action.key !== undefined ? { key: action.key } : {}),
  }));
}

export function toDriverAbortPatterns(patterns: TuiAbortPattern[] | undefined): Array<Record<string, unknown>> {
  return (patterns ?? []).map((item) => ({
    pattern: typeof item.pattern === "string" ? item.pattern : item.pattern.source,
    regex: typeof item.pattern !== "string",
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
    ...(item.fromCursor !== undefined ? { fromCursor: item.fromCursor } : {}),
    ...(item.maxMatches !== undefined ? { maxMatches: item.maxMatches } : {}),
  }));
}

export async function runTuiScenario(input: {
  sessionName: string;
  freshSessionName?: string | undefined;
  databaseUrl?: string;
  steps: TuiScenarioStep[];
  abortPatterns?: TuiAbortPattern[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<string> {
  const result = await runTuiScenarioWithSession(input);
  return result.transcript;
}

export async function runTuiScenarioWithSession(input: {
  sessionName: string;
  freshSessionName?: string | undefined;
  databaseUrl?: string;
  steps: TuiScenarioStep[];
  abortPatterns?: TuiAbortPattern[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<{ transcript: string; session: TuiSessionMeta }> {
  const tempDir = path.join(
    process.env.KESTREL_VALIDATION_TEMP_ROOT ?? os.tmpdir(),
    `kestrel-pty-${randomUUID()}`,
  );
  const homeDir = path.join(tempDir, "home");
  const coreProductRoot = path.join(tempDir, "core-home");
  const corePaths = resolveLocalCorePaths(coreProductRoot);
  await mkdir(tempDir, { recursive: true });
  await seedTuiHome(corePaths.stateRootPath);

  const driverPath = path.resolve(process.cwd(), "tests/ops/helpers/pty_driver.py");
  const tuiEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.env ?? {}),
    HOME: homeDir,
    KESTREL_CORE_HOME: coreProductRoot,
    KESTREL_CORE_DATABASE_MODE: input.databaseUrl ? "external" : "pglite",
    ...(input.databaseUrl
      ? {
          DATABASE_URL: input.databaseUrl,
          KESTREL_CORE_EXTERNAL_DATABASE_URL: input.databaseUrl,
        }
      : {}),
    KESTREL_CORE_IDLE_TIMEOUT_MS: "600000",
    KESTREL_DISABLE_DOTENV: "1",
    ...(input.databaseUrl ? { KESTREL_DB_PORT: "1" } : {}),
    OPENROUTER_API_KEY: input.env?.OPENROUTER_API_KEY ?? "ops-test-openrouter",
    TAVILY_API_KEY: input.env?.TAVILY_API_KEY ?? "ops-test-tavily",
    FORCE_COLOR: "0",
    TERM: "xterm-256color",
  };
  delete tuiEnvironment.CI;
  delete tuiEnvironment.NODE_V8_COVERAGE;
  delete tuiEnvironment.KESTREL_CONTRACT_TIMINGS;
  const payload = JSON.stringify({
    command: [
      process.execPath,
      "--import",
      "tsx",
      path.resolve(process.cwd(), "cli/tui.ts"),
      "--scripted",
      ...(input.freshSessionName !== undefined
        ? ["--new-session", input.freshSessionName]
        : ["--session", input.sessionName]),
      "--profile",
      "reference",
    ],
    env: tuiEnvironment,
    steps: input.steps.map((step) => ({
      pattern: typeof step.waitFor === "string" ? step.waitFor : step.waitFor.source,
      regex: typeof step.waitFor !== "string",
      fromCursor: step.fromCursor ?? false,
      send: step.send ?? null,
      actions: toDriverActions(step.actions),
      abortPatterns: toDriverAbortPatterns(step.abortPatterns),
    })),
    abortPatterns: toDriverAbortPatterns(input.abortPatterns),
  });

  try {
    const result = await runPythonDriver(driverPath, payload);
    if (result.exitCode !== 0) {
      const transcript = normalizeTerminalOutput(result.stderr || result.stdout);
      const daemonLog = await readOptionalText(path.join(corePaths.logsPath, "local-core-daemon.log"));
      const coreFailure = await readLocalCoreFailure(corePaths.apiSocketPath, corePaths.apiTokenPath);
      throw new Error([
        transcript,
        ...(coreFailure === undefined
          ? []
          : ["Local Core failure:", coreFailure]),
        ...(daemonLog === undefined
          ? []
          : ["Local Core daemon log:", daemonLog.trimEnd()]),
      ].join("\n"));
    }
    const sessionStore = new SessionStore(corePaths.stateRootPath);
    const sessionsFile = await sessionStore.load();
    const session =
      input.freshSessionName !== undefined
        ? sessionStore.findByName(sessionsFile, input.freshSessionName)
        : sessionStore.findByName(sessionsFile, input.sessionName);
    if (session === undefined) {
      throw new Error(`TUI session metadata was not found for '${input.freshSessionName ?? input.sessionName}'.`);
    }
    return {
      transcript: normalizeTerminalOutput(result.stdout),
      session,
    };
  } finally {
    await stopTestOwnedLocalCore(corePaths.lockPath);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readLocalCoreFailure(socketPath: string, tokenPath: string): Promise<string | undefined> {
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    const status = await new LocalCoreClient({ socketPath, token, timeoutMs: 2000 }).status();
    return JSON.stringify({
      state: status.state,
      summary: status.summary,
      lastError: status.lastError,
    });
  } catch {
    return ;
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return ;
  }
}

async function stopTestOwnedLocalCore(lockPath: string): Promise<void> {
  let ownerPid: number | undefined;
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { ownerPid?: unknown };
    ownerPid = typeof lock.ownerPid === "number" ? lock.ownerPid : undefined;
  } catch {
    return;
  }
  if (ownerPid === undefined || ownerPid === process.pid) {
    return;
  }
  try {
    process.kill(ownerPid, "SIGTERM");
  } catch {
    return;
  }
  while (true) {
    try {
      process.kill(ownerPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function runPythonDriver(scriptPath: string, payload: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
    child.stdin.end(payload, "utf8");
  });
}

function normalizeTerminalOutput(value: string): string {
  return value
    .replaceAll(ANSI_PATTERN, "")
    .replaceAll("\u001b[?1049h", "")
    .replaceAll("\u001b[?1049l", "")
    .replaceAll("\u0007", "")
    .replace(/\r/gu, "")
    .replace(/[^\S\n]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n");
}
