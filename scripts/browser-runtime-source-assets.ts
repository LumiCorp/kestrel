import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import {
  getBrowserRuntimeRelease,
  type BrowserRuntimeTarget,
} from "../src/browser/runtimeReleaseManifest.js";

export interface BrowserRuntimeSourceAssetSpec {
  url: string;
  sha256: string;
  sourceFileName: string;
}

export interface StagedBrowserRuntimeSourceAssets {
  target: BrowserRuntimeTarget;
  sourceRoot: string;
  enginePath: string;
  chromePath: string;
}

export function browserRuntimeSourceDirectory(
  repoRoot: string,
  target: BrowserRuntimeTarget,
): string {
  switch (target) {
    case "darwin-arm64":
      return path.join(
        repoRoot,
        "apps",
        "desktop",
        "resources",
        "browser-runtime-sources",
        target,
      );
    case "linux-x64":
      return path.join(
        repoRoot,
        "deploy",
        "fly",
        "kestrel-one-browser-worker",
        "runtime",
        target,
      );
  }
}

export function stageBrowserRuntimeSourceAssets(
  repoRoot: string,
  target: BrowserRuntimeTarget,
  options: {
    download?: ((url: string, destinationPath: string) => void) | undefined;
  } = {},
): StagedBrowserRuntimeSourceAssets {
  const release = getBrowserRuntimeRelease(target);
  const sourceRoot = browserRuntimeSourceDirectory(repoRoot, target);
  const enginePath = resolveSourceAssetPath(sourceRoot, release.engine);
  const chromePath = resolveSourceAssetPath(sourceRoot, release.chrome);

  ensureVerifiedBrowserRuntimeSourceAsset(
    enginePath,
    release.engine,
    options.download,
  );
  ensureVerifiedBrowserRuntimeSourceAsset(
    chromePath,
    release.chrome,
    options.download,
  );

  return { target, sourceRoot, enginePath, chromePath };
}

export function ensureVerifiedBrowserRuntimeSourceAsset(
  filePath: string,
  asset: BrowserRuntimeSourceAssetSpec,
  download: (
    url: string,
    destinationPath: string,
  ) => void = downloadPinnedSourceAsset,
): void {
  if (
    existsSync(filePath) &&
    lstatSync(filePath).isFile() &&
    hashFile(filePath) === asset.sha256
  ) {
    return;
  }
  if (new URL(asset.url).protocol !== "https:") {
    throw new Error(
      `Pinned Browser runtime source asset must use HTTPS: ${asset.url}`,
    );
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.download`,
  );
  try {
    download(asset.url, temporaryPath);
    if (!existsSync(temporaryPath) || !lstatSync(temporaryPath).isFile()) {
      throw new Error(
        `Pinned Browser runtime source download produced no regular file: ${asset.url}`,
      );
    }
    const actual = hashFile(temporaryPath);
    if (actual !== asset.sha256) {
      throw new Error(
        `Pinned Browser runtime source asset digest mismatch for ${asset.url}: expected ${asset.sha256}, received ${actual}`,
      );
    }
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function resolveSourceAssetPath(
  sourceRoot: string,
  asset: BrowserRuntimeSourceAssetSpec,
): string {
  if (
    asset.sourceFileName.length === 0 ||
    asset.sourceFileName === "." ||
    asset.sourceFileName === ".." ||
    asset.sourceFileName !== path.basename(asset.sourceFileName)
  ) {
    throw new Error(
      `Pinned Browser runtime source filename must be a basename: ${asset.sourceFileName}`,
    );
  }
  return path.join(sourceRoot, asset.sourceFileName);
}

function downloadPinnedSourceAsset(url: string, destinationPath: string): void {
  execFileSync(
    "/usr/bin/curl",
    [
      "--fail",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--silent",
      "--show-error",
      "--output",
      destinationPath,
      url,
    ],
    { stdio: "inherit" },
  );
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
