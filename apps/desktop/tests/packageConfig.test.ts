import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { resolveDesktopPackagerConfig } from "../src/packageConfig.js";

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
        ? "kestrel-head.icns"
        : process.platform === "win32"
          ? "kestrel-head.ico"
          : "kestrel-head.png",
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
    path.join("/tmp/kestrel-repo", "apps", "desktop", "assets", "kestrel-head.icns"),
  );
});

test("resolveDesktopPackagerConfig selects native Windows and Linux icon formats", () => {
  const repoRoot = "/tmp/kestrel-repo";

  assert.equal(
    resolveDesktopPackagerConfig({ repoRoot, platform: "win32" }).iconPath,
    path.join(repoRoot, "apps", "desktop", "assets", "kestrel-head.ico"),
  );
  assert.equal(
    resolveDesktopPackagerConfig({ repoRoot, platform: "linux" }).iconPath,
    path.join(repoRoot, "apps", "desktop", "assets", "kestrel-head.png"),
  );
});
