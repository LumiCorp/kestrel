/**
 * Local bootstrap helper that performs:
 * 1. Docker infra startup (Postgres + Redis)
 * 2. Dev admin seeding
 * 3. State/config tracking
 * 4. Port readiness checks + Next dev server launch
 * 5. Browser launch
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { config } from "dotenv";

config({
  path: ".env.local",
});

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, ".bootstrap");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:43103";
const APP_PORT = Number(new URL(APP_URL).port || 43103);
type BootstrapState = {
  infra: { lastUp: string } | null;
  devAdmin:
    | { email: string; lastRun: string; organization: string }
    | null;
  server:
    | { lastStart: string; url: string; authMode: "auto-login" }
    | null;
};

const STATE_DEFAULT: BootstrapState = {
  infra: null,
  devAdmin: null,
  server: null,
};

async function readState(): Promise<BootstrapState> {
  try {
    const text = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(text);
  } catch {
    return STATE_DEFAULT;
  }
}

async function writeState(state: BootstrapState) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(message: string) {
  console.log(`[bootstrap] ${message}`);
}

function runCommand(label: string, command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    log(`${label}: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${label} failed with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function waitForPort(port: number, attempts = 15, intervalMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    if (await isPortListening(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function isPortListening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function checkHealth(url: string, attempts = 20, intervalMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // fallthrough
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function getServerMode(url: string) {
  try {
    const response = await fetch(`${url}/api/health`);
    if (!response.ok) {
      return null;
    }
    return "healthy";
  } catch {
    return null;
  }
}

function openBrowser(url: string) {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "start"
      : "xdg-open";
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
    log(`Opened browser at ${url}`);
  } catch (error) {
    log(`Failed to open browser: ${error}`);
  }
}

async function ensureInfra() {
  try {
    await runCommand("Docker compose up", "docker", [
      "compose",
      "up",
      "-d",
      "--quiet-pull",
      "postgres",
      "redis",
    ]);
  } catch (error) {
    log(
      "Docker compose failed (is Docker installed?). Skipping infra startup for now."
    );
  }
}

async function ensurePorts() {
  let allReady = true;
  const ports = [
    { port: 5432, name: "Postgres" },
    { port: 6379, name: "Redis" },
  ];
  for (const candidate of ports) {
    const ready = await waitForPort(candidate.port);
    allReady &&= ready;
    log(
      `${candidate.name} (${candidate.port}) ${ready ? "is ready" : "not reachable"}`
    );
  }
  return allReady;
}

async function ensureDevAdmin() {
  await runCommand("create-dev-admin", "pnpm", ["create-dev-admin"]);
}

async function launchDevServer(state: BootstrapState) {
  const existingServer = await getServerMode(APP_URL);
  if (existingServer) {
    log(`App already responding at ${APP_URL}; reusing existing server.`);
    state.server = {
      lastStart: new Date().toISOString(),
      url: APP_URL,
      authMode: "auto-login",
    };
    await writeState(state);
    openBrowser(`${APP_URL}/dashboard`);
    return;
  }

  const appPortReady = await isPortListening(APP_PORT);
  if (appPortReady) {
    throw new Error(
      `Port ${APP_PORT} is already in use by a different process; refusing to start dev server.`
    );
  }

  const devEnv = {
    ...process.env,
    DEV_AUTH_BYPASS: "true",
    DEV_ADMIN_EMAIL: process.env.DEV_ADMIN_EMAIL,
    DEV_ADMIN_PASSWORD: process.env.DEV_ADMIN_PASSWORD,
    DEV_ORG_NAME: process.env.DEV_ORG_NAME,
  };
  const devProcess = spawn("pnpm", ["dev"], {
    stdio: "inherit",
    env: devEnv,
  });

  process.on("SIGINT", () => devProcess.kill("SIGINT"));
  process.on("SIGTERM", () => devProcess.kill("SIGTERM"));

  const healthOK = await checkHealth(APP_URL);
  if (healthOK) {
    openBrowser(`${APP_URL}/dashboard`);
    state.server = {
      lastStart: new Date().toISOString(),
      url: APP_URL,
      authMode: "auto-login",
    };
    await writeState(state);
  } else {
    log("Next dev server failed to report healthy status.");
  }

  devProcess.on("exit", (code) => {
    log(`pnpm dev exited with ${code}`);
    process.exit(code ?? 0);
  });
}

async function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    await fs.mkdir(STATE_DIR, { recursive: true });
  }
}

async function main() {
  await ensureStateDir();
  const state = await readState();

  await ensureInfra();
  const infraReady = await ensurePorts();
  await ensureDevAdmin();

  state.infra = infraReady ? { lastUp: new Date().toISOString() } : null;
  state.devAdmin = {
    email: process.env.DEV_ADMIN_EMAIL || "admin@dev.local",
    lastRun: new Date().toISOString(),
    organization: process.env.DEV_ORG_NAME || "Dev-org",
  };
  await writeState(state);

  await launchDevServer(state);
}

main().catch((error) => {
  console.error("bootstrap failed:", error);
  process.exit(1);
});
