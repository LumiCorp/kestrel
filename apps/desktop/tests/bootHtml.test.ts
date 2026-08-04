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

test("boot screen exposes Reset Runtime Store only for sqlite init failures", async () => {
  const source = await readFile(bootHtmlPath, "utf8");

  assert.match(source, /id="reset-store"/u);
  assert.match(source, /id="copy-help-packet"/u);
  assert.match(source, />Restart Kestrel</u);
  assert.match(source, /desktopBridge\.restartKestrel\(\{ force: restartRequiresForce \}\)/u);
  assert.match(source, /Force Restart Kestrel/u);
  assert.match(source, /result\.status === "blocked"/u);
  assert.match(source, /result\.blockers\s*\.map\(\(blocker\) => blocker\.message\)/u);
  assert.doesNotMatch(source, /desktopBridge\.restartApp\(\)/u);
  assert.doesNotMatch(source, /desktopBridge\.restartRuntime\(\)/u);
  assert.match(source, /class="brand-logo"/u);
  assert.match(source, /kestrel-full-horz-dark-mode\.png/u);
  assert.match(source, /Readiness checklist/u);
  assert.match(source, /id="checklist"/u);
  assert.match(source, /renderChecklist/u);
  assert.match(source, /renderTimeline/u);
  assert.match(source, /for \(const item of \[\.\.\.items\]\.sort/u);
  assert.match(source, /resetStore\.hidden = state\.code !== "STORE_SQLITE_INIT_FAILED";/u);
  assert.match(source, /desktopBridge\.resetRuntimeStore\(\)/u);
  assert.match(source, /desktopBridge\.getSupportBundle\(\)/u);
  assert.doesNotMatch(source, /id="check-resources"/u);
  assert.doesNotMatch(source, /repair_database/u);
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
