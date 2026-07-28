import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { contractTest } from "../helpers/contract-test.js";

const repoRoot = process.cwd();

contractTest("desktop.hermetic", "Desktop uninstall helper preserves native safety checks", () => {
  const source = readFileSync(
    path.join(repoRoot, "apps", "desktop", "native", "kestrel-uninstall-helper.swift"),
    "utf8",
  );

  assert.match(source, /requireMode0600/u);
  assert.match(source, /kestrel_uninstall_plan_v1/u);
  assert.match(source, /plan initiator must be desktop/u);
  assert.match(source, /com\.kestrel\.desktop/u);
  assert.match(source, /Signature=adhoc/u);
  assert.match(source, /Developer ID Application:/u);
  assert.match(source, /trashItem/u);
  assert.match(source, /removedTargets/u);
  assert.match(source, /reportPath/u);
  assert.match(source, /DESKTOP_UNINSTALL_HELPER_TARGET_FAILED/u);
  assert.match(source, /profile target resolves outside verified Desktop paths/u);
});

contractTest("desktop.hermetic", "Desktop packaging includes the uninstall helper for macOS", () => {
  const packageSource = readFileSync(
    path.join(repoRoot, "scripts", "package-desktop.ts"),
    "utf8",
  );
  const builderSource = readFileSync(
    path.join(repoRoot, "apps", "desktop", "src", "builderConfig.ts"),
    "utf8",
  );

  assert.match(packageSource, /prepareDesktopUninstallHelper/u);
  assert.match(packageSource, /kestrel-uninstall-helper\.swift/u);
  assert.match(packageSource, /arm64-apple-macosx13\.0/u);
  assert.match(packageSource, /swiftc/u);
  assert.match(builderSource, /extraResources/u);
  assert.match(builderSource, /kestrel-uninstall-helper/u);
});

contractTest("desktop.hermetic", "Desktop main exposes guarded uninstall apply IPC", () => {
  const source = readFileSync(
    path.join(repoRoot, "apps", "desktop", "src", "main.ts"),
    "utf8",
  );

  assert.match(source, /desktop:apply-uninstall-plan/u);
  assert.match(source, /parseDesktopUninstallApplyInput/u);
  assert.match(source, /Desktop uninstall apply requires a Desktop-initiated plan/u);
  assert.match(source, /DESKTOP_UNINSTALL_RELEASE_BUILD_REQUIRED/u);
  assert.match(source, /deferredTargetIds: helperTargetIds/u);
  assert.match(source, /kestrel-uninstall-helper/u);
  assert.match(source, /DESKTOP_UNINSTALL_HELPER_SCHEDULED/u);
  assert.match(source, /mergeDesktopHelperReport/u);
});

contractTest("desktop.hermetic", "Desktop preload exposes uninstall apply bridge", () => {
  const source = readFileSync(
    path.join(repoRoot, "apps", "desktop", "src", "preload.ts"),
    "utf8",
  );

  assert.match(source, /applyUninstallPlan/u);
  assert.match(source, /desktop:apply-uninstall-plan/u);
});

contractTest("desktop.hermetic", "Desktop uninstall helper rejects wrong mode and malformed plans", () => {
  if (process.platform !== "darwin") return;
  let swiftc: string;
  try {
    execFileSync("/usr/bin/xcrun", ["--find", "swiftc"], {
      stdio: "pipe",
    });
    swiftc = "/usr/bin/xcrun";
  } catch {
    return;
  }
  const tempRoot = mkdtempSync(path.join("/tmp", "kestrel-desktop-helper-test-"));
  try {
    mkdirSync(path.join(tempRoot, "module-cache"));
    const helperPath = path.join(tempRoot, "helper");
    compileDesktopHelper(swiftc, tempRoot, helperPath);

    const wrongModePlan = path.join(tempRoot, "wrong-mode.json");
    writeFileSync(wrongModePlan, JSON.stringify({ version: "kestrel_uninstall_plan_v1", initiator: "desktop", targets: [] }));
    chmodSync(wrongModePlan, 0o644);
    let run = spawnSync(helperPath, ["--plan", wrongModePlan], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /plan must be mode 0600/u);

    const wrongVersionPlan = path.join(tempRoot, "wrong-version.json");
    writeFileSync(wrongVersionPlan, JSON.stringify({ version: "wrong", initiator: "desktop", targets: [] }));
    chmodSync(wrongVersionPlan, 0o600);
    run = spawnSync(helperPath, ["--plan", wrongVersionPlan], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /plan version is invalid/u);

    const wrongInitiatorPlan = path.join(tempRoot, "wrong-initiator.json");
    writeFileSync(wrongInitiatorPlan, JSON.stringify({
      version: "kestrel_uninstall_plan_v1",
      planId: "wrong-initiator",
      initiator: "cli",
      targets: [],
    }));
    chmodSync(wrongInitiatorPlan, 0o600);
    run = spawnSync(helperPath, ["--plan", wrongInitiatorPlan], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /plan initiator must be desktop/u);

    const missingTargetsPlan = path.join(tempRoot, "missing-targets.json");
    writeFileSync(missingTargetsPlan, JSON.stringify({
      version: "kestrel_uninstall_plan_v1",
      planId: "missing-targets",
      initiator: "desktop",
    }));
    chmodSync(missingTargetsPlan, 0o600);
    run = spawnSync(helperPath, ["--plan", missingTargetsPlan], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /plan targets must be an array/u);

    const malformedTargetPlan = path.join(tempRoot, "malformed-target.json");
    writeFileSync(malformedTargetPlan, JSON.stringify({
      version: "kestrel_uninstall_plan_v1",
      planId: "malformed-target",
      initiator: "desktop",
      targets: [{ id: "missing-fields" }],
    }));
    chmodSync(malformedTargetPlan, 0o600);
    run = spawnSync(helperPath, ["--plan", malformedTargetPlan], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /plan target 0 is malformed/u);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

contractTest("desktop.hermetic", "Desktop uninstall helper waits for its parent and writes a mode-0600 completion report", async () => {
  if (process.platform !== "darwin") return;
  let swiftc: string;
  try {
    execFileSync("/usr/bin/xcrun", ["--find", "swiftc"], {
      stdio: "pipe",
    });
    swiftc = "/usr/bin/xcrun";
  } catch {
    return;
  }
  const tempRoot = mkdtempSync(
    path.join("/tmp", "kestrel-desktop-helper-wait-"),
  );
  try {
    mkdirSync(path.join(tempRoot, "module-cache"));
    const helperPath = path.join(tempRoot, "helper");
    compileDesktopHelper(swiftc, tempRoot, helperPath);
    const planPath = path.join(tempRoot, "plan.json");
    const reportPath = path.join(tempRoot, "report.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        version: "kestrel_uninstall_plan_v1",
        planId: "parent-wait-fixture",
        initiator: "desktop",
        targets: [],
      }),
      { mode: 0o600 },
    );
    const parent = spawn("/bin/sleep", ["5"], { stdio: "ignore" });
    assert.ok(parent.pid);
    const helper = spawn(
      helperPath,
      [
        "--plan",
        planPath,
        "--parent-pid",
        String(parent.pid),
        "--report",
        reportPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(helper.exitCode, null);
    parent.kill("SIGTERM");
    const [helperExitCode, helperSignal] = await once(helper, "exit");
    assert.equal(helperSignal, null);
    assert.equal(helperExitCode, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      version?: unknown;
      executor?: unknown;
      planId?: unknown;
      status?: unknown;
      failures?: unknown;
    };
    assert.deepEqual(
      {
        version: report.version,
        executor: report.executor,
        planId: report.planId,
        status: report.status,
        failures: report.failures,
      },
      {
        version: "kestrel_uninstall_completion_report_v1",
        executor: "desktop_helper",
        planId: "parent-wait-fixture",
        status: "complete",
        failures: [],
      },
    );
    assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

contractTest("desktop.hermetic", "Desktop uninstall helper refuses foreign profile targets", () => {
  if (process.platform !== "darwin") return;
  let swiftc: string;
  try {
    execFileSync("/usr/bin/xcrun", ["--find", "swiftc"], {
      stdio: "pipe",
    });
    swiftc = "/usr/bin/xcrun";
  } catch {
    return;
  }
  const tempRoot = mkdtempSync(
    path.join("/tmp", "kestrel-desktop-helper-profile-"),
  );
  try {
    mkdirSync(path.join(tempRoot, "module-cache"));
    const helperPath = path.join(tempRoot, "helper");
    compileDesktopHelper(swiftc, tempRoot, helperPath);
    const foreignPath = path.join(tempRoot, "foreign-profile");
    writeFileSync(foreignPath, "preserve", "utf8");
    const planPath = path.join(tempRoot, "foreign-plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        version: "kestrel_uninstall_plan_v1",
        planId: "foreign-profile-fixture",
        initiator: "desktop",
        targets: [
          {
            id: "foreign.profile",
            kind: "electron_profile",
            path: foreignPath,
            selected: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const run = spawnSync(helperPath, ["--plan", planPath], {
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /outside verified Desktop paths/u);
    assert.equal(readFileSync(foreignPath, "utf8"), "preserve");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

contractTest("desktop.hermetic", "Desktop uninstall helper removes signed fixtures and approved profile data", () => {
  if (process.platform !== "darwin") return;
  const tempRoot = mkdtempSync(
    path.join("/tmp", "kestrel-desktop-helper-removal-"),
  );
  try {
    mkdirSync(path.join(tempRoot, "module-cache"));
    const helperPath = path.join(tempRoot, "helper");
    compileDesktopHelper("/usr/bin/xcrun", tempRoot, helperPath, true);
    const fixtureRoot = path.join(tempRoot, "fixture");
    const bundlePath = path.join(fixtureRoot, "Applications", "Kestrel.app");
    const developerId = findDeveloperIdApplicationIdentity();
    const usesAdhocFixture = developerId === undefined
      || !tryCreateSignedFixtureBundle(
        bundlePath,
        "com.kestrel.desktop",
        developerId,
      );
    if (usesAdhocFixture) {
      rmSync(bundlePath, { recursive: true, force: true });
      createSignedFixtureBundle(bundlePath, "com.kestrel.desktop", "-");
    }
    const profilePath = path.join(
      fixtureRoot,
      "Home",
      "Library",
      "Application Support",
      "Kestrel",
    );
    mkdirSync(profilePath, { recursive: true });
    writeFileSync(path.join(profilePath, "state.sqlite"), "fixture", "utf8");
    const missingCachePath = path.join(
      fixtureRoot,
      "Home",
      "Library",
      "Caches",
      "Kestrel",
    );
    const planPath = path.join(tempRoot, "removal-plan.json");
    const reportPath = path.join(tempRoot, "removal-report.json");
    writeHelperPlan(planPath, "signed-removal-fixture", [
      helperTarget("desktop.bundle", "desktop_bundle", bundlePath),
      helperTarget("desktop.profile", "electron_profile", profilePath),
      helperTarget("desktop.cache", "cache", missingCachePath),
    ]);
    const run = spawnSync(
      helperPath,
      ["--plan", planPath, "--report", reportPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          KESTREL_UNINSTALL_TEST_ROOT: fixtureRoot,
          ...(usesAdhocFixture
            ? { KESTREL_UNINSTALL_TEST_ALLOW_ADHOC: "1" }
            : {}),
        },
      },
    );
    assert.equal(run.status, 0, run.stdout);
    assert.equal(existsSync(bundlePath), false);
    assert.equal(
      existsSync(path.join(fixtureRoot, "Trash", "Kestrel.app")),
      true,
    );
    assert.equal(existsSync(profilePath), false);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      status: string;
      removedTargets: string[];
    };
    assert.equal(report.status, "complete");
    assert.deepEqual(report.removedTargets, [
      "desktop.bundle",
      "desktop.profile",
      "desktop.cache",
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

contractTest("desktop.hermetic", "Desktop uninstall helper refuses mismatched, ad-hoc, and symlink bundles", () => {
  if (process.platform !== "darwin") return;
  const tempRoot = mkdtempSync(
    path.join("/tmp", "kestrel-desktop-helper-refusal-"),
  );
  try {
    mkdirSync(path.join(tempRoot, "module-cache"));
    const helperPath = path.join(tempRoot, "helper");
    compileDesktopHelper("/usr/bin/xcrun", tempRoot, helperPath, true);
    const fixtureRoot = path.join(tempRoot, "fixture");
    const bundlePath = path.join(fixtureRoot, "Applications", "Kestrel.app");
    const runnerEnvironment = {
      ...process.env,
      KESTREL_UNINSTALL_TEST_ROOT: fixtureRoot,
    };

    createSignedFixtureBundle(bundlePath, "com.example.foreign", "-");
    let planPath = path.join(tempRoot, "mismatched-plan.json");
    writeHelperPlan(planPath, "mismatched-bundle-fixture", [
      helperTarget("desktop.bundle", "desktop_bundle", bundlePath),
    ]);
    let run = spawnSync(helperPath, ["--plan", planPath], {
      encoding: "utf8",
      env: runnerEnvironment,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /bundle identifier is not com\.kestrel\.desktop/u);
    assert.equal(existsSync(bundlePath), true);

    rmSync(bundlePath, { recursive: true, force: true });
    createSignedFixtureBundle(bundlePath, "com.kestrel.desktop", "-");
    planPath = path.join(tempRoot, "adhoc-plan.json");
    writeHelperPlan(planPath, "adhoc-bundle-fixture", [
      helperTarget("desktop.bundle", "desktop_bundle", bundlePath),
    ]);
    run = spawnSync(helperPath, ["--plan", planPath], {
      encoding: "utf8",
      env: runnerEnvironment,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /not a verified release-signed build/u);
    assert.equal(existsSync(bundlePath), true);

    const foreignBundlePath = path.join(tempRoot, "Foreign.app");
    createSignedFixtureBundle(
      foreignBundlePath,
      "com.kestrel.desktop",
      "-",
    );
    rmSync(bundlePath, { recursive: true, force: true });
    symlinkSync(foreignBundlePath, bundlePath);
    planPath = path.join(tempRoot, "symlink-plan.json");
    writeHelperPlan(planPath, "symlink-bundle-fixture", [
      helperTarget("desktop.bundle", "desktop_bundle", bundlePath),
    ]);
    run = spawnSync(helperPath, ["--plan", planPath], {
      encoding: "utf8",
      env: runnerEnvironment,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /refusing symlink target/u);
    assert.equal(existsSync(foreignBundlePath), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function compileDesktopHelper(
  swiftc: string,
  tempRoot: string,
  helperPath: string,
  testing = false,
): void {
  execFileSync(
    swiftc,
    [
      "swiftc",
      "-module-cache-path",
      path.join(tempRoot, "module-cache"),
      "-target",
      "arm64-apple-macosx13.0",
      ...(testing ? ["-D", "KESTREL_UNINSTALL_TESTING"] : []),
      path.join(
        repoRoot,
        "apps",
        "desktop",
        "native",
        "kestrel-uninstall-helper.swift",
      ),
      "-o",
      helperPath,
    ],
    { stdio: "pipe" },
  );
}

function findDeveloperIdApplicationIdentity(): string | undefined {
  let output: string;
  try {
    output = execFileSync(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8" },
    );
  } catch {
    return undefined;
  }
  return output.match(/"((?:Developer ID Application:)[^"]+)"/u)?.[1];
}

function createSignedFixtureBundle(
  bundlePath: string,
  bundleIdentifier: string,
  identity: string,
): void {
  const contentsPath = path.join(bundlePath, "Contents");
  const executablePath = path.join(contentsPath, "MacOS", "Kestrel");
  mkdirSync(path.dirname(executablePath), { recursive: true });
  copyFileSync("/usr/bin/true", executablePath);
  chmodSync(executablePath, 0o755);
  writeFileSync(
    path.join(contentsPath, "Info.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\"><dict>",
      `<key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>`,
      "<key>CFBundleExecutable</key><string>Kestrel</string>",
      "<key>CFBundlePackageType</key><string>APPL</string>",
      "</dict></plist>",
    ].join(""),
    "utf8",
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--sign", identity, "--timestamp=none", bundlePath],
    { stdio: "pipe" },
  );
}

function tryCreateSignedFixtureBundle(
  bundlePath: string,
  bundleIdentifier: string,
  identity: string,
): boolean {
  try {
    createSignedFixtureBundle(bundlePath, bundleIdentifier, identity);
    return true;
  } catch {
    return false;
  }
}

function helperTarget(id: string, kind: string, targetPath: string) {
  return {
    id,
    kind,
    path: targetPath,
    selected: true,
  };
}

function writeHelperPlan(
  planPath: string,
  planId: string,
  targets: readonly ReturnType<typeof helperTarget>[],
): void {
  writeFileSync(
    planPath,
    JSON.stringify({
      version: "kestrel_uninstall_plan_v1",
      planId,
      initiator: "desktop",
      targets,
    }),
    { mode: 0o600 },
  );
}
