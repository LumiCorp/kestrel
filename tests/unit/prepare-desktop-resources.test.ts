import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkDesktopResourceDrift,
  shouldCopyDesktopResourceEntry,
} from "../../scripts/prepare-desktop-resources.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "shouldCopyDesktopResourceEntry excludes local env and generated output files", () => {
  assert.equal(shouldCopyDesktopResourceEntry("/tmp/repo/apps/web/.env"), false);
  assert.equal(shouldCopyDesktopResourceEntry("/tmp/repo/apps/web/.env.local"), false);
  assert.equal(shouldCopyDesktopResourceEntry("/tmp/repo/apps/web/.env.example"), false);
  assert.equal(shouldCopyDesktopResourceEntry("/tmp/repo/apps/web/.next"), false);
  assert.equal(shouldCopyDesktopResourceEntry("/tmp/repo/apps/web/node_modules"), false);
  assert.equal(shouldCopyDesktopResourceEntry("/tmp/repo/apps/web/app/page.tsx"), true);
});

contractTest("runtime.hermetic", "checkDesktopResourceDrift skips absent generated resources", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-desktop-drift-"));
  try {
    mkdirSync(path.join(tempDir, "repo", "agents"), { recursive: true });
    writeFileSync(path.join(tempDir, "repo", "agents", "runtime.ts"), "source\n", "utf8");

    const result = checkDesktopResourceDrift({
      repoRoot: path.join(tempDir, "repo"),
      desktopResourcesDir: path.join(tempDir, "repo", "apps", "desktop", "resources", "kestrel-repo"),
      criticalPaths: ["agents"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "checkDesktopResourceDrift reports stale generated resources", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-desktop-drift-"));
  try {
    const repoRoot = path.join(tempDir, "repo");
    const resourcesDir = path.join(repoRoot, "apps", "desktop", "resources", "kestrel-repo");
    mkdirSync(path.join(repoRoot, "agents"), { recursive: true });
    mkdirSync(path.join(resourcesDir, "agents"), { recursive: true });
    writeFileSync(path.join(repoRoot, "agents", "runtime.ts"), "source\n", "utf8");
    writeFileSync(path.join(resourcesDir, "agents", "runtime.ts"), "stale\n", "utf8");

    const result = checkDesktopResourceDrift({
      repoRoot,
      desktopResourcesDir: resourcesDir,
      criticalPaths: ["agents"],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.stalePaths, ["agents/runtime.ts"]);
    assert.match(result.message, /prepare:resources/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
