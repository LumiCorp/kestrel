import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
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

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("Browser runtime manifest pins exact immutable sources and SHA-256 digests for both builds", () => {
  for (const [target, release] of Object.entries(
    BROWSER_RUNTIME_RELEASE_MANIFEST.targets,
  )) {
    for (const asset of [release.engine, release.chrome]) {
      if (asset.source.kind === "https") {
        assert.equal(new URL(asset.source.url).protocol, "https:", `${target} URL`);
      } else {
        assert.equal(path.isAbsolute(asset.source.relativePath), false);
        assert.doesNotMatch(asset.source.relativePath, /(?:^|\/)\.\.(?:\/|$)/u);
      }
      assert.match(asset.sha256, /^[a-f0-9]{64}$/u, `${target} SHA-256`);
      assert.equal(asset.sourceFileName, path.basename(asset.sourceFileName));
    }
  }
  assert.equal(
    BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
    "v0.35.0-kestrel.1",
  );
  assert.equal(
    BROWSER_RUNTIME_RELEASE_MANIFEST.engine.upstreamRevision,
    "585e740fcef069d74e21f0e88e8bf4ea7df34385",
  );
  assert.equal(
    BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
    "152.0.7977.54",
  );
  assert.deepEqual(
    Object.values(BROWSER_RUNTIME_RELEASE_MANIFEST.targets).map((release) => [
      release.engine.source,
      release.chrome.source,
    ]),
    [
      [
        {
          kind: "repository",
          relativePath:
            "third_party/agent-browser/v0.35.0-kestrel.1/agent-browser-darwin-arm64",
        },
        {
          kind: "https",
          url: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.54/mac-arm64/chrome-mac-arm64.zip",
        },
      ],
      [
        {
          kind: "repository",
          relativePath:
            "third_party/agent-browser/v0.35.0-kestrel.1/agent-browser-linux-x64",
        },
        {
          kind: "https",
          url: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.54/linux64/chrome-linux64.zip",
        },
      ],
    ],
  );
});

test("the repository-owned host runtime executes the patched local-name command", (t) => {
  const target = process.platform === "darwin" && process.arch === "arm64"
    ? "darwin-arm64"
    : process.platform === "linux" && process.arch === "x64"
      ? "linux-x64"
      : undefined;
  if (target === undefined) {
    t.skip(`no Browser v1 runtime target for ${process.platform}-${process.arch}`);
    return;
  }
  const source = BROWSER_RUNTIME_RELEASE_MANIFEST.targets[target].engine.source;
  assert.equal(source.kind, "repository");
  const executable = path.join(repoRoot, source.relativePath);
  const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "agent-browser 0.35.0-kestrel.1");

  const command = spawnSync(
    executable,
    ["--json", "get", "local-name"],
    { encoding: "utf8" },
  );
  assert.equal(command.status, 1);
  const response = JSON.parse(command.stdout) as {
    success?: unknown;
    error?: unknown;
  };
  assert.equal(response.success, false);
  assert.match(String(response.error), /get local-name <selector>/u);
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
      /repository asset is missing/u,
    );
    assert.deepEqual(requested, []);
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
    source: {
      kind: "https" as const,
      url: "https://downloads.example.test/agent-browser",
    },
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceFileName: "agent-browser",
  };
  let downloads = 0;
  try {
    ensureVerifiedBrowserRuntimeSourceAsset(root, filePath, asset, (_url, output) => {
      downloads += 1;
      writeFileSync(output, bytes);
    });
    ensureVerifiedBrowserRuntimeSourceAsset(root, filePath, asset, () => {
      downloads += 1;
    });
    assert.equal(downloads, 1);

    assert.throws(
      () =>
        ensureVerifiedBrowserRuntimeSourceAsset(
          root,
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
          root,
          path.join(root, "agent-browser"),
          {
            source: {
              kind: "https",
              url: "https://downloads.example.test/agent-browser",
            },
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

test("Browser runtime source acquisition copies only a digest-matched repository asset", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "kestrel-browser-runtime-repository-"),
  );
  const bytes = Buffer.from("kestrel-built-agent-browser", "utf8");
  const relativePath = "third_party/agent-browser/test/agent-browser";
  const sourcePath = path.join(root, relativePath);
  const destinationPath = path.join(root, "staged", "agent-browser");
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, bytes);
  try {
    ensureVerifiedBrowserRuntimeSourceAsset(root, destinationPath, {
      source: { kind: "repository", relativePath },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceFileName: "agent-browser",
    });
    assert.deepEqual(readFileSync(destinationPath), bytes);
    assert.throws(
      () =>
        ensureVerifiedBrowserRuntimeSourceAsset(root, destinationPath, {
          source: { kind: "repository", relativePath: "../outside" },
          sha256: "0".repeat(64),
          sourceFileName: "agent-browser",
        }),
      /must stay inside the repository/u,
    );
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
        ensureVerifiedBrowserRuntimeSourceAsset(root, path.join(root, "asset"), {
          source: {
            kind: "https",
            url: "http://downloads.example.test/asset",
          },
          sha256: "0".repeat(64),
          sourceFileName: "asset",
        }),
      /must use HTTPS/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
