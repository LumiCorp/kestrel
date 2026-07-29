import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { parse } from "yaml";

import {
  DESKTOP_OTA_FIXTURE_UPDATE_URL,
  DESKTOP_OTA_FIXTURE_VERSIONS,
  resolveDesktopUpdateUrl,
} from "../apps/desktop/src/builderConfig.js";
import type {
  DesktopManagedProjectRun,
  DesktopUpdateBlocker,
  DesktopUpdateState,
} from "../apps/desktop/src/contracts.js";
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
import {
  buildLaunchServicesOpenArguments,
  listExecutableProcessIds,
  parseCodeSignatureDetails,
} from "./desktop-launch-services-gate.js";
import {
  assertDesktopOtaBusyBlocker,
  assertDesktopOtaUpdateState,
  resolveDesktopOtaInstalledAppPath,
  runDesktopOtaCleanupActions,
  sanitizeDesktopUpdaterLog,
  shapeDesktopOtaEvidence,
  type DesktopOtaCleanupAction,
  type DesktopOtaCleanupResult,
} from "./desktop-ota-gate.js";
import {
  loadDesktopOtaReleaseCatalog,
  startDesktopOtaHttpsServer,
  summarizeDesktopOtaTransfer,
  type DesktopOtaHttpsServer,
} from "./desktop-ota-https-server.js";
import { assertDesktopOtaFixturePortAvailable } from "./desktop-ota-fixture.js";

const repoRoot = resolveRepoRoot(process.cwd());
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const outDir = path.join(desktopRoot, "out");
const fixturesRoot = path.join(outDir, "ota-fixtures");
const evidenceDir = path.join(outDir, "ota-smoke");
const evidencePath = path.join(evidenceDir, "evidence.json");
const finalVersion = readDesktopVersion();
const runId = `${Date.now()}-${process.pid}`;
const installedAppPath = resolveDesktopOtaInstalledAppPath({ runId });
const installedExecutablePath = path.join(
  installedAppPath,
  "Contents",
  "MacOS",
  "Kestrel",
);
const lockPath = path.join(evidenceDir, "active.lock");
const releases = [
  ...DESKTOP_OTA_FIXTURE_VERSIONS.map((version) => ({
    version,
    outDir: path.join(fixturesRoot, version),
  })),
  { version: finalVersion, outDir },
] as const;

assert.equal(process.platform, "darwin", "The Desktop OTA gate is macOS-only.");
assert.equal(
  process.arch,
  "arm64",
  "The Desktop OTA gate requires an Apple-silicon Mac.",
);
assert.equal(
  process.env.KESTREL_DESKTOP_OTA_SMOKE_APPROVED,
  "1",
  "Set KESTREL_DESKTOP_OTA_SMOKE_APPROVED=1 for one supervised OTA run.",
);
assert.equal(
  process.env.KESTREL_DESKTOP_RELEASE,
  "1",
  "The Desktop OTA gate requires KESTREL_DESKTOP_RELEASE=1.",
);
assert.equal(finalVersion, "0.7.0", "The final Desktop OTA target must be 0.7.0.");
assert.equal(
  existsSync(installedAppPath),
  false,
  `Desktop OTA gate refuses to overwrite ${installedAppPath}.`,
);
assert.match(
  runChecked("open", ["-h"], { acceptStatus: [0, 1] }).combined,
  /--env/u,
  "This macOS release does not support isolated LaunchServices environment injection.",
);
await assertDesktopOtaFixturePortAvailable();

const catalog = await loadDesktopOtaReleaseCatalog(releases);
const artifactEvidence = releases.map(({ version, outDir: releaseOutDir }) => {
  const appPath = path.join(releaseOutDir, "mac-arm64", "Kestrel.app");
  const dmgPath = path.join(
    releaseOutDir,
    `Kestrel-${version}-mac-arm64.dmg`,
  );
  assert.equal(existsSync(appPath), true, `Desktop app is missing: ${appPath}`);
  assert.equal(existsSync(dmgPath), true, `Desktop DMG is missing: ${dmgPath}`);
  const signature = verifySignedApplication(appPath);
  const dmgVerification = runChecked("hdiutil", ["verify", dmgPath]);
  return {
    version,
    appPath,
    dmgPath,
    signature,
    hdiutilVerified: true,
    hdiutilSummary: lastNonEmptyLine(dmgVerification.combined),
    artifacts: [...catalog.releases.get(version)!.artifacts.entries()].map(
      ([name, artifact]) => ({
        name,
        size: artifact.size,
        sha256: artifact.sha256,
      }),
    ),
  };
});
verifyEmbeddedUpdateUrl(
  path.join(outDir, "mac-arm64", "Kestrel.app"),
  resolveDesktopUpdateUrl("stable"),
);
for (const version of DESKTOP_OTA_FIXTURE_VERSIONS) {
  verifyEmbeddedUpdateUrl(
    path.join(fixturesRoot, version, "mac-arm64", "Kestrel.app"),
    DESKTOP_OTA_FIXTURE_UPDATE_URL,
  );
}

let smokeRoot: string | undefined;
let certificateRoot: string | undefined;
let mountPoint: string | undefined;
let coreHome: string | undefined;
let activeLaunch: LaunchHandle | undefined;
let fakeOpenRouter:
  | Awaited<ReturnType<typeof startFakeOpenRouterServer>>
  | undefined;
let otaServer: DesktopOtaHttpsServer | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let activeProjectRun: DesktopManagedProjectRun | undefined;
let lockAcquired = false;
let dmgMounted = false;
let installedByGate = false;
let gatePassed = false;
let executionError: Error | undefined;
let cleanupError: Error | undefined;
let cleanupResult: DesktopOtaCleanupResult | undefined;
let pendingEvidence:
  | Omit<Parameters<typeof shapeDesktopOtaEvidence>[0], "cleanup">
  | undefined;

try {
  mkdirSync(evidenceDir, { recursive: true });
  acquireLock(lockPath);
  lockAcquired = true;
  heartbeat = setInterval(() => {
    process.stdout.write("[desktop-ota-smoke] still running\n");
  }, 10_000);
  smokeRoot = mkdtempSync(path.join(tmpdir(), "kestrel-desktop-ota-"));
  certificateRoot = mkdtempSync(path.join(tmpdir(), "kestrel-desktop-ota-tls-"));
  mountPoint = path.join(smokeRoot, "dmg");
  coreHome = path.join(smokeRoot, "core-home");
  const userDataPath = path.join(smokeRoot, "user-data");
  const isolatedHome = path.join(smokeRoot, "home");
  const projectPath = path.join(smokeRoot, "busy-project");
  mkdirSync(mountPoint, { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(
    path.join(projectPath, "package.json"),
    `${JSON.stringify(
      {
        name: "kestrel-desktop-ota-busy-gate",
        private: true,
        scripts: {
          hold: "node -e \"setInterval(() => {}, 1000)\"",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fakeOpenRouter = await startFakeOpenRouterServer();
  await seedOfflineConfiguration({
    coreHome,
    baseUrl: fakeOpenRouter.url,
    projectPath,
  });
  const certificate = generateLocalhostCertificate(certificateRoot);
  otaServer = await startDesktopOtaHttpsServer({
    certificatePath: certificate.certificatePath,
    privateKeyPath: certificate.privateKeyPath,
    catalog,
  });

  const initialVersion = DESKTOP_OTA_FIXTURE_VERSIONS[0];
  const initialDmgPath = path.join(
    fixturesRoot,
    initialVersion,
    `Kestrel-${initialVersion}-mac-arm64.dmg`,
  );
  runChecked("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mountPoint,
    initialDmgPath,
  ]);
  dmgMounted = true;
  const mountedAppPath = resolveMountedAppPath(mountPoint);
  verifySignedApplication(mountedAppPath);
  runChecked("ditto", ["--rsrc", "--extattr", mountedAppPath, installedAppPath]);
  installedByGate = true;
  runChecked("hdiutil", ["detach", mountPoint]);
  dmgMounted = false;
  verifyInstalledVersion(initialVersion);
  verifySignedApplication(installedAppPath);

  const transitions: DesktopUpdateState[] = [];
  const transfers: Array<Record<string, unknown>> = [];
  const screenshots: Array<{ version: string; path: string }> = [];
  const persistenceMarker = `KESTREL_OTA_${Date.now()}`;
  activeLaunch = await launchInstalledApplication({
    installedAppPath,
    installedExecutablePath,
    userDataPath,
    coreHome,
    isolatedHome,
    smokeRoot,
    certificateSpki: certificate.spki,
    certificatePath: certificate.certificatePath,
    label: initialVersion,
  });
  await verifyReadyDesktop(activeLaunch.page, initialVersion);
  await seedPersistenceMarker(activeLaunch.page, persistenceMarker);
  screenshots.push(
    await captureVersionScreenshot(activeLaunch.page, initialVersion),
  );

  const firstTarget = DESKTOP_OTA_FIXTURE_VERSIONS[1];
  otaServer.setPhase("initial-full");
  otaServer.offer(firstTarget);
  activeLaunch = await runUpdateHop({
    launch: activeLaunch,
    currentVersion: initialVersion,
    targetVersion: firstTarget,
    transitions,
  });
  await assertPersistence(activeLaunch.page, persistenceMarker);
  screenshots.push(
    await captureVersionScreenshot(activeLaunch.page, firstTarget),
  );
  const firstTransfer = summarizeTransfer(
    otaServer,
    "initial-full",
    firstTarget,
  );
  assert.equal(firstTransfer.fullBytes > 0, true);
  assert.equal(firstTransfer.rangeRequests, 0);
  transfers.push({ phase: "initial-full", ...firstTransfer });

  const fallbackTarget = DESKTOP_OTA_FIXTURE_VERSIONS[2];
  otaServer.setPhase("blockmap-fallback");
  otaServer.offer(fallbackTarget, { faultBlockmap: true });
  activeLaunch = await runUpdateHop({
    launch: activeLaunch,
    currentVersion: firstTarget,
    targetVersion: fallbackTarget,
    transitions,
  });
  await assertPersistence(activeLaunch.page, persistenceMarker);
  screenshots.push(
    await captureVersionScreenshot(activeLaunch.page, fallbackTarget),
  );
  const fallbackTransfer = summarizeTransfer(
    otaServer,
    "blockmap-fallback",
    fallbackTarget,
  );
  assert.equal(fallbackTransfer.faultResponses > 0, true);
  assert.equal(fallbackTransfer.fullBytes > 0, true);
  transfers.push({ phase: "blockmap-fallback", ...fallbackTransfer });

  otaServer.setPhase("final-differential");
  otaServer.offer(finalVersion);
  const finalLogCheckpoint = captureUpdaterLogCheckpoint(smokeRoot, coreHome);
  const available = await activeLaunch.page.evaluate(async () =>
    await requireDesktopBridge().checkForUpdates()
  ) as DesktopUpdateState;
  transitions.push(available);
  assertDesktopOtaUpdateState(available, {
    phase: "available",
    currentVersion: fallbackTarget,
    targetVersion: finalVersion,
  });
  const downloaded = await activeLaunch.page.evaluate(async () =>
    await requireDesktopBridge().downloadUpdate()
  ) as DesktopUpdateState;
  transitions.push(downloaded);
  assertDesktopOtaUpdateState(downloaded, {
    phase: "downloaded",
    currentVersion: fallbackTarget,
    targetVersion: finalVersion,
  });
  const differentialTransfer = summarizeTransfer(
    otaServer,
    "final-differential",
    finalVersion,
  );
  assert.equal(
    differentialTransfer.differential,
    true,
    `Final OTA was not differential: ${JSON.stringify(differentialTransfer)}`,
  );
  const finalUpdaterLog = readUpdaterLogSince(finalLogCheckpoint);
  const sanitizedFinalUpdaterLog = sanitizeDesktopUpdaterLog(finalUpdaterLog);
  assert.match(
    sanitizedFinalUpdaterLog.join("\n"),
    /Full:.*To download:|differential/u,
    "Final Desktop OTA logs must show a differential download plan.",
  );
  assert.doesNotMatch(
    sanitizedFinalUpdaterLog.join("\n"),
    /Cannot download differentially/u,
    "Final Desktop OTA logs must not show a full-download fallback.",
  );
  transfers.push({
    phase: "final-differential",
    ...differentialTransfer,
    updaterLog: sanitizedFinalUpdaterLog,
  });

  activeProjectRun = await activeLaunch.page.evaluate(
    async (input) =>
      await requireDesktopBridge().startProjectRun({
        projectPath: input.projectPath,
        scriptName: "hold",
        packageManagerOverride: "npm",
      }),
    { projectPath },
  ) as DesktopManagedProjectRun;
  assert.equal(activeProjectRun.status, "running");
  const blocked = await activeLaunch.page.evaluate(async () =>
    await requireDesktopBridge().installUpdate()
  ) as DesktopUpdateState;
  transitions.push(blocked);
  const listedAfterBlock = await activeLaunch.page.evaluate(async () =>
    await requireDesktopBridge().listProjectRuns()
  ) as DesktopManagedProjectRun[];
  const runAfterBlock = listedAfterBlock.find(
    (run) => run.runId === activeProjectRun!.runId,
  );
  const blocker = assertDesktopOtaBusyBlocker({
    state: blocked,
    runStillActive: runAfterBlock?.status === "running",
  });
  activeProjectRun = await activeLaunch.page.evaluate(
    async (runId) => await requireDesktopBridge().stopProjectRun(runId),
    activeProjectRun.runId,
  ) as DesktopManagedProjectRun;
  await waitForProjectRunStopped(activeLaunch.page, activeProjectRun.runId);
  activeProjectRun = undefined;

  activeLaunch = await installDownloadedUpdate({
    launch: activeLaunch,
    currentVersion: fallbackTarget,
    targetVersion: finalVersion,
    transitions,
  });
  await assertPersistence(activeLaunch.page, persistenceMarker);
  screenshots.push(
    await captureVersionScreenshot(activeLaunch.page, finalVersion),
  );
  const finalSignature = verifySignedApplication(installedAppPath);
  const finalFeedUrl = readEmbeddedUpdateUrl(installedAppPath);
  assert.equal(finalFeedUrl, resolveDesktopUpdateUrl("stable"));

  await closeLaunch(activeLaunch);
  activeLaunch = undefined;
  const updaterLog = collectUpdaterLogs(smokeRoot, coreHome);
  pendingEvidence = {
    sourceCommit: runChecked("git", ["rev-parse", "HEAD"]).stdout.trim(),
    artifactEvidence: [
      ...artifactEvidence,
      {
        version: finalVersion,
        installedAppPath,
        installedSignature: finalSignature,
      },
    ],
    transitions,
    requestLedger: otaServer.ledger,
    transfers,
    updaterLog,
    screenshots,
    blocker,
    persistenceMarker,
    finalFeedUrl,
  };
  gatePassed = true;
} catch (error) {
  executionError = toError(error);
  if (smokeRoot !== undefined && coreHome !== undefined) {
    printDiagnosticLog(
      path.join(resolveLocalCorePaths(coreHome).logsPath, "desktop-runtime.log"),
      "runtime",
    );
    for (const name of readdirSync(smokeRoot)) {
      if (name.endsWith(".stderr.log") || name.endsWith(".stdout.log")) {
        printDiagnosticLog(path.join(smokeRoot, name), name);
      }
    }
  }
  process.stderr.write(
    `[desktop-ota-smoke] failed isolatedState=${smokeRoot ?? "not-created"} installedApp=${installedAppPath}\n`,
  );
} finally {
  const cleanupActions: DesktopOtaCleanupAction[] = [];
  if (activeProjectRun !== undefined && activeLaunch !== undefined) {
    const runId = activeProjectRun.runId;
    const page = activeLaunch.page;
    cleanupActions.push({
      label: "managed-project-run",
      async run() {
        await page.evaluate(
          async (id) => await requireDesktopBridge().stopProjectRun(id),
          runId,
        );
      },
    });
  }
  if (activeLaunch !== undefined) {
    const launch = activeLaunch;
    cleanupActions.push({
      label: "desktop-launch",
      async run() {
        await forceCloseLaunch(launch, installedAppPath);
      },
    });
  }
  if (installedByGate) {
    cleanupActions.push(
      {
        label: "desktop-processes",
        async run() {
          await stopInstalledApplicationProcesses(installedAppPath);
        },
      },
      {
        label: "launch-services-registration",
        run() {
          unregisterInstalledApplication(installedAppPath);
        },
      },
      {
        label: "temporary-application",
        run() {
          rmSync(installedAppPath, { recursive: true, force: true });
        },
      },
    );
  }
  if (dmgMounted && mountPoint !== undefined) {
    const activeMountPoint = mountPoint;
    cleanupActions.push({
      label: "mounted-dmg",
      run() {
        runChecked("hdiutil", ["detach", activeMountPoint]);
      },
    });
  }
  if (otaServer !== undefined) {
    const server = otaServer;
    cleanupActions.push({
      label: "https-server",
      async run() {
        await server.close();
      },
    });
  }
  if (fakeOpenRouter !== undefined) {
    const server = fakeOpenRouter;
    cleanupActions.push({
      label: "offline-model-server",
      async run() {
        await server.close();
      },
    });
  }
  if (heartbeat !== undefined) {
    const activeHeartbeat = heartbeat;
    cleanupActions.push({
      label: "heartbeat",
      run() {
        clearInterval(activeHeartbeat);
      },
    });
  }
  if (lockAcquired) {
    cleanupActions.push({
      label: "lock",
      run() {
        rmSync(lockPath, { force: true });
      },
    });
  }
  if (certificateRoot !== undefined) {
    const tlsRoot = certificateRoot;
    cleanupActions.push({
      label: "ephemeral-certificate",
      run() {
        rmSync(tlsRoot, { recursive: true, force: true });
      },
    });
  }
  if (
    smokeRoot !== undefined &&
    process.env.KESTREL_DESKTOP_OTA_SMOKE_KEEP_STATE !== "1"
  ) {
    const isolatedState = smokeRoot;
    cleanupActions.push({
      label: "isolated-state",
      run() {
        rmSync(isolatedState, { recursive: true, force: true });
      },
    });
  }
  try {
    cleanupResult = await runDesktopOtaCleanupActions(cleanupActions);
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
    "Desktop OTA gate execution and cleanup failed.",
  );
}
if (executionError !== undefined) throw executionError;
if (cleanupError !== undefined) throw cleanupError;
if (!gatePassed || pendingEvidence === undefined || cleanupResult === undefined) {
  throw new Error("Desktop OTA gate completed without accepted evidence.");
}
assert.equal(existsSync(installedAppPath), false);
if (certificateRoot !== undefined) {
  assert.equal(existsSync(certificateRoot), false);
}
if (
  smokeRoot !== undefined &&
  process.env.KESTREL_DESKTOP_OTA_SMOKE_KEEP_STATE !== "1"
) {
  assert.equal(existsSync(smokeRoot), false);
}
await assertDesktopOtaFixturePortAvailable();
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    shapeDesktopOtaEvidence({
      ...pendingEvidence,
      cleanup: cleanupResult,
    }),
    null,
    2,
  )}\n`,
  "utf8",
);
process.stdout.write(`[desktop-ota-smoke] passed: ${evidencePath}\n`);

interface LaunchHandle {
  browser: Browser;
  page: Page;
  pid: number;
  debugPort: number;
  openProcess: ChildProcess;
  stdoutPath: string;
  stderrPath: string;
}

async function runUpdateHop(input: {
  launch: LaunchHandle;
  currentVersion: string;
  targetVersion: string;
  transitions: DesktopUpdateState[];
}): Promise<LaunchHandle> {
  const available = await input.launch.page.evaluate(async () =>
    await requireDesktopBridge().checkForUpdates()
  ) as DesktopUpdateState;
  input.transitions.push(available);
  assertDesktopOtaUpdateState(available, {
    phase: "available",
    currentVersion: input.currentVersion,
    targetVersion: input.targetVersion,
  });
  const downloaded = await input.launch.page.evaluate(async () =>
    await requireDesktopBridge().downloadUpdate()
  ) as DesktopUpdateState;
  input.transitions.push(downloaded);
  assertDesktopOtaUpdateState(downloaded, {
    phase: "downloaded",
    currentVersion: input.currentVersion,
    targetVersion: input.targetVersion,
  });
  return await installDownloadedUpdate({
    ...input,
  });
}

async function installDownloadedUpdate(input: {
  launch: LaunchHandle;
  currentVersion: string;
  targetVersion: string;
  transitions: DesktopUpdateState[];
}): Promise<LaunchHandle> {
  try {
    const installing = await input.launch.page.evaluate(async () =>
      await requireDesktopBridge().installUpdate()
    ) as DesktopUpdateState;
    input.transitions.push(installing);
    assertDesktopOtaUpdateState(installing, {
      phase: "installing",
      currentVersion: input.currentVersion,
      targetVersion: input.targetVersion,
    });
  } catch (error) {
    if (!/closed|destroyed|Target page/u.test(toError(error).message)) {
      throw error;
    }
  }
  return await reconnectAfterUpdate(input.launch, input.targetVersion);
}

async function launchInstalledApplication(input: {
  installedAppPath: string;
  installedExecutablePath: string;
  userDataPath: string;
  coreHome: string;
  isolatedHome: string;
  smokeRoot: string;
  certificateSpki: string;
  certificatePath: string;
  label: string;
}): Promise<LaunchHandle> {
  assert.deepEqual(listInstalledApplicationProcessIds(input.installedAppPath), []);
  const debugPort = await reserveLoopbackPort();
  const stdoutPath = path.join(input.smokeRoot, `${input.label}.stdout.log`);
  const stderrPath = path.join(input.smokeRoot, `${input.label}.stderr.log`);
  const args = buildLaunchServicesOpenArguments({
    appPath: input.installedAppPath,
    userDataPath: input.userDataPath,
    debugPort,
    environment: {
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_ENABLE_STACK_DUMPING: "1",
      HOME: input.isolatedHome,
      KESTREL_CORE_CREDENTIAL_STORE: "environment",
      KESTREL_DESKTOP_PACKAGE_SMOKE_APPROVED: "1",
      KESTREL_HOME: input.coreHome,
      NODE_EXTRA_CA_CERTS: input.certificatePath,
      OPENROUTER_API_KEY: "kestrel-ota-smoke-token",
    },
    applicationArguments: [
      `--ignore-certificate-errors-spki-list=${input.certificateSpki}`,
    ],
  });
  const appIndex = args.indexOf("-a");
  args.splice(appIndex, 0, "-o", stdoutPath, "--stderr", stderrPath);
  const openProcess = spawn("open", args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const endpoint = `http://127.0.0.1:${debugPort}`;
    await waitForCdp(endpoint, 60_000);
    const browser = await chromium.connectOverCDP(endpoint);
    const page = await waitForRendererPage(browser, 60_000);
    const pid = await waitForMainProcess(
      input.installedExecutablePath,
      [`--remote-debugging-port=${debugPort}`],
      30_000,
    );
    return {
      browser,
      page,
      pid,
      debugPort,
      openProcess,
      stdoutPath,
      stderrPath,
    };
  } catch (error) {
    await stopInstalledApplicationProcesses(input.installedAppPath);
    throw error;
  }
}

async function reconnectAfterUpdate(
  previous: LaunchHandle,
  expectedVersion: string,
): Promise<LaunchHandle> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      verifyInstalledVersion(expectedVersion);
      const nextPid = listExecutableProcessIds(
        readProcessList(),
        installedExecutablePath,
        [`--remote-debugging-port=${previous.debugPort}`],
      ).find((pid) => pid !== previous.pid);
      if (nextPid === undefined) {
        await delay(250);
        continue;
      }
      const endpoint = `http://127.0.0.1:${previous.debugPort}`;
      await waitForCdp(endpoint, 30_000);
      const browser = await chromium.connectOverCDP(endpoint);
      const page = await waitForRendererPage(browser, 30_000);
      await verifyReadyDesktop(page, expectedVersion);
      return {
        ...previous,
        browser,
        page,
        pid: nextPid,
      };
    } catch {
      await delay(250);
    }
  }
  throw new Error(
    `Timed out waiting for Desktop OTA relaunch into ${expectedVersion}.`,
  );
}

async function verifyReadyDesktop(
  page: Page,
  expectedVersion: string,
): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForURL(/\/renderer\/index\.html(?:\?.*)?$/u, {
    timeout: 60_000,
  });
  await page.locator("#root").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator(".composer").waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(
    async () =>
      (await requireDesktopBridge().getBootState() as { phase?: string })
        .phase === "ready",
    undefined,
    { timeout: 60_000 },
  );
  const state = await page.evaluate(async () => {
    const bridge = requireDesktopBridge();
    return {
      appInfo: await bridge.getAppInfo(),
      bootState: await bridge.getBootState(),
      bridgeInfo: await bridge.getBridgeInfo(),
    };
  }) as {
    appInfo: { isPackaged: boolean; version: string };
    bootState: { phase: string };
    bridgeInfo: { connected: boolean; version: string };
  };
  assert.equal(state.appInfo.isPackaged, true);
  assert.equal(state.appInfo.version, expectedVersion);
  assert.equal(state.bootState.phase, "ready");
  assert.equal(state.bridgeInfo.connected, true);
  assert.equal(state.bridgeInfo.version, DESKTOP_BRIDGE_VERSION);
}

async function seedPersistenceMarker(
  page: Page,
  marker: string,
): Promise<void> {
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(marker);
  await page.waitForFunction(
    async (expected) =>
      JSON.stringify(await requireDesktopBridge().getUiState()).includes(
        String(expected),
      ),
    marker,
    { timeout: 30_000 },
  );
}

async function assertPersistence(page: Page, marker: string): Promise<void> {
  const composer = page.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  assert.equal(await composer.inputValue(), marker);
}

async function captureVersionScreenshot(
  page: Page,
  version: string,
): Promise<{ version: string; path: string }> {
  const screenshotPath = path.join(
    evidenceDir,
    `${version.replace(/[^A-Za-z0-9.-]/gu, "-")}.png`,
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return { version, path: screenshotPath };
}

function summarizeTransfer(
  server: DesktopOtaHttpsServer,
  phase: string,
  version: string,
) {
  const release = catalog.releases.get(version)!;
  const zipName = [...release.artifacts.keys()].find((name) =>
    name.endsWith(".zip")
  );
  assert.notEqual(zipName, undefined);
  const zip = release.artifacts.get(zipName!)!;
  return summarizeDesktopOtaTransfer({
    ledger: server.ledger,
    phase,
    targetZipName: zipName!,
    targetZipSize: zip.size,
  });
}

async function waitForProjectRunStopped(
  page: Page,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const runs = await page.evaluate(async () =>
      await requireDesktopBridge().listProjectRuns()
    ) as DesktopManagedProjectRun[];
    const run = runs.find((candidate) => candidate.runId === runId);
    if (
      run === undefined ||
      run.status === "stopped" ||
      run.status === "completed" ||
      run.status === "failed"
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Desktop OTA project run '${runId}' did not stop.`);
}

async function closeLaunch(launch: LaunchHandle): Promise<void> {
  await launch.browser.close();
  await waitForNoInstalledProcesses(installedAppPath, 15_000);
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

async function waitForCdp(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return;
    } catch {
      // The app or its relaunch has not exposed CDP yet.
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
      .find((candidate) =>
        /\/renderer\/index\.html(?:\?.*)?$/u.test(candidate.url())
      );
    if (page !== undefined) return page;
    await delay(250);
  }
  throw new Error("Timed out waiting for the Desktop OTA renderer.");
}

async function waitForMainProcess(
  executablePath: string,
  requiredArguments: readonly string[],
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = listExecutableProcessIds(
      readProcessList(),
      executablePath,
      requiredArguments,
    );
    if (pids.length === 1) return pids[0]!;
    if (pids.length > 1) {
      throw new Error(`Desktop OTA launched multiple main processes: ${pids}.`);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Desktop executable ${executablePath}.`);
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
  const signature = parseCodeSignatureDetails(
    runChecked("codesign", ["-dv", "--verbose=4", appPath]).combined,
  );
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

function generateLocalhostCertificate(root: string): {
  certificatePath: string;
  privateKeyPath: string;
  spki: string;
} {
  const configPath = path.join(root, "openssl.cnf");
  const certificatePath = path.join(root, "localhost.crt");
  const privateKeyPath = path.join(root, "localhost.key");
  writeFileSync(
    configPath,
    [
      "[req]",
      "prompt = no",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "[dn]",
      "CN = localhost",
      "[ext]",
      "basicConstraints = critical,CA:TRUE",
      "subjectAltName = DNS:localhost",
      "keyUsage = critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage = serverAuth",
    ].join("\n").concat("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  runChecked("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-config",
    configPath,
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
  ]);
  const publicKey = execFileSync(
    "openssl",
    ["x509", "-in", certificatePath, "-pubkey", "-noout"],
  );
  const publicKeyDer = execFileSync(
    "openssl",
    ["pkey", "-pubin", "-outform", "DER"],
    { input: publicKey },
  );
  return {
    certificatePath,
    privateKeyPath,
    spki: createHash("sha256").update(publicKeyDer).digest("base64"),
  };
}

async function seedOfflineConfiguration(input: {
  coreHome: string;
  baseUrl: string;
  projectPath: string;
}): Promise<void> {
  const paths = resolveLocalCorePaths(input.coreHome);
  const policy = {
    version: 1 as const,
    provider: "openrouter" as const,
    model: "openai/gpt-5.2-chat",
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
    `${JSON.stringify(
      {
        ...runtimeConfiguration,
        providers: {
          ...runtimeConfiguration.providers,
          openrouter: { baseUrl: input.baseUrl },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeDesktopSettings(
    path.join(paths.settingsPath, "local-core-settings.json"),
    {
      ...createDefaultDesktopSettings(policy),
      selectedProvider: "openrouter",
      openrouterModel: policy.model,
      openrouterBaseUrl: input.baseUrl,
      providerSelectionCompletedAt: new Date().toISOString(),
      setupCompletedAt: new Date().toISOString(),
      projects: [
        {
          path: input.projectPath,
          label: "OTA Busy Gate",
        },
      ],
    },
  );
}

function verifyInstalledVersion(expectedVersion: string): void {
  assert.equal(
    readPlistValue(
      path.join(installedAppPath, "Contents", "Info.plist"),
      "CFBundleShortVersionString",
    ),
    expectedVersion,
  );
}

function verifyEmbeddedUpdateUrl(appPath: string, expectedUrl: string): void {
  assert.equal(readEmbeddedUpdateUrl(appPath), expectedUrl);
}

function readEmbeddedUpdateUrl(appPath: string): string {
  const config = parse(
    readFileSync(
      path.join(appPath, "Contents", "Resources", "app-update.yml"),
      "utf8",
    ),
  ) as { url?: unknown };
  if (typeof config.url !== "string") {
    throw new Error(`Desktop app-update.yml has no URL: ${appPath}`);
  }
  return config.url;
}

function resolveMountedAppPath(mountRoot: string): string {
  const apps = readdirSync(mountRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => path.join(mountRoot, entry.name));
  assert.deepEqual(apps.map((appPath) => path.basename(appPath)), [
    "Kestrel.app",
  ]);
  return apps[0]!;
}

function unregisterInstalledApplication(appPath: string): void {
  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/"
    + "LaunchServices.framework/Support/lsregister";
  runChecked(lsregister, ["-u", appPath]);
}

async function stopInstalledApplicationProcesses(appPath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pids = listInstalledApplicationProcessIds(appPath);
    if (pids.length === 0) return;
    const signal: NodeJS.Signals = attempt === 0 ? "SIGTERM" : "SIGKILL";
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await delay(250);
  }
  throw new Error("Desktop OTA application processes did not exit.");
}

function listInstalledApplicationProcessIds(appPath: string): number[] {
  return listExecutableProcessIds(
    readProcessList(),
    path.join(appPath, "Contents", "MacOS", "Kestrel"),
  ).filter((pid) => pid !== process.pid);
}

async function waitForNoInstalledProcesses(
  appPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listInstalledApplicationProcessIds(appPath).length === 0) return;
    await delay(100);
  }
  throw new Error("Desktop OTA application did not quit cleanly.");
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
    server.close((error) => error ? reject(error) : resolve());
  });
  assert.equal(typeof port, "number");
  return port!;
}

function collectUpdaterLogs(smokePath: string, localCoreHome: string): string {
  return updaterLogPaths(smokePath, localCoreHome)
    .filter((logPath) => existsSync(logPath))
    .map((logPath) => readFileSync(logPath, "utf8"))
    .join("\n");
}

function captureUpdaterLogCheckpoint(
  smokePath: string,
  localCoreHome: string,
): ReadonlyMap<string, number> {
  return new Map(
    updaterLogPaths(smokePath, localCoreHome).map((logPath) => [
      logPath,
      existsSync(logPath) ? readFileSync(logPath).byteLength : 0,
    ]),
  );
}

function readUpdaterLogSince(
  checkpoint: ReadonlyMap<string, number>,
): string {
  return [...checkpoint.entries()]
    .filter(([logPath]) => existsSync(logPath))
    .map(([logPath, offset]) => readFileSync(logPath).subarray(offset).toString())
    .join("\n");
}

function updaterLogPaths(
  smokePath: string,
  localCoreHome: string,
): string[] {
  return [
    ...readdirSync(smokePath)
      .filter((name) => name.endsWith(".log"))
      .sort()
      .map((name) => path.join(smokePath, name)),
    path.join(
      resolveLocalCorePaths(localCoreHome).logsPath,
      "desktop-runtime.log",
    ),
  ];
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ownerPid = readLockPid(filePath);
      if (ownerPid !== undefined && isPidAlive(ownerPid)) {
        throw new Error(`Desktop OTA gate is already running as ${ownerPid}.`);
      }
      rmSync(filePath, { force: true });
    }
  }
  throw new Error("Unable to acquire the Desktop OTA gate lock.");
}

function readLockPid(filePath: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as {
      pid?: unknown;
    };
    return typeof value.pid === "number" &&
        Number.isInteger(value.pid) &&
        value.pid > 0
      ? value.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function runChecked(
  command: string,
  args: string[],
  options: { acceptStatus?: number[] | undefined } = {},
): { stdout: string; stderr: string; combined: string } {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (
    result.status === null ||
    !(options.acceptStatus ?? [0]).includes(result.status)
  ) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}): ${
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()
      }`,
    );
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { stdout, stderr, combined: `${stdout}\n${stderr}` };
}

function readPlistValue(plistPath: string, key: string): string {
  const value = runChecked("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    plistPath,
  ]).stdout.trim();
  assert.notEqual(value, "");
  return value;
}

function readDesktopVersion(): string {
  const manifest = JSON.parse(
    readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error("apps/desktop/package.json must declare a version.");
  }
  return manifest.version;
}

function readProcessList(): string {
  return execFileSync("ps", ["-ax", "-o", "pid=,command="], {
    encoding: "utf8",
  });
}

function printDiagnosticLog(logPath: string, label: string): void {
  if (existsSync(logPath)) {
    process.stderr.write(
      `[desktop-ota-smoke] ${label} log:\n${readFileSync(logPath, "utf8")}\n`,
    );
  }
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
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}

function requireDesktopBridge(): {
  getAppInfo(): Promise<unknown>;
  getBootState(): Promise<unknown>;
  getBridgeInfo(): Promise<unknown>;
  getUiState(): Promise<unknown>;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  installUpdate(): Promise<unknown>;
  listProjectRuns(): Promise<unknown>;
  startProjectRun(input: {
    projectPath: string;
    scriptName: string;
    packageManagerOverride: "npm";
  }): Promise<unknown>;
  stopProjectRun(runId: string): Promise<unknown>;
} {
  const bridge = (
    globalThis as typeof globalThis & {
      kestrelDesktop?: ReturnType<typeof requireDesktopBridge>;
    }
  ).kestrelDesktop;
  if (bridge === undefined) {
    throw new Error("Desktop preload bridge is unavailable.");
  }
  return bridge;
}
