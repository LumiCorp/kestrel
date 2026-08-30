import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserRuntimeSourceDirectory,
  ensureVerifiedBrowserRuntimeSourceAsset,
  stageBrowserRuntimeSourceAssets,
} from "../../scripts/browser-runtime-source-assets.js";
import { parseBrowserRuntimeSourceTarget } from "../../scripts/stage-browser-runtime-sources.js";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../src/browser/runtimeReleaseManifest.js";

test("Browser runtime manifest pins exact HTTPS sources and SHA-256 digests for both builds", () => {
  for (const [target, release] of Object.entries(
    BROWSER_RUNTIME_RELEASE_MANIFEST.targets,
  )) {
    for (const asset of [release.engine, release.chrome]) {
      assert.equal(new URL(asset.url).protocol, "https:", `${target} URL`);
      assert.match(asset.sha256, /^[a-f0-9]{64}$/u, `${target} SHA-256`);
      assert.equal(asset.sourceFileName, path.basename(asset.sourceFileName));
    }
  }
  assert.equal(BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision, "v0.35.0");
  assert.equal(
    BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
    "152.0.7977.54",
  );
  assert.deepEqual(
    Object.values(BROWSER_RUNTIME_RELEASE_MANIFEST.targets).map((release) => [
      release.engine.url,
      release.chrome.url,
    ]),
    [
      [
        "https://github.com/vercel-labs/agent-browser/releases/download/v0.35.0/agent-browser-darwin-arm64",
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.54/mac-arm64/chrome-mac-arm64.zip",
      ],
      [
        "https://github.com/vercel-labs/agent-browser/releases/download/v0.35.0/agent-browser-linux-x64",
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.54/linux64/chrome-linux64.zip",
      ],
    ],
  );
});

test("Browser runtime staging uses the exact hosted target directory and fails closed", () => {
  const repoRoot = mkdtempSync(
    path.join(os.tmpdir(), "kestrel-browser-runtime-stage-"),
  );
  const release = BROWSER_RUNTIME_RELEASE_MANIFEST.targets["linux-x64"];
  const requested: string[] = [];
  try {
    assert.throws(
      () =>
        stageBrowserRuntimeSourceAssets(repoRoot, "linux-x64", {
          download(url, destinationPath) {
            requested.push(url);
            writeFileSync(destinationPath, "wrong", "utf8");
          },
        }),
      /digest mismatch/u,
    );
    assert.deepEqual(requested, [release.engine.url]);
    assert.equal(
      browserRuntimeSourceDirectory(repoRoot, "linux-x64"),
      path.join(
        repoRoot,
        "deploy/fly/kestrel-one-browser-worker/runtime/linux-x64",
      ),
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Browser runtime source acquisition reuses verified bytes and preserves them on failure", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "kestrel-browser-runtime-source-"),
  );
  const filePath = path.join(root, "agent-browser");
  const bytes = Buffer.from("verified-runtime-source", "utf8");
  const asset = {
    url: "https://downloads.example.test/agent-browser",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceFileName: "agent-browser",
  };
  let downloads = 0;
  try {
    ensureVerifiedBrowserRuntimeSourceAsset(filePath, asset, (_url, output) => {
      downloads += 1;
      writeFileSync(output, bytes);
    });
    ensureVerifiedBrowserRuntimeSourceAsset(filePath, asset, () => {
      downloads += 1;
    });
    assert.equal(downloads, 1);

    assert.throws(
      () =>
        ensureVerifiedBrowserRuntimeSourceAsset(
          filePath,
          { ...asset, sha256: "0".repeat(64) },
          (_url, output) => writeFileSync(output, "wrong", "utf8"),
        ),
      /digest mismatch/u,
    );
    assert.deepEqual(readFileSync(filePath), bytes);
    assert.deepEqual(readdirSync(root), ["agent-browser"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Browser runtime source acquisition fails closed when the download is missing", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "kestrel-browser-runtime-missing-"),
  );
  try {
    assert.throws(
      () =>
        ensureVerifiedBrowserRuntimeSourceAsset(
          path.join(root, "agent-browser"),
          {
            url: "https://downloads.example.test/agent-browser",
            sha256: "0".repeat(64),
            sourceFileName: "agent-browser",
          },
          () => undefined,
        ),
      /produced no regular file/u,
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Browser runtime staging rejects unsupported targets and non-HTTPS sources", () => {
  assert.equal(parseBrowserRuntimeSourceTarget("darwin-arm64"), "darwin-arm64");
  assert.equal(parseBrowserRuntimeSourceTarget("linux-x64"), "linux-x64");
  assert.throws(() => parseBrowserRuntimeSourceTarget("linux-arm64"), /Usage/u);

  const root = mkdtempSync(
    path.join(os.tmpdir(), "kestrel-browser-runtime-http-"),
  );
  try {
    assert.throws(
      () =>
        ensureVerifiedBrowserRuntimeSourceAsset(path.join(root, "asset"), {
          url: "http://downloads.example.test/asset",
          sha256: "0".repeat(64),
          sourceFileName: "asset",
        }),
      /must use HTTPS/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
