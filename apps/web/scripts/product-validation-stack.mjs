import { spawn, spawnSync } from "node:child_process";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(webRoot, "../..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const host = "127.0.0.1";
const appPort = required("KESTREL_PRODUCT_APP_PORT");
const runnerPort = required("KESTREL_PRODUCT_RUNNER_PORT");
const workerReadyFile = required("KESTREL_PRODUCT_WORKER_READY_FILE");
const children = [];

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));

try {
  await rm(workerReadyFile, { force: true });
  const adminOutput = runCaptured(pnpm, ["create-dev-admin"], webRoot);
  const personalOrganizationId = adminOutput.match(
    /^Personal organization ID: (.+)$/mu,
  )?.[1]?.trim();
  if (!personalOrganizationId) {
    throw new Error("create-dev-admin did not report its personal organization ID");
  }
  run(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "scripts/seed-product-contract-gateway.ts"],
    webRoot,
    { KESTREL_SEED_ORGANIZATION_ID: personalOrganizationId },
  );

  const runner = start(pnpm, ["--dir", repositoryRoot, "run", "runner:service"], webRoot, {
    DATABASE_URL: required("KESTREL_PRODUCT_RUNNER_DATABASE_URL"),
  });
  await waitForUrl(`http://${host}:${runnerPort}/health`, runner, "Runner");

  const worker = start(pnpm, ["worker:turns"], webRoot);
  await waitForFile(workerReadyFile, worker, "Turn worker");

  const web = start(pnpm, ["exec", "next", "start", "--hostname", host, "--port", appPort], webRoot);
  const first = await Promise.race(children.map(waitForExit));
  throw new Error(`${first.label} exited before Playwright cleanup (${first.code ?? first.signal ?? "unknown"})`);
} finally {
  cleanup();
}

function start(command, args, cwd, extraEnvironment = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  child.validationLabel = `${command} ${args.join(" ")}`;
  children.push(child);
  return child;
}

function run(command, args, cwd, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? 1}`);
}

function runCaptured(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? 1}`);
  return result.stdout ?? "";
}

async function waitForUrl(url, child, label) {
  while (true) {
    assertRunning(child, label);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
}

async function waitForFile(file, child, label) {
  while (true) {
    assertRunning(child, label);
    try { await access(file); return; } catch {}
    await delay(250);
  }
}

function assertRunning(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before readiness`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, label: child.validationLabel }));
  });
}

function cleanup() {
  for (const child of children) terminate(child);
  void rm(workerReadyFile, { force: true });
}

function shutdown(code) {
  cleanup();
  process.exit(code);
}

function terminate(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    else process.kill(-child.pid, "SIGTERM");
  } catch {}
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
