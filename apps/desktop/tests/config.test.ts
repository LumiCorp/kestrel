import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveDesktopLibexecRoot,
  resolveDesktopPathConfig,
} from "../src/config.js";

test("resolveDesktopLibexecRoot points packaged Local Core bootstrap at bundled runtime sources", () => {
  assert.equal(resolveDesktopLibexecRoot({
    isPackaged: true,
    repoRoot: "/Applications/Kestrel.app/Contents/Resources/kestrel-repo",
  }), "/Applications/Kestrel.app/Contents/Resources/kestrel-repo");
  assert.equal(resolveDesktopLibexecRoot({
    currentValue: " /custom/kestrel/libexec ",
    isPackaged: true,
    repoRoot: "/Applications/Kestrel.app/Contents/Resources/kestrel-repo",
  }), "/custom/kestrel/libexec");
  assert.equal(resolveDesktopLibexecRoot({
    isPackaged: false,
    repoRoot: "/workspace/kestrel",
  }), undefined);
});

test("resolveDesktopPathConfig uses repo-relative paths in development", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "kestrel-desktop-config-"));
  const stateRoot = path.join("/tmp/kestrel-user", "state", "0.6");
  try {
    writeFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    const config = resolveDesktopPathConfig({
      cwd: path.join(repoRoot, "apps", "desktop"),
      userDataPath: "/tmp/kestrel-user",
      isPackaged: false,
    });

    assert.equal(config.repoRoot, repoRoot);
    assert.equal(config.bootHtmlPath, path.join(repoRoot, "apps", "desktop", "static", "boot.html"));
    assert.equal(config.rendererHtmlPath, path.join(repoRoot, "apps", "desktop", "static", "renderer", "index.html"));
    assert.equal(config.runtimeLogPath, path.join(stateRoot, "core", "logs", "desktop-runtime.log"));
    assert.equal(config.runtimeHomePath, "/tmp/kestrel-user");
    assert.equal(config.postgresDataPath, path.join(stateRoot, "core", "postgres", "data"));
    assert.equal(config.postgresLogPath, path.join(stateRoot, "core", "logs", "desktop-postgres.log"));
    assert.equal(config.postgresMetadataPath, path.join(stateRoot, "core", "postgres", "metadata.json"));
    assert.equal(config.isPackaged, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveDesktopPathConfig uses packaged resource paths in production", () => {
  const resourcesPath = "/Applications/Kestrel.app/Contents/Resources";
  const stateRoot = path.join("/tmp/kestrel-user", "state", "0.6");
  const config = resolveDesktopPathConfig({
    cwd: "/ignored",
    resourcesPath,
    userDataPath: "/tmp/kestrel-user",
    isPackaged: true,
  });

  assert.equal(config.repoRoot, path.join(resourcesPath, "kestrel-repo"));
  assert.equal(config.bootHtmlPath, path.join(resourcesPath, "static", "boot.html"));
  assert.equal(config.rendererHtmlPath, path.join(resourcesPath, "static", "renderer", "index.html"));
  assert.equal(config.runtimeLogPath, path.join(stateRoot, "core", "logs", "desktop-runtime.log"));
  assert.equal(config.runtimeHomePath, "/tmp/kestrel-user");
  assert.equal(config.postgresDataPath, path.join(stateRoot, "core", "postgres", "data"));
  assert.equal(config.postgresLogPath, path.join(stateRoot, "core", "logs", "desktop-postgres.log"));
  assert.equal(config.postgresMetadataPath, path.join(stateRoot, "core", "postgres", "metadata.json"));
  assert.equal(config.isPackaged, true);
});

test("resolveDesktopPathConfig can root shell state in Kestrel Local Core", () => {
  const resourcesPath = "/Applications/Kestrel.app/Contents/Resources";
  const localCoreHomePath = "/tmp/kestrel-core";
  const stateRoot = path.join(localCoreHomePath, "state", "0.6");
  const config = resolveDesktopPathConfig({
    cwd: "/ignored",
    resourcesPath,
    userDataPath: "/tmp/kestrel-user",
    localCoreHomePath,
    isPackaged: true,
  });

  assert.equal(config.runtimeHomePath, localCoreHomePath);
  assert.equal(config.runtimeLogPath, path.join(stateRoot, "core", "logs", "desktop-runtime.log"));
  assert.equal(config.settingsPath, path.join(stateRoot, "settings", "desktop-settings.json"));
  assert.equal(config.projectRunLedgerPath, path.join(stateRoot, "workspaces", "desktop-project-runs.json"));
  assert.equal(config.postgresDataPath, path.join(stateRoot, "core", "postgres", "data"));
  assert.equal(config.postgresLogPath, path.join(stateRoot, "core", "logs", "desktop-postgres.log"));
  assert.equal(config.postgresMetadataPath, path.join(stateRoot, "core", "postgres", "metadata.json"));
});
