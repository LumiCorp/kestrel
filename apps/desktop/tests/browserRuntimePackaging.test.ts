import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DESKTOP_BROWSER_RUNTIME_RECEIPT_NAME,
  createDesktopBrowserRuntimeReceipt,
  desktopBrowserRuntimeSpec,
  ensureVerifiedSourceAsset,
  prepareDesktopBrowserRuntimeAssets,
  verifyDesktopBrowserRuntimeDirectory,
  type DesktopBrowserRuntimeSignatureVerifier,
  type DesktopBrowserRuntimeSpec,
} from "../../../scripts/desktop-browser-runtime-assets.js";
import {
  BROWSER_RUNTIME_RELEASE_MANIFEST,
  DESKTOP_BROWSER_RUNTIME_TARGET,
  getDesktopBrowserRuntimeExecutableRelativePaths,
} from "../../../src/browser/runtimeReleaseManifest.js";

const MACH_O_ARM64_HEADER = Buffer.from([
  0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const TEST_SIGNING_AUTHORITY =
  "Developer ID Application: Kestrel Test (TESTTEAM01)";

function fixtureSpec(): DesktopBrowserRuntimeSpec {
  return {
    manifestVersion: "test-manifest-v1",
    target: "darwin-arm64",
    engineRevision: "engine-test",
    chromeRevision: "chrome-test",
    engine: {
      source: { kind: "https", url: "https://example.test/agent-browser" },
      sha256: "a".repeat(64),
      sourceFileName: "agent-browser",
      executableRelativePath: "agent-browser",
    },
    chrome: {
      source: { kind: "https", url: "https://example.test/chrome.zip" },
      sha256: "b".repeat(64),
      sourceFileName: "chrome.zip",
      archiveRoot: "chrome",
      executableRelativePath: "chrome/Chrome.app/Contents/MacOS/Chrome",
      excludedRuntimeRelativePaths: ["chrome/installer.sh"],
    },
  };
}

function createRuntimeFixture(): {
  root: string;
  spec: DesktopBrowserRuntimeSpec;
  enginePath: string;
  chromePath: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "kestrel-browser-runtime-test-"));
  const spec = fixtureSpec();
  const enginePath = path.join(root, spec.engine.executableRelativePath);
  const chromePath = path.join(root, spec.chrome.executableRelativePath);
  mkdirSync(path.dirname(chromePath), { recursive: true });
  writeFileSync(enginePath, "engine-v1", "utf8");
  writeFileSync(chromePath, "chrome-v1", "utf8");
  chmodSync(enginePath, 0o755);
  chmodSync(chromePath, 0o755);
  const receipt = createDesktopBrowserRuntimeReceipt(root, spec);
  writeFileSync(
    path.join(root, DESKTOP_BROWSER_RUNTIME_RECEIPT_NAME),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  return { root, spec, enginePath, chromePath };
}

test("Desktop Browser release stays explicitly darwin-arm64 while retaining hosted linux", () => {
  assert.equal(DESKTOP_BROWSER_RUNTIME_TARGET, "darwin-arm64");
  assert.deepEqual(Object.keys(BROWSER_RUNTIME_RELEASE_MANIFEST.targets), [
    "darwin-arm64",
    "linux-x64",
  ]);
  assert.deepEqual(getDesktopBrowserRuntimeExecutableRelativePaths(), {
    engineExecutablePath: "browser-runtime/agent-browser",
    chromeExecutablePath:
      "browser-runtime/chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  });
  const spec = desktopBrowserRuntimeSpec();
  for (const asset of [spec.engine, spec.chrome]) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
    if (asset.source.kind === "https") {
      assert.match(asset.source.url, /^https:\/\//u);
      assert.doesNotMatch(asset.source.url, /latest/iu);
    } else {
      assert.equal(path.isAbsolute(asset.source.relativePath), false);
    }
  }
  assert.deepEqual(spec.chrome.excludedRuntimeRelativePaths, [
    "chrome/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/152.0.7977.54/Resources/install.sh",
  ]);
});

test("Desktop Browser runtime receipt binds every packaged file and exact source identity", () => {
  const fixture = createRuntimeFixture();
  try {
    const receipt = verifyDesktopBrowserRuntimeDirectory(fixture.root, fixture.spec);
    assert.equal(receipt.acquisition, "verified_at_package_time");
    assert.equal(receipt.executableResolution, "explicit_packaged_paths_only");
    assert.deepEqual(receipt.sources, {
      engine: {
        source: fixture.spec.engine.source,
        sha256: fixture.spec.engine.sha256,
        sourceFileName: fixture.spec.engine.sourceFileName,
      },
      chrome: {
        source: fixture.spec.chrome.source,
        sha256: fixture.spec.chrome.sha256,
        sourceFileName: fixture.spec.chrome.sourceFileName,
      },
    });
    assert.equal(receipt.files.length, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Desktop Browser runtime verification fails closed on wrong, missing, or extra assets", () => {
  const wrong = createRuntimeFixture();
  try {
    writeFileSync(wrong.enginePath, "tampered", "utf8");
    assert.throws(
      () => verifyDesktopBrowserRuntimeDirectory(wrong.root, wrong.spec),
      /does not match its pinned manifest/u,
    );
  } finally {
    rmSync(wrong.root, { recursive: true, force: true });
  }

  const missing = createRuntimeFixture();
  try {
    rmSync(missing.chromePath);
    assert.throws(
      () => verifyDesktopBrowserRuntimeDirectory(missing.root, missing.spec),
      /executable is missing/u,
    );
  } finally {
    rmSync(missing.root, { recursive: true, force: true });
  }

  const extra = createRuntimeFixture();
  try {
    writeFileSync(path.join(extra.root, "unmanifested-installer"), "unexpected", "utf8");
    assert.throws(
      () => verifyDesktopBrowserRuntimeDirectory(extra.root, extra.spec),
      /does not match its pinned manifest/u,
    );
  } finally {
    rmSync(extra.root, { recursive: true, force: true });
  }
});

test("Desktop packaging rejects absent and wrong-digest source assets before extraction", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "kestrel-browser-source-test-"));
  try {
    assert.throws(
      () => prepareDesktopBrowserRuntimeAssets(repoRoot, {
        download(_url, destinationPath) {
          writeFileSync(destinationPath, "wrong", "utf8");
        },
      }),
      /repository asset is missing/u,
    );
    const spec = desktopBrowserRuntimeSpec();
    const sourceRoot = path.join(
      repoRoot,
      "apps",
      "desktop",
      "resources",
      "browser-runtime-sources",
      spec.target,
    );
    assert.equal(spec.engine.source.kind, "repository");
    if (spec.engine.source.kind !== "repository") {
      throw new Error("Desktop engine fixture must use a repository source.");
    }
    const repositoryEnginePath = path.join(
      repoRoot,
      spec.engine.source.relativePath,
    );
    mkdirSync(path.dirname(repositoryEnginePath), { recursive: true });
    writeFileSync(repositoryEnginePath, "wrong", "utf8");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(path.join(sourceRoot, spec.engine.sourceFileName), "wrong", "utf8");
    writeFileSync(path.join(sourceRoot, spec.chrome.sourceFileName), "wrong", "utf8");
    assert.throws(
      () => prepareDesktopBrowserRuntimeAssets(repoRoot, {
        download(_url, destinationPath) {
          writeFileSync(destinationPath, "still-wrong", "utf8");
        },
      }),
      /digest mismatch/u,
    );
    assert.equal(
      readFileSync(path.join(sourceRoot, spec.engine.sourceFileName), "utf8"),
      "wrong",
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Desktop packaging acquires exact manifest URLs only when cached sources are absent or invalid", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kestrel-browser-acquisition-test-"));
  const filePath = path.join(root, "agent-browser");
  const bytes = Buffer.from("pinned-browser-source", "utf8");
  const asset = {
    source: {
      kind: "https" as const,
      url: "https://downloads.example.test/agent-browser-v1",
    },
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceFileName: "agent-browser",
    executableRelativePath: "agent-browser",
  };
  const requests: string[] = [];
  const download = (url: string, destinationPath: string): void => {
    requests.push(url);
    writeFileSync(destinationPath, bytes);
  };
  try {
    ensureVerifiedSourceAsset(filePath, asset, download);
    ensureVerifiedSourceAsset(filePath, asset, download);
    assert.deepEqual(requests, [asset.source.url]);
    writeFileSync(filePath, "invalid-cache", "utf8");
    ensureVerifiedSourceAsset(filePath, asset, download);
    assert.deepEqual(requests, [asset.source.url, asset.source.url]);
    assert.deepEqual(readFileSync(filePath), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop Browser runtime refuses non-executable pinned paths", () => {
  const fixture = createRuntimeFixture();
  try {
    chmodSync(fixture.enginePath, 0o644);
    assert.throws(
      () => verifyDesktopBrowserRuntimeDirectory(fixture.root, fixture.spec),
      /is not executable/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Desktop Browser verification never forgives native executable digest changes", () => {
  const fixture = createRuntimeFixture();
  try {
    writeFileSync(fixture.enginePath, MACH_O_ARM64_HEADER);
    writeFileSync(fixture.chromePath, MACH_O_ARM64_HEADER);
    const receipt = createDesktopBrowserRuntimeReceipt(fixture.root, fixture.spec);
    writeFileSync(
      path.join(fixture.root, DESKTOP_BROWSER_RUNTIME_RECEIPT_NAME),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    assert.equal(receipt.files.every((entry) => entry.nativeExecutable === true), true);
    appendFileSync(fixture.enginePath, "signed-or-tampered");
    assert.throws(
      () => verifyDesktopBrowserRuntimeDirectory(fixture.root, fixture.spec),
      /Native executable hashes must remain exact/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("signed Desktop Browser verification requires native signatures and the final bundle seal", () => {
  const fixture = createRuntimeFixture();
  try {
    writeFileSync(fixture.enginePath, MACH_O_ARM64_HEADER);
    writeFileSync(fixture.chromePath, MACH_O_ARM64_HEADER);
    const receipt = createDesktopBrowserRuntimeReceipt(fixture.root, fixture.spec);
    writeFileSync(
      path.join(fixture.root, DESKTOP_BROWSER_RUNTIME_RECEIPT_NAME),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );

    appendFileSync(fixture.enginePath, "replacement-native-bytes");
    appendFileSync(fixture.chromePath, "signed-native-bytes");
    const chromeSignatureRoot = path.join(
      fixture.root,
      "chrome",
      "Chrome.app",
      "Contents",
      "_CodeSignature",
    );
    mkdirSync(chromeSignatureRoot, { recursive: true });
    writeFileSync(
      path.join(chromeSignatureRoot, "CodeResources"),
      "generated-signature-metadata",
      "utf8",
    );

    const unsignedNative = mockSignatureVerifier({ nativeValid: false });
    assert.throws(
      () =>
        verifyDesktopBrowserRuntimeDirectory(fixture.root, fixture.spec, {
          mode: "signed-release",
          appPath: "/Applications/Kestrel.app",
          expectedSigningAuthority: TEST_SIGNING_AUTHORITY,
          signatureVerifier: unsignedNative,
        }),
      /native executable failed signature or identity verification/u,
    );

    const unsealedBundle = mockSignatureVerifier({ bundleSealValid: false });
    assert.throws(
      () =>
        verifyDesktopBrowserRuntimeDirectory(fixture.root, fixture.spec, {
          mode: "signed-release",
          appPath: "/Applications/Kestrel.app",
          expectedSigningAuthority: TEST_SIGNING_AUTHORITY,
          signatureVerifier: unsealedBundle,
        }),
      /resource-seal/u,
    );

    assert.doesNotThrow(() =>
      verifyDesktopBrowserRuntimeDirectory(fixture.root, fixture.spec, {
        mode: "signed-release",
        appPath: "/Applications/Kestrel.app",
        expectedSigningAuthority: TEST_SIGNING_AUTHORITY,
        signatureVerifier: mockSignatureVerifier(),
      })
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("signed Desktop Browser verification still exact-checks non-native payload files", () => {
  const fixture = createRuntimeFixture();
  try {
    writeFileSync(fixture.enginePath, MACH_O_ARM64_HEADER);
    writeFileSync(fixture.chromePath, MACH_O_ARM64_HEADER);
    const payloadPath = path.join(fixture.root, "chrome", "payload.dat");
    writeFileSync(payloadPath, "payload-v1", "utf8");
    const receipt = createDesktopBrowserRuntimeReceipt(fixture.root, fixture.spec);
    writeFileSync(
      path.join(fixture.root, DESKTOP_BROWSER_RUNTIME_RECEIPT_NAME),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(payloadPath, "payload-v2", "utf8");

    assert.throws(
      () =>
        verifyDesktopBrowserRuntimeDirectory(fixture.root, fixture.spec, {
          mode: "signed-release",
          appPath: "/Applications/Kestrel.app",
          expectedSigningAuthority: TEST_SIGNING_AUTHORITY,
          signatureVerifier: mockSignatureVerifier(),
        }),
      /does not match its pinned manifest/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function mockSignatureVerifier(
  overrides: {
    nativeValid?: boolean | undefined;
    bundleSealValid?: boolean | undefined;
  } = {},
): DesktopBrowserRuntimeSignatureVerifier {
  return {
    verifyApplicationBundle() {
      return {
        signatureValid: true,
        resourceSealValid: overrides.bundleSealValid ?? true,
        hardenedRuntime: true,
        authority: TEST_SIGNING_AUTHORITY,
      };
    },
    verifyNativeExecutable() {
      return {
        signatureValid: overrides.nativeValid ?? true,
        authority: TEST_SIGNING_AUTHORITY,
      };
    },
  };
}

test("Desktop Browser receipts reject excluded runtime installers", () => {
  const fixture = createRuntimeFixture();
  try {
    writeFileSync(path.join(fixture.root, "chrome", "installer.sh"), "install", "utf8");
    assert.throws(
      () => createDesktopBrowserRuntimeReceipt(fixture.root, fixture.spec),
      /contains excluded installer/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Desktop Browser receipts preserve contained framework symlinks and reject escapes", () => {
  const fixture = createRuntimeFixture();
  try {
    const frameworkRoot = path.join(fixture.root, "chrome", "Framework.framework");
    const versionRoot = path.join(frameworkRoot, "Versions", "1");
    mkdirSync(versionRoot, { recursive: true });
    writeFileSync(path.join(versionRoot, "Framework"), "framework", "utf8");
    symlinkSync("1", path.join(frameworkRoot, "Versions", "Current"));
    symlinkSync(
      "Versions/Current/Framework",
      path.join(frameworkRoot, "Framework"),
    );
    const receipt = createDesktopBrowserRuntimeReceipt(fixture.root, fixture.spec);
    assert.deepEqual(
      receipt.files
        .filter((entry) => entry.kind === "symlink")
        .map(({ path: entryPath, target }) => ({ path: entryPath, target })),
      [
        {
          path: "chrome/Framework.framework/Framework",
          target: "Versions/Current/Framework",
        },
        {
          path: "chrome/Framework.framework/Versions/Current",
          target: "1",
        },
      ],
    );
    rmSync(path.join(frameworkRoot, "Framework"));
    symlinkSync("/tmp/outside-kestrel-browser-runtime", path.join(frameworkRoot, "Framework"));
    assert.throws(
      () => createDesktopBrowserRuntimeReceipt(fixture.root, fixture.spec),
      /symlink escapes its resource root/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
