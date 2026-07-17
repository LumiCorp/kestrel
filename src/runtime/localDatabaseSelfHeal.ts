import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCKER_READY_CHECK_TIMEOUT_MS = 5000;
const DOCKER_READY_WAIT_TIMEOUT_MS = 45_000;
const DOCKER_READY_POLL_INTERVAL_MS = 2000;
const MACOS_DOCKER_APP_BIN = "/Applications/Docker.app/Contents/Resources/bin/docker";
const MACOS_DOCKER_APP_PATH = "/Applications/Docker.app";
const MACOS_OPEN_BIN = "/usr/bin/open";

export async function attemptLocalDatabaseSelfHeal(): Promise<{
  ok: boolean;
  detail: string;
}> {
  const composeDir = resolveComposeDirectoryForSelfHeal();
  if (composeDir === undefined) {
    return {
      ok: false,
      detail: "unable to locate docker-compose.yml for local recovery",
    };
  }

  const dockerCommand = resolveDockerCommandForSelfHeal({
    env: process.env,
    platform: process.platform,
    fileExists: existsSync,
  });
  const ready = await ensureDockerReadyForSelfHeal({
    command: dockerCommand,
    cwd: composeDir,
    platform: process.platform,
    fileExists: existsSync,
  });
  if (!ready.ok) {
    return ready;
  }
  return runCommandForSelfHeal({
    command: dockerCommand,
    args: ["compose", "up", "-d", "postgres"],
    cwd: composeDir,
    timeoutMs: 45_000,
  });
}

function resolveDockerCommandForSelfHeal(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  fileExists: (path: string) => boolean;
}): string {
  const explicit = input.env.KCHAT_DOCKER_BIN?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  if (input.platform === "win32") {
    return "docker.exe";
  }
  if (input.platform === "darwin" && input.fileExists(MACOS_DOCKER_APP_BIN)) {
    return MACOS_DOCKER_APP_BIN;
  }
  return "docker";
}

export function resolveDockerCommandForSelfHealForTests(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  fileExists: (path: string) => boolean;
}): string {
  return resolveDockerCommandForSelfHeal(input);
}

function shouldLaunchDockerDesktopForSelfHeal(input: {
  command: string;
  platform: NodeJS.Platform;
  fileExists: (path: string) => boolean;
}): boolean {
  return input.platform === "darwin"
    && input.command === MACOS_DOCKER_APP_BIN
    && input.fileExists(MACOS_DOCKER_APP_PATH)
    && input.fileExists(MACOS_OPEN_BIN);
}

export function shouldLaunchDockerDesktopForSelfHealForTests(input: {
  command: string;
  platform: NodeJS.Platform;
  fileExists: (path: string) => boolean;
}): boolean {
  return shouldLaunchDockerDesktopForSelfHeal(input);
}

function resolveComposeDirectoryForSelfHeal(): string | undefined {
  const modulePath = fileURLToPath(import.meta.url);
  let dir = path.dirname(modulePath);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(dir, "docker-compose.yml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return ;
}

async function ensureDockerReadyForSelfHeal(input: {
  command: string;
  cwd: string;
  platform: NodeJS.Platform;
  fileExists: (path: string) => boolean;
}): Promise<{
  ok: boolean;
  detail: string;
}> {
  const initial = await runCommandForSelfHeal({
    command: input.command,
    args: ["info"],
    cwd: input.cwd,
    timeoutMs: DOCKER_READY_CHECK_TIMEOUT_MS,
  });
  if (initial.ok) {
    return {
      ok: true,
      detail: "docker engine ready",
    };
  }

  if (shouldLaunchDockerDesktopForSelfHeal(input) === false) {
    return {
      ok: false,
      detail: `docker engine unavailable: ${initial.detail}`,
    };
  }

  const launch = await runCommandForSelfHeal({
    command: MACOS_OPEN_BIN,
    args: ["-a", "Docker"],
    cwd: input.cwd,
    timeoutMs: DOCKER_READY_CHECK_TIMEOUT_MS,
  });
  if (!launch.ok) {
    return {
      ok: false,
      detail: `failed to launch Docker Desktop: ${launch.detail}`,
    };
  }

  const deadline = Date.now() + DOCKER_READY_WAIT_TIMEOUT_MS;
  let lastDetail = initial.detail;
  while (Date.now() < deadline) {
    await delay(DOCKER_READY_POLL_INTERVAL_MS);
    const probe = await runCommandForSelfHeal({
      command: input.command,
      args: ["info"],
      cwd: input.cwd,
      timeoutMs: DOCKER_READY_CHECK_TIMEOUT_MS,
    });
    if (probe.ok) {
      return {
        ok: true,
        detail: "docker engine ready",
      };
    }
    lastDetail = probe.detail;
  }

  return {
    ok: false,
    detail: `Docker Desktop did not become ready within ${Math.ceil(DOCKER_READY_WAIT_TIMEOUT_MS / 1000)}s (${lastDetail})`,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runCommandForSelfHeal(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<{
  ok: boolean;
  detail: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const settle = (output: { ok: boolean; detail: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle({
        ok: false,
        detail: "timed out while starting local postgres",
      });
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`;
      if (stdout.length > 1600) {
        stdout = stdout.slice(-1600);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`;
      if (stderr.length > 1600) {
        stderr = stderr.slice(-1600);
      }
    });
    child.on("error", (error) => {
      const typedError = error as Error & { code?: unknown };
      const errorCode = typeof typedError.code === "string"
        ? String(typedError.code)
        : undefined;
      if (errorCode === "ENOENT") {
        settle({
          ok: false,
          detail:
            "docker executable not found. Install Docker Desktop or set KCHAT_DOCKER_BIN.",
        });
        return;
      }
      settle({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle({
          ok: true,
          detail: "docker compose up -d postgres",
        });
        return;
      }
      const tail = truncatePreflightDetail(`${stderr.trim()} ${stdout.trim()}`.trim());
      settle({
        ok: false,
        detail: tail.length > 0 ? `exit ${code ?? "unknown"}: ${tail}` : `exit ${code ?? "unknown"}`,
      });
    });
  });
}

function truncatePreflightDetail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 117).trimEnd()}...`;
}
