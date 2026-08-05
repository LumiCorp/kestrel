import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopStartup } from "../src/startupSequence.js";


const testDir = path.dirname(fileURLToPath(import.meta.url));
const bootHtmlPath = path.join(testDir, "..", "static", "boot.html");
const mainPath = path.join(testDir, "..", "src", "main.ts");
const recoveryPath = path.join(testDir, "..", "src", "localCoreRecovery.ts");
const sharedContractsPath = path.join(
  testDir,
  "..",
  "..",
  "..",
  "src",
  "desktopShell",
  "contracts.ts",
);

test("static boot fallback exposes only renderer recovery actions", async () => {
  const source = await readFile(bootHtmlPath, "utf8");

  assert.match(source, /Kestrel’s interface could not load/u);
  assert.match(source, />Restart Kestrel</u);
  assert.match(source, />Open Diagnostics</u);
  assert.match(source, /desktopBridge\.restartKestrel\(\{ force: restartRequiresForce \}\)/u);
  assert.match(source, /Force Restart Kestrel/u);
  assert.match(source, /result\.status === "blocked"/u);
  assert.match(source, /result\.blockers\s*\.map\(\(blocker\) => blocker\.message\)/u);
  assert.doesNotMatch(source, /desktopBridge\.restartApp\(\)/u);
  assert.doesNotMatch(source, /desktopBridge\.restartRuntime\(\)/u);
  assert.match(source, /class="brand-logo"/u);
  assert.match(source, /kestrel-full-horz-dark-mode\.png/u);
  assert.match(source, /desktopBridge\?\.openDiagnostics\(\)/u);
  assert.doesNotMatch(source, /Settings/u);
  assert.doesNotMatch(source, /project/u);
  assert.doesNotMatch(source, /restartRuntime/u);
  assert.doesNotMatch(source, /resetRuntimeStore/u);
});

test("blocked-startup recovery is registered before runtime transport startup", async () => {
  const [mainSource, recoverySource] = await Promise.all([
    readFile(mainPath, "utf8"),
    readFile(recoveryPath, "utf8"),
  ]);

  assert.ok(
    mainSource.indexOf("registerBootIpcHandlers();") <
      mainSource.indexOf("await startDesktopStartup({"),
  );
  assert.match(mainSource, /desktop:restart-kestrel/u);
  assert.doesNotMatch(recoverySource, /runnerTransport/u);
});

test("healthy runtime restart remains execution-bundle scoped", async () => {
  const source = await readFile(mainPath, "utf8");
  const start = source.indexOf('ipcMain.handle("desktop:restart-runtime"');
  const end = source.indexOf('"desktop:request-microphone-access"', start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);

  assert.match(handler, /runnerTransport\.stop\(\)/u);
  assert.match(handler, /ensureDesktopRunnerResponsive\(runnerTransport\)/u);
  assert.doesNotMatch(handler, /restartKestrel|signalProcess|app\.relaunch/u);
});

test("Desktop creates a visible boot window before runtime startup", async () => {
  const source = await readFile(mainPath, "utf8");

  assert.match(source, /backgroundColor:\s*"#101315",\s*show:\s*true,/su);
  assert.doesNotMatch(source, /window\.on\("ready-to-show"/u);
});

test("Desktop guards the Vite renderer with generation-scoped readiness and fallback", async () => {
  const source = await readFile(mainPath, "utf8");

  assert.match(source, /DESKTOP_RENDERER_BOOTSTRAP_TIMEOUT_MS\s*=\s*10_000/u);
  assert.match(source, /query:\s*\{ bootstrapGeneration:/u);
  assert.match(source, /desktop:report-renderer-bootstrap/u);
  assert.match(source, /report\.generation\s*!==\s*rendererBootstrapGeneration/u);
  assert.match(source, /"did-fail-load"/u);
  assert.match(source, /"render-process-gone"/u);
  assert.match(source, /showDesktopRendererFallback/u);
});

test("Desktop accepts onboarding IPC only from the current main renderer", async () => {
  const source = await readFile(mainPath, "utf8");
  const guardedChannels = [
    "desktop:get-launch-state",
    "desktop:get-onboarding-state",
    "desktop:save-onboarding-draft",
    "desktop:verify-onboarding-provider",
    "desktop:pick-onboarding-project",
    "desktop:inspect-onboarding-project",
    "desktop:confirm-onboarding-project",
    "desktop:complete-onboarding",
    "desktop:get-model-catalog",
  ];

  assert.match(
    source,
    /event\.senderFrame\s*!==\s*window\.webContents\.mainFrame/u,
  );
  for (const channel of guardedChannels) {
    const handlerStart = source.indexOf(`"${channel}"`);
    assert.notEqual(handlerStart, -1, `${channel} must be registered`);
    assert.match(
      source.slice(handlerStart, handlerStart + 500),
      /requireCurrentMainWindowIpcSender\(event\)/u,
      `${channel} must validate its sender before use`,
    );
  }
});

test("generic onboarding drafts cannot nominate a project path", async () => {
  const [mainSource, contractSource] = await Promise.all([
    readFile(mainPath, "utf8"),
    readFile(sharedContractsPath, "utf8"),
  ]);
  const draftContract = contractSource.slice(
    contractSource.indexOf("export interface DesktopOnboardingDraftInput"),
    contractSource.indexOf("export interface DesktopOnboardingProviderInput"),
  );
  const draftParser = mainSource.slice(
    mainSource.indexOf("function parseDesktopOnboardingDraftInput"),
    mainSource.indexOf("function parseDesktopOnboardingProviderInput"),
  );

  assert.doesNotMatch(draftContract, /projectPath/u);
  assert.match(draftParser, /new Set\(\["provider", "model"\]\)/u);
  assert.doesNotMatch(draftParser, /projectPath/u);
});

test("Desktop revalidates onboarding after execution startup before completion", async () => {
  const source = await readFile(mainPath, "utf8");
  const completion = source.slice(
    source.indexOf("async function completeDesktopOnboarding"),
    source.indexOf("async function ensureCompletedDesktopOnboardingHandoff"),
  );

  assert.match(
    completion,
    /await startDesktopExecutionServices\(\);[\s\S]*await readDesktopOnboardingState\(\);[\s\S]*confirmedOnboarding\.canComplete === false[\s\S]*await saveDesktopCoreSettings/u,
  );
});

test(
  "Desktop shows the boot window before persisted-state startup can settle",
  async () => {
    let resolveServices: (() => void) | undefined;
    const services = new Promise<void>((resolve) => {
      resolveServices = resolve;
    });
    const events: string[] = [];

    await startDesktopStartup({
      async showBootWindow() {
        events.push("boot");
      },
      async startServices() {
        events.push("services");
        await services;
      },
      async reportFailure() {
        events.push("failed");
      },
    });

    assert.deepEqual(events, ["boot", "services"]);
    resolveServices?.();
  },
);

test(
  "Desktop reports pre-renderer startup failures without closing the boot surface",
  async () => {
    const events: string[] = [];

    await startDesktopStartup({
      async showBootWindow() {
        events.push("boot");
      },
      async startServices() {
        throw new Error("profile resolution failed");
      },
      async reportFailure(error) {
        events.push(error instanceof Error ? error.message : String(error));
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(events, ["boot", "profile resolution failed"]);
  },
);
