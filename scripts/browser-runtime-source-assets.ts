import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
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
  source:
    | { kind: "https"; url: string }
    | { kind: "repository"; relativePath: string };
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
    repoRoot,
    enginePath,
    release.engine,
    options.download,
  );
  ensureVerifiedBrowserRuntimeSourceAsset(
    repoRoot,
    chromePath,
    release.chrome,
    options.download,
  );

  return { target, sourceRoot, enginePath, chromePath };
}

export function ensureVerifiedBrowserRuntimeSourceAsset(
  repoRoot: string,
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
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.download`,
  );
  try {
    if (asset.source.kind === "repository") {
      copyRepositoryAsset(repoRoot, asset.source.relativePath, temporaryPath);
    } else {
      if (new URL(asset.source.url).protocol !== "https:") {
        throw new Error(
          `Pinned Browser runtime source asset must use HTTPS: ${asset.source.url}`,
        );
      }
      download(asset.source.url, temporaryPath);
    }
    if (!existsSync(temporaryPath) || !lstatSync(temporaryPath).isFile()) {
      throw new Error(
        `Pinned Browser runtime source acquisition produced no regular file: ${describeSource(asset)}`,
      );
    }
    const actual = hashFile(temporaryPath);
    if (actual !== asset.sha256) {
      throw new Error(
        `Pinned Browser runtime source asset digest mismatch for ${describeSource(asset)}: expected ${asset.sha256}, received ${actual}`,
      );
    }
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function copyRepositoryAsset(
  repoRoot: string,
  relativePath: string,
  destinationPath: string,
): void {
  if (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
    throw new Error(
      `Pinned Browser runtime repository asset path must stay inside the repository: ${relativePath}`,
    );
  }
  const sourcePath = path.resolve(repoRoot, relativePath);
  const resolvedRoot = path.resolve(repoRoot);
  if (!sourcePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(
      `Pinned Browser runtime repository asset path escaped the repository: ${relativePath}`,
    );
  }
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
    throw new Error(
      `Pinned Browser runtime repository asset is missing: ${relativePath}`,
    );
  }
  copyFileSync(sourcePath, destinationPath);
}

function describeSource(asset: BrowserRuntimeSourceAssetSpec): string {
  return asset.source.kind === "https"
    ? asset.source.url
    : asset.source.relativePath;
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
