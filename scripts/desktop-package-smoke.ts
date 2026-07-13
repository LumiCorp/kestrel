import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { resolveDesktopPackagerConfig } from "../apps/desktop/src/packageConfig.js";
import { resolveLocalCorePaths } from "../src/localCore/home.js";
import { resolveLocalCorePostgresInstallation } from "../src/localCore/postgres.js";

const repoRoot = resolveRepoRoot(process.cwd());
const expectedDesktopVersion = readDesktopVersion(repoRoot);
const packagerConfig = resolveDesktopPackagerConfig({ repoRoot });
const packagedRoot = process.env.KESTREL_DESKTOP_PACKAGE_PATH?.trim()
  || path.join(
    packagerConfig.outDir,
    `${packagerConfig.appName}-${packagerConfig.platform}-${packagerConfig.arch}`,
  );
const executablePath = resolvePackagedExecutable(packagedRoot, packagerConfig.platform);
const postgresBundleRoot = resolvePackagedPostgresBundleRoot(
  packagedRoot,
  packagerConfig.platform,
);
const evidenceDir = path.join(repoRoot, "apps", "desktop", "out", "package-smoke");
const smokeLockPath = path.join(evidenceDir, "active.lock");
const screenshotPath = path.join(evidenceDir, "renderer.png");
const missionControlScreenshotPath = path.join(evidenceDir, "mission-control.png");
const projectsScreenshotPath = path.join(evidenceDir, "projects.png");
const mcpScreenshotPath = path.join(evidenceDir, "mcp.png");
const diagnosticsScreenshotPath = path.join(evidenceDir, "diagnostics.png");
const evidencePath = path.join(evidenceDir, "evidence.json");

assert.equal(
  process.env.KESTREL_DESKTOP_PACKAGE_SMOKE_APPROVED,
  "1",
  "Packaged Desktop smoke launches a GUI and requires explicit operator approval. "
    + "Set KESTREL_DESKTOP_PACKAGE_SMOKE_APPROVED=1 for one supervised launch.",
);
assert.equal(existsSync(executablePath), true, `Packaged Desktop executable is missing: ${executablePath}`);
assert.deepEqual(
  listPackagedDesktopProcessIds(packagedRoot),
  [],
  `Packaged Desktop already has running processes under '${packagedRoot}'.`,
);
mkdirSync(evidenceDir, { recursive: true });
acquireSmokeLock(smokeLockPath);

const smokeRoot = mkdtempSync(path.join(resolveSmokeTempParent(), "kdp-gui-"));
const coreHome = path.join(smokeRoot, "core-home");
const userDataPath = path.join(smokeRoot, "user-data");

let electronApp: ElectronApplication | undefined;
let electronPid: number | undefined;
let smokePassed = false;
let mainExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
const mainOutput = {
  stdout: [] as string[],
  stderr: [] as string[],
};
try {
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataPath}`],
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_ENABLE_STACK_DUMPING: "1",
      KESTREL_HOME: coreHome,
    },
    timeout: 60_000,
  });
  electronPid = electronApp.process().pid;
  electronApp.process().stdout?.on("data", (chunk: Buffer | string) => {
    mainOutput.stdout.push(String(chunk));
  });
  electronApp.process().stderr?.on("data", (chunk: Buffer | string) => {
    mainOutput.stderr.push(String(chunk));
  });
  electronApp.process().once("exit", (code, signal) => {
    mainExit = { code, signal };
  });
  const window = await electronApp.firstWindow({ timeout: 60_000 });
  await window.waitForLoadState("domcontentloaded");
  await window.locator("#root").waitFor({ state: "visible", timeout: 60_000 });
  await window.waitForFunction(
    async () => {
      const bridge = (globalThis as typeof globalThis & {
        kestrelDesktop?: { getBootState(): Promise<{ phase?: string | undefined }> };
      }).kestrelDesktop;
      const state = await bridge?.getBootState();
      return state?.phase === "ready" || state?.phase === "failed";
    },
    undefined,
    { timeout: 60_000 },
  );
  const mainProcess = await electronApp.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    name: app.getName(),
    version: app.getVersion(),
  }));
  const renderer = await window.evaluate(async () => {
    const bridge = (globalThis as typeof globalThis & {
      kestrelDesktop?: {
        getAppInfo(): Promise<{ isPackaged: boolean; name: string; version: string }>;
        getBootState(): Promise<{ phase: string; code?: string | undefined; message: string }>;
        getBridgeInfo(): Promise<{ connected: boolean; version: string; capabilities: string[] }>;
      };
    }).kestrelDesktop;
    if (bridge === undefined) {
      throw new Error("Desktop preload bridge is unavailable.");
    }
    return {
      appInfo: await bridge.getAppInfo(),
      bootState: await bridge.getBootState(),
      bridgeInfo: await bridge.getBridgeInfo(),
      bodyText: document.body.innerText,
      hasNextAsset: document.querySelector('[src*="/_next/"], [href*="/_next/"]') !== null,
      hasRoot: document.querySelector("#root") !== null,
    };
  });

  assert.equal(mainProcess.isPackaged, true, "Electron main process must report a packaged application.");
  assert.equal(renderer.appInfo.isPackaged, true, "Preload app info must report a packaged application.");
  assert.equal(renderer.appInfo.version, mainProcess.version, "Main and preload versions must agree.");
  assert.equal(renderer.appInfo.version, expectedDesktopVersion, "Packaged Desktop must report its manifest version.");
  assert.equal(renderer.bridgeInfo.connected, true, "Desktop preload bridge must be connected.");
  assert.equal(renderer.bridgeInfo.version, "3", "Packaged Desktop must expose bridge version 3.");
  assert.equal(renderer.bridgeInfo.capabilities.includes("runtime_inspection"), true);
  assert.equal(renderer.bridgeInfo.capabilities.includes("mission_control"), true);
  assert.equal(renderer.bootState.phase, "ready", renderer.bootState.code ?? renderer.bootState.message);
  assert.equal(renderer.hasRoot, true, "Packaged Desktop must mount the Vite renderer root.");
  assert.equal(renderer.hasNextAsset, false, "Packaged Desktop must not load Next.js assets.");
  assert.match(renderer.bodyText, /Kestrel/u);

  await window.screenshot({ path: screenshotPath, fullPage: true });
  const surfaces = await verifyStaticRendererSurfaces(window);
  const evidence = {
    version: "desktop-package-smoke-v1",
    capturedAt: new Date().toISOString(),
    executablePath,
    mainProcess,
    appInfo: renderer.appInfo,
    bridgeInfo: renderer.bridgeInfo,
    bootState: renderer.bootState,
    renderer: {
      hasRoot: renderer.hasRoot,
      hasNextAsset: renderer.hasNextAsset,
      screenshotPath,
      surfaces,
    },
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  smokePassed = true;
} catch (error) {
  const output = [...mainOutput.stdout, ...mainOutput.stderr].join("").trim();
  if (output.length > 0) {
    process.stderr.write(`[desktop-package-smoke] main process output:\n${output}\n`);
  }
  const corePaths = resolveLocalCorePaths(coreHome);
  printDiagnosticLog(corePaths.postgresLogPath, "postgres");
  printDiagnosticLog(path.join(corePaths.logsPath, "desktop-runtime.log"), "runtime");
  process.stderr.write(
    `[desktop-package-smoke] main exit=${JSON.stringify(mainExit ?? null)} isolatedState=${smokeRoot}\n`,
  );
  throw error;
} finally {
  try {
    await cleanupIsolatedSmoke({
      electronApp,
      electronPid,
      coreHome,
      packagedRoot,
      postgresBundleRoot,
    });
  } finally {
    rmSync(smokeLockPath, { force: true });
    if (
      smokePassed
      || process.env.KESTREL_DESKTOP_PACKAGE_SMOKE_KEEP_STATE !== "1"
    ) {
      rmSync(smokeRoot, { recursive: true, force: true });
    }
  }
}
process.stdout.write(`[desktop-package-smoke] passed: ${evidencePath}\n`);

function printDiagnosticLog(logPath: string, label: string): void {
  if (existsSync(logPath) === false) {
    return;
  }
  process.stderr.write(`[desktop-package-smoke] ${label} log:\n${readFileSync(logPath, "utf8")}\n`);
}

function resolveSmokeTempParent(): string {
  return process.platform === "darwin" ? "/tmp" : tmpdir();
}

function readDesktopVersion(root: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8"),
  ) as { version?: unknown };
  assert.equal(typeof manifest.version, "string", "Desktop package version is missing.");
  return manifest.version;
}

async function verifyStaticRendererSurfaces(window: Page): Promise<Record<string, string>> {
  await openRendererSurface(window, "Mission control", "Mission control");
  await window.getByText("No tasks in this session", { exact: true }).waitFor({ timeout: 30_000 });
  await window.getByRole("button", { name: "Runs", exact: true }).click();
  await window.getByText("No runtime runs", { exact: true }).waitFor({ timeout: 30_000 });
  await assertNoSurfaceError(window, "Mission control");
  await window.screenshot({ path: missionControlScreenshotPath, fullPage: true });

  await openRendererSurface(window, "Projects", "No project selected");
  await assertNoSurfaceError(window, "Projects");
  await window.screenshot({ path: projectsScreenshotPath, fullPage: true });

  await openRendererSurface(window, "MCP servers", "MCP servers");
  await assertNoSurfaceError(window, "MCP servers");
  await window.screenshot({ path: mcpScreenshotPath, fullPage: true });

  await openRendererSurface(window, "Diagnostics", "Diagnostics");
  await assertNoSurfaceError(window, "Diagnostics");
  await window.screenshot({ path: diagnosticsScreenshotPath, fullPage: true });

  return {
    chat: screenshotPath,
    missionControl: missionControlScreenshotPath,
    projects: projectsScreenshotPath,
    mcp: mcpScreenshotPath,
    diagnostics: diagnosticsScreenshotPath,
  };
}

async function openRendererSurface(
  window: Page,
  buttonName: string,
  headingName: string,
): Promise<void> {
  await window.getByRole("button", { name: buttonName, exact: true }).click();
  await window.getByRole("heading", { name: headingName, exact: true }).waitFor({ timeout: 30_000 });
}

async function assertNoSurfaceError(window: Page, surface: string): Promise<void> {
  assert.equal(
    await window.locator(".surface-error").count(),
    0,
    `${surface} rendered a surface error.`,
  );
}

async function closeElectronApplication(app: ElectronApplication | undefined): Promise<void> {
  if (app === undefined) {
    return;
  }
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);
}

function acquireSmokeLock(lockPath: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try {
        writeFileSync(descriptor, `${JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        })}\n`, "utf8");
      } finally {
        closeSync(descriptor);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const ownerPid = readSmokeLockPid(lockPath);
      if (ownerPid !== undefined && isPidAlive(ownerPid)) {
        throw new Error(`Packaged Desktop smoke is already running under PID ${ownerPid}.`);
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("Unable to acquire the packaged Desktop smoke lock.");
}

function readSmokeLockPid(lockPath: string): number | undefined {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof lock.pid === "number" && Number.isInteger(lock.pid) && lock.pid > 0
      ? lock.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function resolvePackagedExecutable(packagedPath: string, platform: string): string {
  if (platform === "darwin") {
    return path.join(packagedPath, "Kestrel.app", "Contents", "MacOS", "Kestrel");
  }
  if (platform === "win32") {
    return path.join(packagedPath, "Kestrel.exe");
  }
  return path.join(packagedPath, "Kestrel");
}

function resolvePackagedPostgresBundleRoot(packagedPath: string, platform: string): string {
  if (platform === "darwin") {
    return path.join(packagedPath, "Kestrel.app", "Contents", "Resources", "postgres-bundle");
  }
  return path.join(packagedPath, "resources", "postgres-bundle");
}

async function cleanupIsolatedSmoke(input: {
  electronApp: ElectronApplication | undefined;
  electronPid: number | undefined;
  coreHome: string;
  packagedRoot: string;
  postgresBundleRoot: string;
}): Promise<void> {
  const errors: Error[] = [];
  for (const cleanup of [
    () => closeElectronApplication(input.electronApp),
    () => stopIsolatedLocalCore(input.coreHome),
    () => stopIsolatedManagedPostgres(input.coreHome, input.postgresBundleRoot),
    () => input.electronPid === undefined
      ? Promise.resolve()
      : stopOwnedProcess(input.electronPid),
    () => stopPackagedDesktopProcesses(input.packagedRoot),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Packaged Desktop smoke cleanup failed.");
  }
}

async function stopPackagedDesktopProcesses(packagedPath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pids = listPackagedDesktopProcessIds(packagedPath);
    if (pids.length === 0) {
      return;
    }
    const signal: NodeJS.Signals = attempt === 0 ? "SIGTERM" : "SIGKILL";
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const remaining = listPackagedDesktopProcessIds(packagedPath);
  if (remaining.length > 0) {
    throw new Error(`Packaged Desktop processes did not exit: ${remaining.join(", ")}.`);
  }
}

function listPackagedDesktopProcessIds(packagedPath: string): number[] {
  const normalizedPath = path.resolve(packagedPath);
  const output = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2]?.includes(normalizedPath) !== true) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    if (pid !== process.pid && Number.isInteger(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return pids;
}

async function stopIsolatedLocalCore(homePath: string): Promise<void> {
  const paths = resolveLocalCorePaths(homePath);
  const lockPath = paths.lockPath;
  if (existsSync(lockPath) === false) {
    if (existsSync(paths.apiSocketPath)) {
      throw new Error(`Packaged Desktop smoke found a Local Core socket without its ownership lock: ${paths.apiSocketPath}`);
    }
    return;
  }
  let ownerPid: number | undefined;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { ownerPid?: unknown };
    ownerPid = typeof lock.ownerPid === "number" && Number.isInteger(lock.ownerPid)
      ? lock.ownerPid
      : undefined;
  } catch {
    return;
  }
  if (ownerPid === undefined || isPidAlive(ownerPid) === false) {
    return;
  }
  await stopOwnedProcess(ownerPid, 10_000);
}

async function stopIsolatedManagedPostgres(
  homePath: string,
  bundleRootPath: string,
): Promise<void> {
  const paths = resolveLocalCorePaths(homePath);
  if (existsSync(path.join(paths.postgresDataPath, "PG_VERSION")) === false) {
    return;
  }
  const postgresPid = readPostmasterPid(paths.postgresDataPath);
  try {
    const installation = await resolveLocalCorePostgresInstallation({ bundleRootPath });
    if (installation !== undefined) {
      execFileSync(installation.pgCtlPath, [
        "stop",
        "-D",
        paths.postgresDataPath,
        "-m",
        "fast",
        "-w",
      ], {
        env: {
          ...process.env,
          DYLD_LIBRARY_PATH: installation.libDir,
          PATH: `${installation.binDir}:${process.env.PATH ?? ""}`,
        },
        stdio: "ignore",
      });
    }
  } catch (error) {
    if (postgresPid === undefined) {
      throw error;
    }
  }
  if (postgresPid !== undefined) {
    await stopOwnedProcess(postgresPid);
  }
}

function readPostmasterPid(dataPath: string): number | undefined {
  const pidPath = path.join(dataPath, "postmaster.pid");
  if (existsSync(pidPath) === false) {
    return undefined;
  }
  const firstLine = readFileSync(pidPath, "utf8").split(/\r?\n/u)[0];
  const pid = Number.parseInt(firstLine ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopOwnedProcess(pid: number, gracefulTimeoutMs = 5_000): Promise<void> {
  if (isPidAlive(pid) === false) {
    return;
  }
  process.kill(pid, "SIGTERM");
  await waitForPidExit(pid, gracefulTimeoutMs);
  if (isPidAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForPidExit(pid, 5_000);
  }
  if (isPidAlive(pid)) {
    throw new Error(`Smoke-owned process ${pid} did not exit.`);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}
