import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
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
import { waitForAsyncValue } from "./desktop-smoke-poll.js";

const repoRoot = resolveRepoRoot(process.cwd());
const expectedDesktopVersion = readDesktopVersion(repoRoot);
const packagerConfig = resolveDesktopPackagerConfig({ repoRoot });
const packagedRoot = process.env.KESTREL_DESKTOP_PACKAGE_PATH?.trim()
  || path.join(
    packagerConfig.outDir,
    `mac-${packagerConfig.arch}`,
  );
const executablePath = resolvePackagedExecutable(packagedRoot, packagerConfig.platform);
const evidenceDir = path.join(repoRoot, "apps", "desktop", "out", "package-smoke");
const smokeLockPath = path.join(evidenceDir, "active.lock");
const screenshotPath = path.join(evidenceDir, "renderer.png");
const projectsScreenshotPath = path.join(evidenceDir, "projects.png");
const mcpScreenshotPath = path.join(evidenceDir, "mcp.png");
const mcpEditorScreenshotPath = path.join(evidenceDir, "mcp-editor.png");
const settingsScreenshotPath = path.join(evidenceDir, "settings.png");
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
const heartbeat = setInterval(() => {
  process.stdout.write("[desktop-package-smoke] still running\n");
}, 10_000);

const smokeRoot = mkdtempSync(path.join(resolveSmokeTempParent(), "kdp-gui-"));
const coreHome = path.join(smokeRoot, "core-home");
const userDataPath = path.join(smokeRoot, "user-data");
const onboardingProjectPath = path.join(smokeRoot, "first-project");
mkdirSync(onboardingProjectPath, { recursive: true, mode: 0o700 });
writeFileSync(path.join(onboardingProjectPath, "README.md"), "# First Kestrel project\n", {
  encoding: "utf8",
  mode: 0o600,
});
const fakeOpenRouter = await startFakeOpenRouterServer();
await seedOfflineModelConfiguration({
  coreHome,
  baseUrl: fakeOpenRouter.url,
});
const liveModelApproved = process.env.KESTREL_DESKTOP_PACKAGE_SMOKE_LIVE_MODEL_APPROVED === "1";
const sourceCoreHome = process.env.KESTREL_DESKTOP_PACKAGE_SMOKE_SOURCE_CORE_HOME?.trim();
if (liveModelApproved) {
  assert.equal(
    typeof sourceCoreHome === "string" && sourceCoreHome.length > 0,
    true,
    "Live model smoke requires KESTREL_DESKTOP_PACKAGE_SMOKE_SOURCE_CORE_HOME.",
  );
  copyDesktopModelConfiguration(sourceCoreHome!, coreHome);
}

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
      KESTREL_CORE_CREDENTIAL_STORE: "environment",
      KESTREL_DESKTOP_PACKAGE_SMOKE_PROJECT_PATH: onboardingProjectPath,
      OPENROUTER_API_KEY: "kestrel-package-smoke-token",
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
  await window.waitForURL(/\/renderer\/index\.html(?:\?.*)?$/u, { timeout: 60_000 });
  await window.waitForLoadState("domcontentloaded");
  await window.locator("#root").waitFor({ state: "visible", timeout: 60_000 });
  await completeFirstRunOnboarding(window);
  await window.locator(".composer").waitFor({ state: "visible", timeout: 60_000 });
  const completedSettings = JSON.parse(readFileSync(
    path.join(resolveLocalCorePaths(coreHome).settingsPath, "local-core-settings.json"),
    "utf8",
  )) as Record<string, unknown>;
  assert.equal(
    (completedSettings.desktopOnboarding as { status?: unknown } | undefined)?.status,
    "complete",
    "First-run completion must persist only after Desktop execution is ready.",
  );
  assert.equal(typeof completedSettings.providerSelectionCompletedAt, "string");
  assert.equal(typeof completedSettings.setupCompletedAt, "string");
  const terminalBootState = await window.evaluate(async () => {
    const bridge = (globalThis as typeof globalThis & {
      kestrelDesktop?: {
        getBootState(): Promise<{
          phase: string;
          code?: string | undefined;
          message: string;
          details?: string | undefined;
        }>;
      };
    }).kestrelDesktop;
    return await bridge?.getBootState();
  });
  assert.equal(
    terminalBootState?.phase,
    "ready",
    terminalBootState === undefined
      ? "Desktop preload bridge did not expose boot state."
      : JSON.stringify(terminalBootState),
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
      chatLayout: (() => {
        const activity = document.querySelector(".activity-line")?.getBoundingClientRect();
        const composer = document.querySelector(".composer")?.getBoundingClientRect();
        return composer === undefined
          ? undefined
          : {
              composerLeft: composer.left,
              composerWidth: composer.width,
              ...(activity === undefined
                ? {}
                : {
                    activityLeft: activity.left,
                    activityWidth: activity.width,
                  }),
            };
      })(),
    };
  });

  assert.equal(mainProcess.isPackaged, true, "Electron main process must report a packaged application.");
  assert.equal(renderer.appInfo.isPackaged, true, "Preload app info must report a packaged application.");
  assert.equal(renderer.appInfo.version, mainProcess.version, "Main and preload versions must agree.");
  assert.equal(renderer.appInfo.version, expectedDesktopVersion, "Packaged Desktop must report its manifest version.");
  assert.equal(renderer.bridgeInfo.connected, true, "Desktop preload bridge must be connected.");
  assert.equal(
    renderer.bridgeInfo.version,
    DESKTOP_BRIDGE_VERSION,
    `Packaged Desktop must expose bridge version ${DESKTOP_BRIDGE_VERSION}.`,
  );
  assert.equal(renderer.bridgeInfo.capabilities.includes("capability_registry"), true);
  assert.equal(renderer.bridgeInfo.capabilities.includes("runtime_inspection"), true);
  assert.equal(renderer.bridgeInfo.capabilities.includes("mission_control"), true);
  assert.equal(renderer.bridgeInfo.capabilities.includes("attachments"), true);
  assert.equal(renderer.bridgeInfo.capabilities.includes("operator_control"), true);
  assert.equal(renderer.bridgeInfo.capabilities.includes("onboarding"), true);
  assert.equal(renderer.bootState.phase, "ready", renderer.bootState.code ?? renderer.bootState.message);
  assert.equal(renderer.hasRoot, true, "Packaged Desktop must mount the Vite renderer root.");
  assert.equal(renderer.hasNextAsset, false, "Packaged Desktop must not load Next.js assets.");
  assert.notEqual(
    renderer.chatLayout,
    undefined,
    "Packaged Desktop must render composer geometry.",
  );
  if (
    renderer.chatLayout?.activityLeft !== undefined &&
    renderer.chatLayout.activityWidth !== undefined
  ) {
    assert.equal(
      Math.abs(
        renderer.chatLayout.activityLeft - renderer.chatLayout.composerLeft,
      ) < 1,
      true,
      "Ephemeral activity must share the composer's left edge.",
    );
    assert.equal(
      Math.abs(
        renderer.chatLayout.activityWidth - renderer.chatLayout.composerWidth,
      ) < 1,
      true,
      "Ephemeral activity must share the composer's width.",
    );
  }
  assert.match(renderer.bodyText, /Kestrel/u);

  await window.screenshot({ path: screenshotPath, fullPage: true });
  const offlineModel = await verifyOfflineModel(window, fakeOpenRouter.url);
  const liveModel = liveModelApproved
    ? await verifyLiveModelResponse(window)
    : undefined;
  const surfaces = await verifyStaticRendererSurfaces(
    window,
    path.basename(onboardingProjectPath),
  );
  const persistenceMarker = `KESTREL_PACKAGE_PERSIST_${Date.now()}`;
  await openConversationSurface(window);
  await window
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(persistenceMarker);
  await waitForAsyncValue(
    async () => await window.evaluate(async (marker) => JSON.stringify(
      await (globalThis as typeof globalThis & {
        kestrelDesktop: { getUiState(): Promise<unknown> };
      }).kestrelDesktop.getUiState(),
    ).includes(String(marker)), persistenceMarker),
    (persisted) => persisted,
    {
      description: "packaged Desktop conversation persistence",
      timeoutMs: 30_000,
    },
  );
  const firstMainProcess = electronApp.process();
  const firstMainProcessExited = firstMainProcess.exitCode === null
    ? new Promise<void>((resolve) => {
        firstMainProcess.once("exit", () => resolve());
      })
    : Promise.resolve();
  await electronApp.close();
  await firstMainProcessExited;
  electronApp = undefined;
  electronPid = undefined;

  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataPath}`],
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_ENABLE_STACK_DUMPING: "1",
      KESTREL_HOME: coreHome,
      KESTREL_CORE_CREDENTIAL_STORE: "environment",
      KESTREL_DESKTOP_PACKAGE_SMOKE_PROJECT_PATH: onboardingProjectPath,
      OPENROUTER_API_KEY: "kestrel-package-smoke-token",
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
  const relaunchedWindow = await waitForReadyWindow(electronApp);
  await relaunchedWindow
    .getByRole("textbox", { name: "Message", exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(
    await relaunchedWindow.getByRole("button", { name: /Get started/u }).count(),
    0,
    "Completed onboarding must not reappear after relaunch.",
  );
  assert.equal(
    await relaunchedWindow
      .getByRole("textbox", { name: "Message", exact: true })
      .inputValue(),
    persistenceMarker,
    "The packaged app must restore persisted conversation draft state after relaunch.",
  );
  assert.match(
    await relaunchedWindow.locator("body").innerText(),
    /Hello from the fake cross-surface model/u,
    "The completed offline model conversation must survive relaunch.",
  );
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
      chatLayout: renderer.chatLayout,
      screenshotPath,
      surfaces,
      offlineModel,
      persistence: {
        marker: persistenceMarker,
        relaunched: true,
        conversationRestored: true,
      },
      ...(liveModel !== undefined ? { liveModel } : {}),
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
    });
  } finally {
    try {
      await fakeOpenRouter.close();
    } finally {
      clearInterval(heartbeat);
      rmSync(smokeLockPath, { force: true });
      if (
        smokePassed
        || process.env.KESTREL_DESKTOP_PACKAGE_SMOKE_KEEP_STATE !== "1"
      ) {
        rmSync(smokeRoot, { recursive: true, force: true });
      }
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

function copyDesktopModelConfiguration(sourceHome: string, targetHome: string): void {
  const liveModelSettingKeys = [
    "selectedProvider",
    "providerSelectionCompletedAt",
    "openrouterApiKey",
    "openrouterBaseUrl",
    "openrouterSiteUrl",
    "openrouterAppName",
    "openaiApiKey",
    "openaiBaseUrl",
    "openaiOrgId",
    "openaiProjectId",
    "anthropicApiKey",
    "anthropicBaseUrl",
    "anthropicVersion",
    "ollamaBaseUrl",
    "lmstudioBaseUrl",
  ] as const;
  const source = resolveLocalCorePaths(sourceHome);
  const target = resolveLocalCorePaths(targetHome);
  const sourcePolicyPath = path.join(source.stateRootPath, "model-policy.json");
  const targetPolicyPath = path.join(target.stateRootPath, "model-policy.json");
  assert.equal(existsSync(sourcePolicyPath), true, `Live model smoke configuration is missing: ${sourcePolicyPath}`);
  mkdirSync(path.dirname(targetPolicyPath), { recursive: true, mode: 0o700 });
  copyFileSync(sourcePolicyPath, targetPolicyPath);

  const sourceSettingsPath = path.join(source.settingsPath, "local-core-settings.json");
  const targetSettingsPath = path.join(target.settingsPath, "local-core-settings.json");
  assert.equal(existsSync(sourceSettingsPath), true, `Live model smoke configuration is missing: ${sourceSettingsPath}`);
  const sourceSettings = JSON.parse(readFileSync(sourceSettingsPath, "utf8")) as Record<string, unknown>;
  const providerSettings = Object.fromEntries(
    liveModelSettingKeys.flatMap((key) => sourceSettings[key] === undefined
      ? []
      : [[key, sourceSettings[key]]]),
  );
  mkdirSync(path.dirname(targetSettingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(targetSettingsPath, `${JSON.stringify(providerSettings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function verifyLiveModelResponse(window: Page): Promise<{
  verified: true;
  expectedToken: string;
  markdownRendered: true;
}> {
  const expectedToken = "KESTREL_DESKTOP_MODEL_OK";
  await openConversationSurface(window);
  await window.getByRole("textbox", { name: "Message", exact: true }).fill(
    `Reply with exactly this token and nothing else: ${expectedToken}`,
  );
  await window.getByRole("button", { name: "Send message", exact: true }).click();
  await window.waitForFunction(
    (token) => {
      const assistantResponded = Array.from(
        document.querySelectorAll(".message-assistant .message-body"),
      ).some((element) => element.textContent?.trim() === String(token));
      if (assistantResponded) {
        return true;
      }
      const error = document.querySelector(".activity-error")?.textContent?.trim();
      if (error !== undefined && error.length > 0) {
        throw new Error(error);
      }
      return false;
    },
    expectedToken,
    { timeout: 180_000 },
  );
  await window.getByText(expectedToken, { exact: true }).waitFor({ timeout: 30_000 });
  const assistantMessage = window.locator(".message-assistant .message-body-markdown").filter({
    hasText: expectedToken,
  });
  await assistantMessage.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(
    await assistantMessage.locator("p").count() > 0,
    true,
    "The live assistant response must render through Streamdown semantic markup.",
  );
  return { verified: true, expectedToken, markdownRendered: true };
}

async function seedOfflineModelConfiguration(input: {
  coreHome: string;
  baseUrl: string;
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
  const runtimeConfiguration = createDefaultLocalCoreRuntimeConfiguration(policy);
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
  window: Page,
): Promise<void> {
  const getStarted = window.getByRole("button", { name: /Get started/u });
  await getStarted.waitFor({ state: "visible", timeout: 60_000 });
  await getStarted.click();
  await window.getByLabel("Model", { exact: true }).selectOption("openai/gpt-5.2-chat");
  await window.getByLabel("API key", { exact: true }).fill("kestrel-package-smoke-token");
  await window.getByRole("button", { name: /Verify connection/u }).click();
  await window.getByRole("heading", { name: "Choose a project", exact: true }).waitFor({
    state: "visible",
    timeout: 60_000,
  });

  await window.getByRole("button", { name: /Choose or create a folder/u }).click();
  await window.getByRole("button", { name: /Use this project/u }).click();
  await window.getByRole("heading", { name: "Your Kestrel workspace", exact: true }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await window.getByRole("button", { name: /Open Kestrel/u }).click();
}

async function verifyOfflineModel(
  window: Page,
  baseUrl: string,
): Promise<{
  verified: true;
  baseUrl: string;
  response: string;
}> {
  await openConversationSurface(window);
  await window.getByRole("textbox", { name: "Message", exact: true }).fill(
    "Run the deterministic packaged Desktop smoke.",
  );
  await window.getByRole("button", { name: "Send message", exact: true }).click();
  const response = "Hello from the fake cross-surface model.";
  await window.getByText(response, { exact: true }).waitFor({ timeout: 180_000 });
  return { verified: true, baseUrl, response };
}

async function waitForReadyWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow({ timeout: 60_000 });
  await window.waitForLoadState("domcontentloaded");
  await window.waitForURL(/\/renderer\/index\.html(?:\?.*)?$/u, {
    timeout: 60_000,
  });
  await window.locator("#root").waitFor({ state: "visible", timeout: 60_000 });
  await window.locator(".composer").waitFor({ state: "visible", timeout: 60_000 });
  await waitForAsyncValue(
    async () => await window.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & {
        kestrelDesktop?: {
          getBootState(): Promise<{ phase?: string | undefined }>;
          getLaunchState(): Promise<{ phase?: string | undefined }>;
        };
      }).kestrelDesktop;
      if (bridge === undefined) {
        return { bootPhase: undefined, launchPhase: undefined };
      }
      const [bootState, launchState] = await Promise.all([
        bridge.getBootState(),
        bridge.getLaunchState(),
      ]);
      return {
        bootPhase: bootState.phase,
        launchPhase: launchState.phase,
      };
    }),
    (state) => state.bootPhase === "ready" && state.launchPhase === "ready",
    {
      description: "packaged Desktop boot and launch readiness",
      timeoutMs: 60_000,
    },
  );
  return window;
}

function readDesktopVersion(root: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8"),
  ) as { version?: unknown };
  assert.equal(typeof manifest.version, "string", "Desktop package version is missing.");
  return manifest.version;
}

async function verifyStaticRendererSurfaces(
  window: Page,
  projectLabel: string,
): Promise<Record<string, string>> {
  await openRendererSurface(window, "Settings", "Settings");
  for (const [category, capabilities] of [
    ["Models", ["OpenRouter"]],
    ["Connections", []],
    ["Local capabilities", ["Developer shell", "Sandboxed code execution"]],
    ["Workspace & data", ["Runtime database"]],
    ["Permissions", ["Microphone"]],
  ] as const) {
    await window
      .getByRole("link", { name: category, exact: true })
      .click();
    await window
      .getByRole("heading", { name: category, exact: true })
      .first()
      .waitFor({ timeout: 30_000 });
    for (const capability of capabilities) {
      await window
        .getByRole("heading", { name: capability, exact: true })
        .first()
        .waitFor({ timeout: 30_000 });
    }
  }
  await window
    .getByRole("link", { name: "Workspace & data", exact: true })
    .click();
  await window
    .getByRole("heading", { name: "Runtime database", exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  const databaseCard = window.locator(".capability-card").filter({ hasText: "Runtime database" });
  await databaseCard.getByRole("button", { name: "Configure", exact: true }).click();
  await window.getByRole("dialog", { name: "Runtime database", exact: true }).waitFor({ timeout: 30_000 });
  await window.getByRole("combobox", { name: /Storage mode/u }).selectOption("external");
  assert.equal(await window.getByRole("option", { name: "External PostgreSQL", exact: true }).count(), 1);
  assert.equal(await window.getByLabel(/PostgreSQL connection URL/u).getAttribute("type"), "password");
  await window.getByRole("button", { name: "Close capability settings", exact: true }).click();
  await assertNoSurfaceError(window, "Settings");
  await window.screenshot({ path: settingsScreenshotPath, fullPage: true });

  await openRendererSurface(window, "Projects", projectLabel);
  await assertNoSurfaceError(window, "Projects");
  await window.screenshot({ path: projectsScreenshotPath, fullPage: true });

  await openRendererSurface(window, "Apps", "Apps");
  await assertNoSurfaceError(window, "Apps");
  await window.screenshot({ path: mcpScreenshotPath, fullPage: true });
  await window.getByRole("button", { name: "Add Custom App", exact: true }).click();
  await window.getByRole("dialog", { name: "Add Custom App", exact: true }).waitFor({ timeout: 30_000 });
  await window.getByRole("button", { name: "Add credential", exact: true }).click();
  assert.equal(
    await window.locator(".mcp-credential-row input[type='password']").count(),
    1,
    "MCP credentials must use a write-only password field.",
  );
  await window.screenshot({ path: mcpEditorScreenshotPath, fullPage: true });
  await window.getByRole("button", { name: "Close Custom App editor", exact: true }).click();

  await openRendererSurface(window, "Diagnostics", "Diagnostics");
  const updatePanel = window.getByRole("region", { name: "Desktop update" });
  await updatePanel.waitFor({ timeout: 30_000 });
  await updatePanel
    .getByRole("button", { name: "Check for Updates", exact: true })
    .waitFor({ timeout: 30_000 });
  await assertNoSurfaceError(window, "Diagnostics");
  await window.screenshot({ path: diagnosticsScreenshotPath, fullPage: true });

  return {
    chat: screenshotPath,
    projects: projectsScreenshotPath,
    mcp: mcpScreenshotPath,
    mcpEditor: mcpEditorScreenshotPath,
    settings: settingsScreenshotPath,
    diagnostics: diagnosticsScreenshotPath,
  };
}

async function openRendererSurface(
  window: Page,
  buttonName: string,
  headingName: string,
): Promise<void> {
  await window.getByRole("button", { name: /Find work/u }).click();
  const navigator = window.getByRole("dialog", { name: "Find work" });
  await navigator
    .getByRole("button", { name: buttonName, exact: true })
    .click();
  await window.getByRole("heading", { name: headingName, exact: true }).waitFor({ timeout: 30_000 });
}

async function openConversationSurface(window: Page): Promise<void> {
  await window.getByRole("button", { name: /Find work/u }).click();
  const navigator = window.getByRole("dialog", { name: "Find work" });
  await navigator
    .getByRole("navigation", { name: "Kestrel views" })
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await window
    .getByRole("textbox", { name: "Message", exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
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
    app.close().catch(() => {}),
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
    return ;
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

async function cleanupIsolatedSmoke(input: {
  electronApp: ElectronApplication | undefined;
  electronPid: number | undefined;
  coreHome: string;
  packagedRoot: string;
}): Promise<void> {
  const errors: Error[] = [];
  for (const cleanup of [
    () => closeElectronApplication(input.electronApp),
    () => stopIsolatedLocalCore(input.coreHome),
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


async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopOwnedProcess(pid: number, gracefulTimeoutMs = 5000): Promise<void> {
  if (isPidAlive(pid) === false) {
    return;
  }
  process.kill(pid, "SIGTERM");
  await waitForPidExit(pid, gracefulTimeoutMs);
  if (isPidAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForPidExit(pid, 5000);
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
