import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";

import { chromium, type Browser, type Page } from "@playwright/test";

import {
  buildLaunchServicesOpenArguments,
  listExecutableProcessIds,
  parseCodeSignatureDetails,
  resolveLaunchServicesInstalledAppPath,
  runLaunchServicesCleanupActions,
} from "./desktop-launch-services-gate.js";
import { waitForAsyncValue } from "./desktop-smoke-poll.js";
import {
  createDefaultDesktopSettings,
  writeDesktopSettings,
} from "../apps/desktop/src/settingsStore.js";
import { DESKTOP_BRIDGE_VERSION } from "../src/desktopShell/contracts.js";
import { resolveLocalCorePaths } from "../src/localCore/home.js";
import {
  createDefaultLocalCoreRuntimeConfiguration,
  resolveLocalCoreRuntimeConfigurationPath,
} from "../src/localCore/runtimeConfiguration.js";
import { startFakeOpenRouterServer } from "../tests/ops/helpers/fake-open-router.js";
import { DEFAULT_OPENROUTER_MODEL } from "../models/openrouter/constants.js";

const repoRoot = resolveRepoRoot(process.cwd());
const version = readDesktopVersion(repoRoot);
const outDir = path.join(repoRoot, "apps", "desktop", "out");
const dmgPath = process.env.KESTREL_DESKTOP_LAUNCH_SERVICES_DMG_PATH?.trim()
  || path.join(outDir, `Kestrel-${version}-mac-arm64.dmg`);
const evidenceDir = path.join(outDir, "launch-services-smoke");
const evidencePath = path.join(evidenceDir, "evidence.json");
const firstLaunchScreenshotPath = path.join(evidenceDir, "first-launch.png");
const relaunchScreenshotPath = path.join(evidenceDir, "relaunch.png");
const lockPath = path.join(evidenceDir, "active.lock");
const runId = `${Date.now()}-${process.pid}`;
const installedAppPath = resolveLaunchServicesInstalledAppPath({
  version,
  runId,
});
const installedExecutablePath = path.join(
  installedAppPath,
  "Contents",
  "MacOS",
  "Kestrel",
);

assert.equal(
  process.platform,
  "darwin",
  "The signed LaunchServices gate is macOS-only.",
);
assert.equal(
  process.arch,
  "arm64",
  "The Desktop 0.7 LaunchServices gate requires an Apple-silicon Mac.",
);
assert.equal(
  process.env.KESTREL_DESKTOP_LAUNCH_SERVICES_SMOKE_APPROVED,
  "1",
  "The signed LaunchServices gate installs and launches a GUI application. "
    + "Set KESTREL_DESKTOP_LAUNCH_SERVICES_SMOKE_APPROVED=1 for one supervised run.",
);
assert.equal(
  process.env.KESTREL_DESKTOP_RELEASE,
  "1",
  "The signed LaunchServices gate requires KESTREL_DESKTOP_RELEASE=1.",
);
assert.equal(existsSync(dmgPath), true, `Signed Desktop DMG is missing: ${dmgPath}`);
assert.equal(
  existsSync(installedAppPath),
  false,
  `LaunchServices gate refuses to overwrite an existing application: ${installedAppPath}`,
);
assert.match(
  runChecked("open", ["-h"], { acceptStatus: [0, 1] }).combined,
  /--env/u,
  "This macOS release does not support isolated LaunchServices environment injection.",
);

let lockAcquired = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let smokeRoot: string | undefined;
let mountPoint: string | undefined;
let coreHome: string | undefined;
let fakeOpenRouter:
  | Awaited<ReturnType<typeof startFakeOpenRouterServer>>
  | undefined;
let dmgMounted = false;
let installedByGate = false;
let activeLaunch: LaunchHandle | undefined;
let gatePassed = false;
let pendingEvidence: Record<string, unknown> | undefined;
let executionError: Error | undefined;
let cleanupError: Error | undefined;
try {
  mkdirSync(evidenceDir, { recursive: true });
  acquireLock(lockPath);
  lockAcquired = true;
  heartbeat = setInterval(() => {
    process.stdout.write("[desktop-launch-services-smoke] still running\n");
  }, 10_000);

  smokeRoot = mkdtempSync(path.join("/tmp", "kdp-launch-services-"));
  mountPoint = path.join(smokeRoot, "dmg");
  coreHome = path.join(smokeRoot, "core-home");
  const userDataPath = path.join(smokeRoot, "user-data");
  const onboardingProjectPath = path.join(smokeRoot, "first-project");
  mkdirSync(onboardingProjectPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(onboardingProjectPath, "README.md"), "# First Kestrel project\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  mkdirSync(mountPoint, { recursive: true });
  fakeOpenRouter = await startFakeOpenRouterServer({ model: DEFAULT_OPENROUTER_MODEL });
  await seedOfflineModelConfiguration({
    coreHome,
    baseUrl: fakeOpenRouter.url,
  });

  const dmgVerification = runChecked("hdiutil", ["verify", dmgPath]);
  runChecked("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mountPoint,
    dmgPath,
  ]);
  dmgMounted = true;

  const mountedAppPath = resolveMountedAppPath(mountPoint);
  const mountedSignature = verifySignedApplication(mountedAppPath);
  runChecked("ditto", ["--rsrc", "--extattr", mountedAppPath, installedAppPath]);
  installedByGate = true;
  assert.equal(
    existsSync(installedExecutablePath),
    true,
    `Installed Desktop executable is missing: ${installedExecutablePath}`,
  );
  const installedSignature = verifySignedApplication(installedAppPath);
  assert.equal(
    installedSignature.authority,
    mountedSignature.authority,
    "Installed application signature authority changed during the DMG copy.",
  );
  assert.equal(
    installedSignature.teamIdentifier,
    mountedSignature.teamIdentifier,
    "Installed application team identifier changed during the DMG copy.",
  );

  const bundleIdentifier = readPlistValue(
    path.join(installedAppPath, "Contents", "Info.plist"),
    "CFBundleIdentifier",
  );
  const installedVersion = readPlistValue(
    path.join(installedAppPath, "Contents", "Info.plist"),
    "CFBundleShortVersionString",
  );
  assert.equal(
    bundleIdentifier,
    "com.kestrel.desktop",
    "Installed Desktop bundle identifier is incorrect.",
  );
  assert.equal(
    installedVersion,
    version,
    "Installed Desktop version does not match apps/desktop/package.json.",
  );

  const persistenceMarker = `KESTREL_LAUNCH_SERVICES_${Date.now()}`;
  activeLaunch = await launchThroughLaunchServices({
    label: "first-launch",
    installedAppPath,
    installedExecutablePath,
    userDataPath,
    coreHome,
    smokeRoot,
    fakeOpenRouterUrl: fakeOpenRouter.url,
    onboardingProjectPath,
  });
  await completeFirstRunOnboarding(activeLaunch.page);
  const firstLaunch = await verifyReadyDesktop(activeLaunch.page);
  const completedSettings = JSON.parse(readFileSync(
    path.join(resolveLocalCorePaths(coreHome).settingsPath, "local-core-settings.json"),
    "utf8",
  )) as Record<string, unknown>;
  assert.equal(
    (completedSettings.desktopOnboarding as { status?: unknown } | undefined)?.status,
    "complete",
    "LaunchServices first run must persist onboarding after execution startup.",
  );
  const firstLaunchPage = activeLaunch.page;
  const offlineModel = await verifyOfflineModel(
    firstLaunchPage,
    fakeOpenRouter.url,
  );
  await firstLaunchPage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(persistenceMarker);
  await waitForAsyncValue(
    async () => await firstLaunchPage.evaluate(async (marker) =>
      JSON.stringify(
        await (globalThis as typeof globalThis & {
          kestrelDesktop: { getUiState(): Promise<unknown> };
        }).kestrelDesktop.getUiState(),
      ).includes(String(marker)), persistenceMarker),
    (persisted) => persisted,
    {
      description: "LaunchServices conversation persistence",
      timeoutMs: 30_000,
    },
  );
  await firstLaunchPage.screenshot({
    path: firstLaunchScreenshotPath,
    fullPage: true,
  });
  const firstLaunchPid = activeLaunch.pid;
  await closeLaunch(activeLaunch);
  activeLaunch = undefined;

  activeLaunch = await launchThroughLaunchServices({
    label: "relaunch",
    installedAppPath,
    installedExecutablePath,
    userDataPath,
    coreHome,
    smokeRoot,
    fakeOpenRouterUrl: fakeOpenRouter.url,
    onboardingProjectPath,
  });
  const relaunch = await verifyReadyDesktop(activeLaunch.page);
  assert.equal(
    await activeLaunch.page.getByRole("button", { name: /Get started/u }).count(),
    0,
    "LaunchServices relaunch must skip completed onboarding.",
  );
  const composer = activeLaunch.page.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  assert.equal(
    await composer.inputValue(),
    persistenceMarker,
    "LaunchServices relaunch must restore persisted conversation draft state.",
  );
  assert.match(
    await activeLaunch.page.locator("body").innerText(),
    /Hello from the fake cross-surface model/u,
    "LaunchServices relaunch must restore the completed Local Core conversation.",
  );
  await activeLaunch.page.screenshot({
    path: relaunchScreenshotPath,
    fullPage: true,
  });
  const relaunchPid = activeLaunch.pid;
  await closeLaunch(activeLaunch);
  activeLaunch = undefined;

  pendingEvidence = {
    version: "desktop-launch-services-smoke-v1",
    capturedAt: new Date().toISOString(),
    desktopVersion: version,
    artifact: {
      dmgPath,
      hdiutilVerified: true,
      hdiutilSummary: lastNonEmptyLine(dmgVerification.combined),
      mountedAppPath,
      installedAppPath,
    },
    bundle: {
      identifier: bundleIdentifier,
      version: installedVersion,
    },
    signature: installedSignature,
    launchServices: {
      launcher: "/usr/bin/open",
      installedUnderApplications: true,
      firstLaunch: {
        pid: firstLaunchPid,
        ready: true,
        screenshotPath: firstLaunchScreenshotPath,
      },
      relaunch: {
        pid: relaunchPid,
        ready: true,
        screenshotPath: relaunchScreenshotPath,
      },
    },
    runtime: {
      bridgeVersion: firstLaunch.bridgeInfo.version,
      bootPhase: firstLaunch.bootState.phase,
      appInfo: firstLaunch.appInfo,
      relaunchAppInfo: relaunch.appInfo,
      offlineModel,
      persistence: {
        marker: persistenceMarker,
        draftRestored: true,
        conversationRestored: true,
      },
    },
  };
  gatePassed = true;
} catch (error) {
  executionError = toError(error);
  if (coreHome !== undefined) {
    printDiagnosticLog(
      path.join(resolveLocalCorePaths(coreHome).logsPath, "desktop-runtime.log"),
      "runtime",
    );
  }
  process.stderr.write(
    `[desktop-launch-services-smoke] failed isolatedState=${
      smokeRoot ?? "not-created"
    } installedApp=${installedAppPath}\n`,
  );
} finally {
  const cleanupActions: Array<() => void | Promise<void>> = [];
  if (activeLaunch !== undefined) {
    const launch = activeLaunch;
    cleanupActions.push(
      async () => await forceCloseLaunch(launch, installedAppPath),
    );
  }
  if (installedByGate) {
    cleanupActions.push(
      async () => await stopInstalledApplicationProcesses(installedAppPath),
      () => unregisterInstalledApplication(installedAppPath),
      () => rmSync(installedAppPath, { recursive: true, force: true }),
    );
  }
  if (dmgMounted && mountPoint !== undefined) {
    const mountedPath = mountPoint;
    cleanupActions.push(
      () => runChecked("hdiutil", ["detach", mountedPath]),
    );
  }
  if (fakeOpenRouter !== undefined) {
    const server = fakeOpenRouter;
    cleanupActions.push(async () => await server.close());
  }
  if (heartbeat !== undefined) {
    const activeHeartbeat = heartbeat;
    cleanupActions.push(() => clearInterval(activeHeartbeat));
  }
  if (lockAcquired) {
    cleanupActions.push(() => rmSync(lockPath, { force: true }));
  }
  if (
    smokeRoot !== undefined &&
    (
      gatePassed ||
      process.env.KESTREL_DESKTOP_LAUNCH_SERVICES_SMOKE_KEEP_STATE !== "1"
    )
  ) {
    const isolatedStatePath = smokeRoot;
    cleanupActions.push(
      () => rmSync(isolatedStatePath, { recursive: true, force: true }),
    );
  }
  try {
    await runLaunchServicesCleanupActions(cleanupActions);
  } catch (error) {
    cleanupError = toError(error);
  }
}

if (executionError !== undefined && cleanupError !== undefined) {
  throw new AggregateError(
    [
      executionError,
      ...(cleanupError instanceof AggregateError
        ? cleanupError.errors.map(toError)
        : [cleanupError]),
    ],
    "Signed LaunchServices gate execution and cleanup failed.",
  );
}
if (executionError !== undefined) {
  throw executionError;
}
if (cleanupError !== undefined) {
  throw cleanupError;
}
if (pendingEvidence === undefined) {
  throw new Error("Signed LaunchServices gate completed without evidence.");
}
if (smokeRoot === undefined) {
  throw new Error("Signed LaunchServices gate completed without isolated state.");
}
writeFileSync(
  evidencePath,
  `${JSON.stringify({
    ...pendingEvidence,
    cleanup: {
      temporaryApplicationUnregistered: true,
      temporaryApplicationRemoved: existsSync(installedAppPath) === false,
      dmgDetached: true,
      isolatedStateRemoved: existsSync(smokeRoot) === false,
    },
  }, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `[desktop-launch-services-smoke] passed: ${evidencePath}\n`,
);

interface LaunchHandle {
  browser: Browser;
  debugPort: number;
  page: Page;
  pid: number;
  openProcess: ChildProcess;
  stdoutPath: string;
  stderrPath: string;
  output: {
    stdout: string[];
    stderr: string[];
  };
}

async function launchThroughLaunchServices(input: {
  label: string;
  installedAppPath: string;
  installedExecutablePath: string;
  userDataPath: string;
  coreHome: string;
  smokeRoot: string;
  fakeOpenRouterUrl: string;
  onboardingProjectPath: string;
}): Promise<LaunchHandle> {
  const debugPort = await reserveLoopbackPort();
  assert.deepEqual(
    listExecutableProcessIds(
      readProcessList(),
      input.installedExecutablePath,
      ["--remote-debugging-port="],
    ),
    [],
    `Installed LaunchServices gate app is already running: ${input.installedExecutablePath}`,
  );
  const stdoutPath = path.join(input.smokeRoot, `${input.label}.stdout.log`);
  const stderrPath = path.join(input.smokeRoot, `${input.label}.stderr.log`);
  const args = [
    ...buildLaunchServicesOpenArguments({
      appPath: input.installedAppPath,
      userDataPath: input.userDataPath,
      debugPort,
      environment: {
        ELECTRON_ENABLE_LOGGING: "1",
        ELECTRON_ENABLE_STACK_DUMPING: "1",
        KESTREL_CORE_CREDENTIAL_STORE: "environment",
        KESTREL_DESKTOP_PACKAGE_SMOKE_APPROVED: "1",
        KESTREL_DESKTOP_PACKAGE_SMOKE_PROJECT_PATH: input.onboardingProjectPath,
        KESTREL_HOME: input.coreHome,
        OPENROUTER_API_KEY: "kestrel-launch-services-smoke-token",
      },
    }),
  ];
  const appIndex = args.indexOf("-a");
  args.splice(appIndex, 0, "-o", stdoutPath, "--stderr", stderrPath);
  const openProcess = spawn("open", args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = {
    stdout: [] as string[],
    stderr: [] as string[],
  };
  openProcess.stdout?.on("data", (chunk: Buffer | string) => {
    output.stdout.push(String(chunk));
  });
  openProcess.stderr?.on("data", (chunk: Buffer | string) => {
    output.stderr.push(String(chunk));
  });
  try {
    const endpoint = `http://127.0.0.1:${debugPort}`;
    await waitForCdp(endpoint, openProcess, output, 60_000);
    const browser = await chromium.connectOverCDP(endpoint);
    const page = await waitForRendererPage(browser, 60_000);
    const pid = await waitForMainProcess(
      input.installedExecutablePath,
      debugPort,
      openProcess,
      output,
      30_000,
    );
    return {
      browser,
      debugPort,
      page,
      pid,
      openProcess,
      stdoutPath,
      stderrPath,
      output,
    };
  } catch (error) {
    await stopInstalledApplicationProcesses(input.installedAppPath);
    throw error;
  }
}

async function verifyReadyDesktop(page: Page): Promise<{
  appInfo: { isPackaged: boolean; name: string; version: string };
  bootState: { phase: string; code?: string | undefined; message: string };
  bridgeInfo: { connected: boolean; version: string; capabilities: string[] };
  launchState: { phase: string; message: string };
}> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForURL(/\/renderer\/index\.html(?:\?.*)?$/u, {
    timeout: 60_000,
  });
  await page.locator("#root").waitFor({ state: "visible", timeout: 60_000 });
  const state = await waitForAsyncValue(
    async () => await page.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & {
        kestrelDesktop?: {
          getAppInfo(): Promise<{
            isPackaged: boolean;
            name: string;
            version: string;
          }>;
          getBootState(): Promise<{
            phase: string;
            code?: string | undefined;
            message: string;
          }>;
          getBridgeInfo(): Promise<{
            connected: boolean;
            version: string;
            capabilities: string[];
          }>;
          getLaunchState(): Promise<{ phase: string; message: string }>;
        };
      }).kestrelDesktop;
      if (bridge === undefined) {
        throw new Error("Desktop preload bridge is unavailable.");
      }
      const [appInfo, bootState, bridgeInfo, launchState] = await Promise.all([
        bridge.getAppInfo(),
        bridge.getBootState(),
        bridge.getBridgeInfo(),
        bridge.getLaunchState(),
      ]);
      return { appInfo, bootState, bridgeInfo, launchState };
    }),
    (candidate) =>
      candidate.bootState.phase === "ready" &&
      candidate.launchState.phase === "ready",
    {
      description: "LaunchServices Desktop boot and launch readiness",
      timeoutMs: 60_000,
    },
  );
  assert.equal(state.appInfo.isPackaged, true);
  assert.equal(state.appInfo.version, version);
  assert.equal(state.bootState.phase, "ready");
  assert.equal(state.launchState.phase, "ready");
  assert.equal(state.bridgeInfo.connected, true);
  assert.equal(state.bridgeInfo.version, DESKTOP_BRIDGE_VERSION);
  return state;
}

async function verifyOfflineModel(
  page: Page,
  baseUrl: string,
): Promise<{
  verified: true;
  baseUrl: string;
  response: string;
}> {
  await openConversationSurface(page);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(
    "Run the deterministic LaunchServices Desktop smoke.",
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const response = "Hello from the fake cross-surface model.";
  await page.getByText(response, { exact: true }).waitFor({ timeout: 180_000 });
  return {
    verified: true,
    baseUrl,
    response,
  };
}

async function openConversationSurface(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Find work/u }).click();
  await page
    .getByRole("dialog", { name: "Find work" })
    .getByRole("navigation", { name: "Kestrel views" })
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function closeLaunch(launch: LaunchHandle): Promise<void> {
  requestApplicationTermination(launch.pid);
  await waitForNoExecutableProcesses(
    installedExecutablePath,
    [`--remote-debugging-port=${launch.debugPort}`],
    15_000,
  );
  await launch.browser.close().catch(() => {});
  await waitForChildExit(launch.openProcess, 15_000);
  if (
    launch.openProcess.exitCode !== 0 ||
    launch.openProcess.signalCode !== null
  ) {
    throw new Error(
      `LaunchServices open process exited code=${String(
        launch.openProcess.exitCode,
      )} signal=${String(launch.openProcess.signalCode)}: ${
        [
          ...launch.output.stderr,
          readIfExists(launch.stderrPath),
        ].join("").trim()
      }`,
    );
  }
}

function requestApplicationTermination(pid: number): void {
  const script = [
    'ObjC.import("AppKit");',
    `const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});`,
    'if (!app.terminate && !app.forceTerminate) throw new Error("NSRunningApplication rejected termination");',
  ].join("\n");
  runChecked("osascript", ["-l", "JavaScript", "-e", script]);
}

async function forceCloseLaunch(
  launch: LaunchHandle,
  appPath: string,
): Promise<void> {
  await launch.browser.close().catch(() => {});
  await stopInstalledApplicationProcesses(appPath);
  if (launch.openProcess.exitCode === null) {
    launch.openProcess.kill("SIGTERM");
  }
}

async function waitForCdp(
  endpoint: string,
  openProcess: ChildProcess,
  output: { stdout: string[]; stderr: string[] },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (openProcess.exitCode !== null) {
      throw new Error(
        `LaunchServices open exited before Desktop exposed CDP: ${
          [...output.stdout, ...output.stderr].join("").trim()
        }`,
      );
    }
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // The app has not opened its loopback CDP endpoint yet.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Desktop CDP at ${endpoint}.`);
}

async function waitForRendererPage(
  browser: Browser,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => /\/renderer\/index\.html(?:\?.*)?$/u.test(
        candidate.url(),
      ));
    if (page !== undefined) {
      return page;
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the installed Desktop renderer.");
}

async function waitForMainProcess(
  executablePath: string,
  debugPort: number,
  openProcess: ChildProcess,
  output: { stdout: string[]; stderr: string[] },
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = listExecutableProcessIds(
      readProcessList(),
      executablePath,
      [`--remote-debugging-port=${debugPort}`],
    );
    if (pids.length === 1) {
      return pids[0]!;
    }
    if (pids.length > 1) {
      throw new Error(
        `LaunchServices opened multiple Desktop main processes: ${pids.join(", ")}.`,
      );
    }
    if (openProcess.exitCode !== null) {
      throw new Error(
        `LaunchServices open exited before the Desktop main process appeared: ${
          [...output.stdout, ...output.stderr].join("").trim()
        }`,
      );
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Desktop executable '${executablePath}'.`);
}

function verifySignedApplication(appPath: string): {
  authority: string;
  teamIdentifier: string;
  hardenedRuntime: true;
  codesignVerified: true;
  notarizationStapleValidated: true;
  gatekeeperAccepted: true;
} {
  runChecked("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    appPath,
  ]);
  const details = runChecked("codesign", ["-dv", "--verbose=4", appPath]);
  const signature = parseCodeSignatureDetails(details.combined);
  runChecked("xcrun", ["stapler", "validate", appPath]);
  runChecked("spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    appPath,
  ]);
  return {
    ...signature,
    codesignVerified: true,
    notarizationStapleValidated: true,
    gatekeeperAccepted: true,
  };
}

function resolveMountedAppPath(mountRoot: string): string {
  const apps = readdirSync(mountRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => path.join(mountRoot, entry.name));
  assert.deepEqual(
    apps.map((appPath) => path.basename(appPath)),
    ["Kestrel.app"],
    "Signed Desktop DMG must contain exactly Kestrel.app.",
  );
  return apps[0]!;
}

function readPlistValue(plistPath: string, key: string): string {
  const result = runChecked("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    plistPath,
  ]);
  const value = result.stdout.trim();
  assert.notEqual(value, "", `Info.plist key '${key}' is empty.`);
  return value;
}

function unregisterInstalledApplication(appPath: string): void {
  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/"
    + "LaunchServices.framework/Support/lsregister";
  if (!existsSync(lsregister)) {
    throw new Error(`LaunchServices registration tool is missing: ${lsregister}`);
  }
  runChecked(lsregister, ["-u", appPath]);
}

async function stopInstalledApplicationProcesses(appPath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pids = listInstalledApplicationProcessIds(appPath);
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
    await delay(250);
  }
  const remaining = listInstalledApplicationProcessIds(appPath);
  if (remaining.length > 0) {
    throw new Error(
      `LaunchServices gate app processes did not exit: ${remaining.join(", ")}.`,
    );
  }
}

function listInstalledApplicationProcessIds(appPath: string): number[] {
  const normalizedPath = path.resolve(appPath);
  const pids: number[] = [];
  for (const line of readProcessList().split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2]?.includes(normalizedPath) !== true) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    if (pid !== process.pid && Number.isInteger(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

async function waitForNoExecutableProcesses(
  executablePath: string,
  requiredArguments: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      listExecutableProcessIds(
        readProcessList(),
        executablePath,
        requiredArguments,
      ).length === 0
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `Installed Desktop did not quit cleanly: ${listExecutableProcessIds(
      readProcessList(),
      executablePath,
      requiredArguments,
    ).join(", ")}.`,
  );
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    delay(timeoutMs).then(() => {
      throw new Error("LaunchServices open process did not exit with Desktop.");
    }),
  ]);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = typeof address === "object" ? address.port : undefined;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  assert.equal(typeof port, "number");
  return port!;
}

async function seedOfflineModelConfiguration(input: {
  coreHome: string;
  baseUrl: string;
}): Promise<void> {
  const paths = resolveLocalCorePaths(input.coreHome);
  const policy = {
    version: 1 as const,
    provider: "openrouter" as const,
    model: DEFAULT_OPENROUTER_MODEL,
    modelByStage: {},
    modelCapabilities: { visionInputEnabled: false },
  };
  mkdirSync(paths.stateRootPath, { recursive: true, mode: 0o700 });
  mkdirSync(paths.settingsPath, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(paths.stateRootPath, "model-policy.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const runtimeConfiguration =
    createDefaultLocalCoreRuntimeConfiguration(policy);
  writeFileSync(
    resolveLocalCoreRuntimeConfigurationPath(paths.stateRootPath),
    `${JSON.stringify({
      ...runtimeConfiguration,
      providers: {
        ...runtimeConfiguration.providers,
        openrouter: { baseUrl: input.baseUrl },
      },
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeDesktopSettings(
    path.join(paths.settingsPath, "local-core-settings.json"),
    {
      ...createDefaultDesktopSettings(policy),
      selectedProvider: "openrouter",
      openrouterModel: policy.model,
      openrouterBaseUrl: input.baseUrl,
    },
  );
}

async function completeFirstRunOnboarding(
  page: Page,
): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForURL(/\/renderer\/index\.html(?:\?.*)?$/u, { timeout: 60_000 });
  await page.getByRole("button", { name: /Get started/u }).click({ timeout: 60_000 });
  await page.getByLabel("Model", { exact: true }).selectOption(DEFAULT_OPENROUTER_MODEL);
  await page.getByLabel("API key", { exact: true }).fill("kestrel-launch-services-smoke-token");
  await page.getByRole("button", { name: /Verify connection/u }).click();
  await page.getByRole("heading", { name: "Choose a project", exact: true }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await page.getByRole("button", { name: /Choose or create a folder/u }).click();
  await page.getByRole("button", { name: /Use this project/u }).click();
  await page.getByRole("heading", { name: "Your Kestrel workspace", exact: true }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await page.getByRole("button", { name: /Open Kestrel/u }).click();
}

function runChecked(
  command: string,
  args: string[],
  options: { acceptStatus?: number[] | undefined } = {},
): {
  stdout: string;
  stderr: string;
  combined: string;
} {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const accepted = options.acceptStatus ?? [0];
  if (result.status === null || accepted.includes(result.status) === false) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}): ${
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()
      }`,
    );
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
  };
}

function acquireLock(filePath: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      const descriptor = openSync(filePath, "wx");
      created = true;
      try {
        writeFileSync(
          descriptor,
          `${JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
            installedAppPath,
          })}\n`,
          "utf8",
        );
      } finally {
        closeSync(descriptor);
      }
      return;
    } catch (error) {
      if (created) {
        rmSync(filePath, { force: true });
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const ownerPid = readLockPid(filePath);
      if (ownerPid !== undefined && isPidAlive(ownerPid)) {
        throw new Error(
          `Signed LaunchServices gate is already running under PID ${ownerPid}.`,
        );
      }
      rmSync(filePath, { force: true });
    }
  }
  throw new Error("Unable to acquire the signed LaunchServices gate lock.");
}

function readLockPid(filePath: string): number | undefined {
  try {
    const lock = JSON.parse(readFileSync(filePath, "utf8")) as {
      pid?: unknown;
    };
    return typeof lock.pid === "number" &&
      Number.isInteger(lock.pid) &&
      lock.pid > 0
      ? lock.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function printDiagnosticLog(logPath: string, label: string): void {
  if (existsSync(logPath)) {
    process.stderr.write(
      `[desktop-launch-services-smoke] ${label} log:\n${readFileSync(logPath, "utf8")}\n`,
    );
  }
}

function readDesktopVersion(root: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error("apps/desktop/package.json must declare a version.");
  }
  return manifest.version;
}

function readProcessList(): string {
  return execFileSync("ps", ["-ax", "-o", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readIfExists(filePath: string): string {
  return filePath.length > 0 && existsSync(filePath)
    ? readFileSync(filePath, "utf8")
    : "";
}

function lastNonEmptyLine(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
