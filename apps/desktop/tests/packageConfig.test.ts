import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDesktopPackagerConfig } from "../src/packageConfig.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packagePreflightPath = path.join(testDir, "..", "..", "..", "scripts", "check-desktop-package.ts");
const desktopPackagePath = path.join(testDir, "..", "package.json");

test("resolveDesktopPackagerConfig defaults to the host platform and desktop staging paths", () => {
  const repoRoot = "/tmp/kestrel-repo";
  const config = resolveDesktopPackagerConfig({ repoRoot });

  assert.equal(config.appName, "Kestrel");
  assert.equal(config.executableName, "Kestrel");
  assert.equal(config.platform, process.platform);
  assert.equal(config.arch, process.arch);
  assert.equal(
    config.iconPath,
    path.join(
      repoRoot,
      "apps",
      "desktop",
      "assets",
      process.platform === "darwin"
        ? "kestrel-app-icon-light.icns"
        : process.platform === "win32"
          ? "kestrel-app-icon-light.ico"
          : "kestrel-app-icon-light.png",
    ),
  );
  assert.equal(config.stageDir, path.join(repoRoot, "apps", "desktop", ".desktop-package"));
  assert.equal(config.outDir, path.join(repoRoot, "apps", "desktop", "out"));
});

test("resolveDesktopPackagerConfig honors explicit platform and arch overrides", () => {
  const config = resolveDesktopPackagerConfig({
    repoRoot: "/tmp/kestrel-repo",
    platform: "darwin",
    arch: "arm64",
  });

  assert.equal(config.platform, "darwin");
  assert.equal(config.arch, "arm64");
  assert.equal(
    config.iconPath,
    path.join("/tmp/kestrel-repo", "apps", "desktop", "assets", "kestrel-app-icon-light.icns"),
  );
});

test("resolveDesktopPackagerConfig selects native Windows and Linux icon formats", () => {
  const repoRoot = "/tmp/kestrel-repo";

  assert.equal(
    resolveDesktopPackagerConfig({ repoRoot, platform: "win32" }).iconPath,
    path.join(repoRoot, "apps", "desktop", "assets", "kestrel-app-icon-light.ico"),
  );
  assert.equal(
    resolveDesktopPackagerConfig({ repoRoot, platform: "linux" }).iconPath,
    path.join(repoRoot, "apps", "desktop", "assets", "kestrel-app-icon-light.png"),
  );
});

test("Desktop packaging validates the Local Core payload manifest before returning an app", async () => {
  const [preflight, desktopPackage] = await Promise.all([
    readFile(packagePreflightPath, "utf8"),
    readFile(desktopPackagePath, "utf8"),
  ]);

  assert.match(preflight, /path\.join\(payloadRoot, "package\.json"\)/u);
  assert.match(desktopPackage, /"package:dir": "[^"]*desktop:package:preflight"/u);
  assert.match(desktopPackage, /"package": "[^"]*desktop:package:preflight"/u);
});
