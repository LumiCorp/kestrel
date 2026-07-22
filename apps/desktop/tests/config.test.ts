import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveDesktopLibexecRoot,
  resolveDesktopPathConfig,
} from "../src/config.js";
import { parseDesktopAttachmentImportInput, parseDesktopAttachmentThreadId } from "../src/attachmentInput.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "resolveDesktopLibexecRoot points Local Core bootstrap at the active Desktop runtime sources", () => {
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
  }), "/workspace/kestrel");
});

contractTest("desktop.hermetic", "attachment thread input requires a complete canonical Desktop thread ID", () => {
  assert.equal(
    parseDesktopAttachmentThreadId(" thread-main:session-1 "),
    "thread-main:session-1",
  );
  for (const value of [undefined, "", "thread-main:", "thread-main:   ", "session-1"]) {
    assert.throws(
      () => parseDesktopAttachmentThreadId(value),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "desktop.invalid_attachment_thread",
    );
  }
});

contractTest("desktop.hermetic", "attachment import input validates the complete Local Core payload", () => {
  assert.deepEqual(parseDesktopAttachmentImportInput({
    threadId: "thread-main:session-1",
    filename: "evidence.txt",
    mimeType: "text/plain",
    data: "aGVsbG8=",
    sha256: "A".repeat(64),
  }), {
    threadId: "thread-main:session-1",
    filename: "evidence.txt",
    mimeType: "text/plain",
    data: "aGVsbG8=",
    sha256: "a".repeat(64),
  });
  assert.throws(() => parseDesktopAttachmentImportInput({
    threadId: "session-1",
    filename: "evidence.txt",
    data: "aGVsbG8=",
  }));
  assert.throws(() => parseDesktopAttachmentImportInput({
    threadId: "thread-main:session-1",
    filename: "evidence.txt",
    data: "aGVsbG8=",
    extra: true,
  }));
  assert.throws(() => parseDesktopAttachmentImportInput({
    threadId: "thread-main:session-1",
    filename: "evidence.txt",
    data: "not base64",
  }));
  assert.throws(() => parseDesktopAttachmentImportInput({
    threadId: "thread-main:session-1",
    filename: "evidence.txt",
    data: "aGVsbG8=",
    sha256: "abc123",
  }));
});

contractTest("desktop.hermetic", "resolveDesktopPathConfig uses repo-relative paths in development", () => {
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
    assert.equal(config.iconPath, path.join(repoRoot, "apps", "desktop", "assets", "kestrel-head.png"));
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

contractTest("desktop.hermetic", "resolveDesktopPathConfig falls back to the Electron app path in development", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "kestrel-desktop-config-"));
  try {
    writeFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    const config = resolveDesktopPathConfig({
      cwd: "/",
      appPath: path.join(repoRoot, "apps", "desktop"),
      userDataPath: "/tmp/kestrel-user",
      isPackaged: false,
    });

    assert.equal(config.repoRoot, repoRoot);
    assert.equal(config.rendererHtmlPath, path.join(repoRoot, "apps", "desktop", "static", "renderer", "index.html"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

contractTest("desktop.hermetic", "resolveDesktopPathConfig uses packaged resource paths in production", () => {
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
  assert.equal(config.iconPath, path.join(resourcesPath, "kestrel-head.png"));
  assert.equal(config.rendererHtmlPath, path.join(resourcesPath, "static", "renderer", "index.html"));
  assert.equal(config.runtimeLogPath, path.join(stateRoot, "core", "logs", "desktop-runtime.log"));
  assert.equal(config.runtimeHomePath, "/tmp/kestrel-user");
  assert.equal(config.postgresDataPath, path.join(stateRoot, "core", "postgres", "data"));
  assert.equal(config.postgresLogPath, path.join(stateRoot, "core", "logs", "desktop-postgres.log"));
  assert.equal(config.postgresMetadataPath, path.join(stateRoot, "core", "postgres", "metadata.json"));
  assert.equal(config.isPackaged, true);
});

contractTest("desktop.hermetic", "resolveDesktopPathConfig can root shell state in Kestrel Local Core", () => {
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
