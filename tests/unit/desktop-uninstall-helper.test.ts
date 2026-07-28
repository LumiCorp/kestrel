import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
  const source = readFileSync(
    path.join(repoRoot, "scripts", "package-desktop.ts"),
    "utf8",
  );

  assert.match(source, /prepareDesktopUninstallHelper/u);
  assert.match(source, /kestrel-uninstall-helper\.swift/u);
  assert.match(source, /extraResources/u);
  assert.match(source, /swiftc/u);
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
    swiftc = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" }).trim();
  } catch {
    return;
  }
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "kestrel-desktop-helper-test-"));
  try {
    const helperPath = path.join(tempRoot, "helper");
    const sourcePath = path.join(repoRoot, "apps", "desktop", "native", "kestrel-uninstall-helper.swift");
    try {
      execFileSync(swiftc, [sourcePath, "-o", helperPath], { stdio: "pipe" });
    } catch (error) {
      const output = error instanceof Error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : String(error);
      if (/unable to load standard library/u.test(output)) return;
      throw error;
    }

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
      initiator: "cli",
      targets: [],
    }));
    chmodSync(wrongInitiatorPlan, 0o600);
    run = spawnSync(helperPath, ["--plan", wrongInitiatorPlan], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /plan initiator must be desktop/u);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
