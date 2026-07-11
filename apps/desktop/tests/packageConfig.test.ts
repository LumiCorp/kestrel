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
});
