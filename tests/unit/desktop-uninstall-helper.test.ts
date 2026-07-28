import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(source, /com\.kestrel\.desktop/u);
  assert.match(source, /Signature=adhoc/u);
  assert.match(source, /Developer ID Application:/u);
  assert.match(source, /trashItem/u);
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
