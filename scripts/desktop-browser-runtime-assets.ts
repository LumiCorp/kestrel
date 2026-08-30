import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  BROWSER_RUNTIME_RELEASE_MANIFEST,
  DESKTOP_BROWSER_RUNTIME_TARGET,
  getDesktopBrowserRuntimeRelease,
} from "../src/browser/runtimeReleaseManifest.js";
import {
  ensureVerifiedBrowserRuntimeSourceAsset,
  stageBrowserRuntimeSourceAssets,
  type BrowserRuntimeSourceAssetSpec,
} from "./browser-runtime-source-assets.js";

export const DESKTOP_BROWSER_RUNTIME_RECEIPT_NAME =
  "kestrel-browser-runtime.json" as const;
export const DESKTOP_BROWSER_RUNTIME_RECEIPT_VERSION =
  "desktop_browser_runtime_receipt_v1" as const;

export interface DesktopBrowserRuntimeAssetSpec
  extends BrowserRuntimeSourceAssetSpec {
  executableRelativePath: string;
  archiveRoot?: string | undefined;
  excludedRuntimeRelativePaths?: readonly string[] | undefined;
}

export interface DesktopBrowserRuntimeSpec {
  manifestVersion: string;
  target: typeof DESKTOP_BROWSER_RUNTIME_TARGET;
  engineRevision: string;
  chromeRevision: string;
  engine: DesktopBrowserRuntimeAssetSpec;
  chrome: DesktopBrowserRuntimeAssetSpec;
}

interface DesktopBrowserRuntimeReceiptEntry {
  path: string;
  kind: "file" | "symlink";
  sha256?: string | undefined;
  target?: string | undefined;
  nativeExecutable?: true | undefined;
}

export interface DesktopBrowserRuntimeReceipt {
  version: typeof DESKTOP_BROWSER_RUNTIME_RECEIPT_VERSION;
  manifestVersion: string;
  target: typeof DESKTOP_BROWSER_RUNTIME_TARGET;
  engineRevision: string;
  chromeRevision: string;
  sources: {
    engine: { url: string; sha256: string };
    chrome: { url: string; sha256: string };
  };
  executables: {
    engine: string;
    chrome: string;
  };
  acquisition: "verified_at_package_time";
  executableResolution: "explicit_packaged_paths_only";
  excludedRuntimePaths: string[];
  files: DesktopBrowserRuntimeReceiptEntry[];
}

export interface DesktopBrowserRuntimeApplicationSignatureResult {
  signatureValid: boolean;
  resourceSealValid: boolean;
  hardenedRuntime: boolean;
  authority?: string | undefined;
  detail?: string | undefined;
}

export interface DesktopBrowserRuntimeNativeSignatureResult {
  signatureValid: boolean;
  authority?: string | undefined;
  detail?: string | undefined;
}

export interface DesktopBrowserRuntimeSignatureVerifier {
  verifyApplicationBundle(
    appPath: string,
  ): DesktopBrowserRuntimeApplicationSignatureResult;
  verifyNativeExecutable(
    executablePath: string,
  ): DesktopBrowserRuntimeNativeSignatureResult;
}

export type DesktopBrowserRuntimeVerificationOptions =
  | { mode?: "unsigned" | undefined }
  | {
      mode: "signed-release";
      appPath: string;
      expectedSigningAuthority: string;
      signatureVerifier: DesktopBrowserRuntimeSignatureVerifier;
    };

export function desktopBrowserRuntimeSpec(): DesktopBrowserRuntimeSpec {
  const release = getDesktopBrowserRuntimeRelease();
  return {
    manifestVersion: BROWSER_RUNTIME_RELEASE_MANIFEST.version,
    target: DESKTOP_BROWSER_RUNTIME_TARGET,
    engineRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
    chromeRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
    engine: release.engine,
    chrome: release.chrome,
  };
}

export function prepareDesktopBrowserRuntimeAssets(
  repoRoot: string,
  options: {
    download?: ((url: string, destinationPath: string) => void) | undefined;
  } = {},
): string {
  const spec = desktopBrowserRuntimeSpec();
  const desktopRoot = path.join(repoRoot, "apps", "desktop");
  const runtimeRoot = path.join(desktopRoot, ".desktop-browser-runtime");
  const extractionRoot = `${runtimeRoot}.extracting`;
  const stagedSources = stageBrowserRuntimeSourceAssets(
    repoRoot,
    spec.target,
    options,
  );
  const engineSource = stagedSources.enginePath;
  const chromeSource = stagedSources.chromePath;
  if (spec.chrome.archiveRoot === undefined) {
    throw new Error("Desktop Chrome release must declare its exact archive root.");
  }

  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(extractionRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(extractionRoot, { recursive: true });
  try {
    const engineDestination = resolveContainedPath(
      runtimeRoot,
      spec.engine.executableRelativePath,
    );
    mkdirSync(path.dirname(engineDestination), { recursive: true });
    copyFileSync(engineSource, engineDestination);
    chmodSync(engineDestination, 0o755);

    execFileSync("/usr/bin/ditto", ["-x", "-k", chromeSource, extractionRoot], {
      stdio: "inherit",
    });
    const extractedChromeRoot = resolveContainedPath(
      extractionRoot,
      spec.chrome.archiveRoot,
    );
    if (!existsSync(extractedChromeRoot)) {
      throw new Error(
        `Verified Desktop Chrome archive is missing '${spec.chrome.archiveRoot}'.`,
      );
    }
    cpSync(extractedChromeRoot, path.join(runtimeRoot, "chrome"), {
      recursive: true,
      dereference: false,
      // Chrome.framework uses relative version symlinks. Preserve their
      // literal targets so copying out of the extraction directory cannot
      // rewrite them to temporary absolute paths that escape the package.
      verbatimSymlinks: true,
    });
    removeExcludedRuntimePaths(runtimeRoot, spec.chrome);

    const receipt = createDesktopBrowserRuntimeReceipt(runtimeRoot, spec);
    writeFileSync(
      path.join(runtimeRoot, DESKTOP_BROWSER_RUNTIME_RECEIPT_NAME),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    verifyDesktopBrowserRuntimeDirectory(runtimeRoot, spec);
  } catch (error) {
    rmSync(runtimeRoot, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
  return runtimeRoot;
}

export function createDesktopBrowserRuntimeReceipt(
  runtimeRoot: string,
  spec: DesktopBrowserRuntimeSpec = desktopBrowserRuntimeSpec(),
  options: { omitCodeSignatureMetadata?: boolean | undefined } = {},
): DesktopBrowserRuntimeReceipt {
  verifyExcludedRuntimePathsAbsent(runtimeRoot, spec);
  for (const executable of [
    spec.engine.executableRelativePath,
    spec.chrome.executableRelativePath,
  ]) {
    const executablePath = resolveContainedPath(runtimeRoot, executable);
    if (!existsSync(executablePath) || !lstatSync(executablePath).isFile()) {
      throw new Error(`Desktop Browser executable is missing: ${executable}`);
    }
    if ((lstatSync(executablePath).mode & 0o111) === 0) {
      throw new Error(`Desktop Browser executable is not executable: ${executable}`);
    }
  }
  return {
    version: DESKTOP_BROWSER_RUNTIME_RECEIPT_VERSION,
    manifestVersion: spec.manifestVersion,
    target: spec.target,
    engineRevision: spec.engineRevision,
    chromeRevision: spec.chromeRevision,
    sources: {
      engine: { url: spec.engine.url, sha256: spec.engine.sha256 },
      chrome: { url: spec.chrome.url, sha256: spec.chrome.sha256 },
    },
    executables: {
      engine: spec.engine.executableRelativePath,
      chrome: spec.chrome.executableRelativePath,
    },
    acquisition: "verified_at_package_time",
    executableResolution: "explicit_packaged_paths_only",
    excludedRuntimePaths: [...(spec.chrome.excludedRuntimeRelativePaths ?? [])],
    files: collectRuntimeEntries(runtimeRoot, options),
  };
}

export function verifyDesktopBrowserRuntimeDirectory(
  runtimeRoot: string,
  spec: DesktopBrowserRuntimeSpec = desktopBrowserRuntimeSpec(),
  options: DesktopBrowserRuntimeVerificationOptions = {},
): DesktopBrowserRuntimeReceipt {
  const receiptPath = path.join(runtimeRoot, DESKTOP_BROWSER_RUNTIME_RECEIPT_NAME);
  if (!existsSync(receiptPath)) {
    throw new Error(`Desktop Browser runtime receipt is missing: ${receiptPath}`);
  }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as DesktopBrowserRuntimeReceipt;
  const signedRelease = options.mode === "signed-release";
  const expected = createDesktopBrowserRuntimeReceipt(
    runtimeRoot,
    spec,
    signedRelease ? { omitCodeSignatureMetadata: true } : {},
  );
  const receiptIdentity = { ...receipt, files: undefined };
  const expectedIdentity = { ...expected, files: undefined };
  if (
    JSON.stringify(receiptIdentity) !== JSON.stringify(expectedIdentity) ||
    !(signedRelease
      ? runtimeEntriesMatchSigned(receipt.files, expected.files)
      : runtimeEntriesMatch(receipt.files, expected.files))
  ) {
    throw new Error(
      "Desktop Browser runtime does not match its pinned manifest and package receipt. Native executable hashes must remain exact in unsigned packages; signed releases permit only signature-verified native changes.",
    );
  }
  if (signedRelease) {
    verifySignedDesktopBrowserRuntime({
      appPath: options.appPath,
      expectedSigningAuthority: requireSigningAuthority(
        options.expectedSigningAuthority,
      ),
      runtimeRoot,
      receipt,
      signatureVerifier: options.signatureVerifier,
    });
  }
  return receipt;
}

export function createDarwinDesktopBrowserRuntimeSignatureVerifier(): DesktopBrowserRuntimeSignatureVerifier {
  return {
    verifyApplicationBundle(appPath) {
      const verification = spawnSync(
        "codesign",
        ["--verify", "--deep", "--strict", "--verbose=2", appPath],
        { encoding: "utf8" },
      );
      const signature = spawnSync(
        "codesign",
        ["-dv", "--verbose=4", appPath],
        { encoding: "utf8" },
      );
      const detail = commandDetail(verification, signature);
      return {
        signatureValid: verification.status === 0 && signature.status === 0,
        resourceSealValid: verification.status === 0,
        hardenedRuntime: /flags=.*\([^)]*\bruntime\b[^)]*\)/u.test(detail),
        authority: detail.match(/^Authority=(.+)$/mu)?.[1],
        detail,
      };
    },
    verifyNativeExecutable(executablePath) {
      const verification = spawnSync(
        "codesign",
        ["--verify", "--strict", "--verbose=2", executablePath],
        { encoding: "utf8" },
      );
      const signature = spawnSync(
        "codesign",
        ["-dv", "--verbose=4", executablePath],
        { encoding: "utf8" },
      );
      const detail = commandDetail(verification, signature);
      return {
        signatureValid: verification.status === 0 && signature.status === 0,
        authority: detail.match(/^Authority=(.+)$/mu)?.[1],
        detail,
      };
    },
  };
}

export function desktopBrowserRuntimeExecutablePaths(runtimeRoot: string): {
  engine: string;
  chrome: string;
} {
  const spec = desktopBrowserRuntimeSpec();
  return {
    engine: resolveContainedPath(runtimeRoot, spec.engine.executableRelativePath),
    chrome: resolveContainedPath(runtimeRoot, spec.chrome.executableRelativePath),
  };
}

export function ensureVerifiedSourceAsset(
  filePath: string,
  asset: DesktopBrowserRuntimeAssetSpec,
  download?: ((url: string, destinationPath: string) => void) | undefined,
): void {
  ensureVerifiedBrowserRuntimeSourceAsset(filePath, asset, download);
}

function removeExcludedRuntimePaths(
  runtimeRoot: string,
  asset: DesktopBrowserRuntimeAssetSpec,
): void {
  for (const relativePath of asset.excludedRuntimeRelativePaths ?? []) {
    const excludedPath = resolveContainedPath(runtimeRoot, relativePath);
    if (!existsSync(excludedPath) || !lstatSync(excludedPath).isFile()) {
      throw new Error(
        `Pinned Desktop Browser archive is missing excluded runtime installer: ${relativePath}`,
      );
    }
    rmSync(excludedPath);
  }
}

function verifyExcludedRuntimePathsAbsent(
  runtimeRoot: string,
  spec: DesktopBrowserRuntimeSpec,
): void {
  for (const relativePath of spec.chrome.excludedRuntimeRelativePaths ?? []) {
    if (existsSync(resolveContainedPath(runtimeRoot, relativePath))) {
      throw new Error(`Desktop Browser runtime contains excluded installer: ${relativePath}`);
    }
  }
}

function collectRuntimeEntries(
  runtimeRoot: string,
  options: { omitCodeSignatureMetadata?: boolean | undefined } = {},
): DesktopBrowserRuntimeReceiptEntry[] {
  const entries: DesktopBrowserRuntimeReceiptEntry[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (current === runtimeRoot && name === DESKTOP_BROWSER_RUNTIME_RECEIPT_NAME) {
        continue;
      }
      const entryPath = path.join(current, name);
      const relativePath = path.relative(runtimeRoot, entryPath).split(path.sep).join("/");
      const stat = lstatSync(entryPath);
      if (
        options.omitCodeSignatureMetadata === true &&
        stat.isFile() &&
        isAppleCodeSignatureResource(relativePath)
      ) {
        continue;
      }
      if (stat.isDirectory()) {
        visit(entryPath);
      } else if (stat.isFile()) {
        const nativeExecutable = isMachO(entryPath);
        entries.push({
          path: relativePath,
          kind: "file",
          sha256: hashFile(entryPath),
          ...(nativeExecutable ? { nativeExecutable: true as const } : {}),
        });
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(entryPath);
        const resolved = path.resolve(path.dirname(entryPath), target);
        if (!isContained(runtimeRoot, resolved)) {
          throw new Error(
            `Desktop Browser runtime symlink escapes its resource root: ${relativePath}`,
          );
        }
        entries.push({ path: relativePath, kind: "symlink", target });
      } else {
        throw new Error(`Desktop Browser runtime contains an unsupported entry: ${relativePath}`);
      }
    }
  };
  visit(runtimeRoot);
  return entries;
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filePath, "r");
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function isMachO(filePath: string): boolean {
  const result = execFileSync("/usr/bin/file", ["-b", filePath], {
    encoding: "utf8",
  });
  return result.includes("Mach-O");
}

function runtimeEntriesMatch(
  receiptEntries: readonly DesktopBrowserRuntimeReceiptEntry[],
  actualEntries: readonly DesktopBrowserRuntimeReceiptEntry[],
): boolean {
  if (receiptEntries.length !== actualEntries.length) return false;
  return receiptEntries.every((receiptEntry, index) => {
    const actualEntry = actualEntries[index];
    if (
      actualEntry === undefined ||
      receiptEntry.path !== actualEntry.path ||
      receiptEntry.kind !== actualEntry.kind ||
      receiptEntry.target !== actualEntry.target ||
      receiptEntry.nativeExecutable !== actualEntry.nativeExecutable
    ) {
      return false;
    }
    return receiptEntry.sha256 === actualEntry.sha256;
  });
}

function runtimeEntriesMatchSigned(
  receiptEntries: readonly DesktopBrowserRuntimeReceiptEntry[],
  actualEntries: readonly DesktopBrowserRuntimeReceiptEntry[],
): boolean {
  if (receiptEntries.length !== actualEntries.length) return false;
  return receiptEntries.every((receiptEntry, index) => {
    const actualEntry = actualEntries[index];
    if (
      actualEntry === undefined ||
      receiptEntry.path !== actualEntry.path ||
      receiptEntry.kind !== actualEntry.kind ||
      receiptEntry.target !== actualEntry.target ||
      receiptEntry.nativeExecutable !== actualEntry.nativeExecutable
    ) {
      return false;
    }
    return receiptEntry.nativeExecutable === true ||
      receiptEntry.sha256 === actualEntry.sha256;
  });
}

function verifySignedDesktopBrowserRuntime(input: {
  appPath: string;
  expectedSigningAuthority: string;
  runtimeRoot: string;
  receipt: DesktopBrowserRuntimeReceipt;
  signatureVerifier: DesktopBrowserRuntimeSignatureVerifier;
}): void {
  const application = input.signatureVerifier.verifyApplicationBundle(
    input.appPath,
  );
  if (
    application.signatureValid !== true ||
    application.resourceSealValid !== true ||
    application.hardenedRuntime !== true ||
    application.authority !== input.expectedSigningAuthority
  ) {
    throw new Error(
      `Signed Desktop application bundle failed signature, hardened-runtime, resource-seal, or identity verification.${formatSignatureDetail(application.detail)}`,
    );
  }

  for (const entry of input.receipt.files) {
    if (entry.nativeExecutable !== true) continue;
    const executablePath = resolveContainedPath(input.runtimeRoot, entry.path);
    const signature = input.signatureVerifier.verifyNativeExecutable(
      executablePath,
    );
    if (
      signature.signatureValid !== true ||
      signature.authority !== input.expectedSigningAuthority
    ) {
      throw new Error(
        `Signed Desktop Browser native executable failed signature or identity verification: ${entry.path}.${formatSignatureDetail(signature.detail)}`,
      );
    }
  }
}

function requireSigningAuthority(value: string): string {
  const authority = value.trim();
  if (!/^Developer ID Application:\s+.+$/u.test(authority)) {
    throw new Error(
      "Signed Desktop Browser verification requires an exact Developer ID Application authority.",
    );
  }
  return authority;
}

function isAppleCodeSignatureResource(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (
    segments.length < 3 ||
    segments.at(-2) !== "_CodeSignature" ||
    segments.at(-1) !== "CodeResources"
  ) {
    return false;
  }
  const signatureDirectoryIndex = segments.length - 2;
  const isAppSignature =
    segments[signatureDirectoryIndex - 1] === "Contents" &&
    (segments[signatureDirectoryIndex - 2] ?? "").endsWith(".app");
  const isFrameworkSignature =
    segments[signatureDirectoryIndex - 2] === "Versions" &&
    (segments[signatureDirectoryIndex - 3] ?? "").endsWith(".framework");
  return isAppSignature || isFrameworkSignature;
}

function commandDetail(
  ...results: Array<{
    stdout?: string | Buffer | null | undefined;
    stderr?: string | Buffer | null | undefined;
  }>
): string {
  return results
    .flatMap((result) => [result.stdout, result.stderr])
    .map((value) => value?.toString().trim() ?? "")
    .filter((value) => value.length > 0)
    .join("\n");
}

function formatSignatureDetail(detail: string | undefined): string {
  const normalized = detail?.trim();
  return normalized === undefined || normalized.length === 0
    ? ""
    : ` ${normalized}`;
}

function resolveContainedPath(root: string, relativePath: string): string {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`Desktop Browser runtime path must be relative: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!isContained(root, resolved)) {
    throw new Error(`Desktop Browser runtime path escapes its resource root: ${relativePath}`);
  }
  return resolved;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
