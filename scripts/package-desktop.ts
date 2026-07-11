import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveDesktopPackagerConfig } from "../apps/desktop/src/packageConfig.ts";
import { verifyPreparedDesktopPostgresBundle } from "./prepare-desktop-postgres-bundle.js";

const repoRoot = resolveRepoRoot(process.cwd());
const desktopPackageJson = readPackageJson(path.join(repoRoot, "apps", "desktop", "package.json"));
const desktopRequire = createRequire(path.join(repoRoot, "apps", "desktop", "package.json"));
const electronPackager = desktopRequire("electron-packager") as (options: Record<string, unknown>) => Promise<string[]>;
const packagerConfig = resolveDesktopPackagerConfig({
  repoRoot,
  platform: process.env.KESTREL_DESKTOP_PLATFORM,
  arch: process.env.KESTREL_DESKTOP_ARCH,
});
const resourcesDir = path.join(repoRoot, "apps", "desktop", "resources");
const extraResources = [
  path.join(resourcesDir, "kestrel-repo"),
  path.join(repoRoot, "apps", "desktop", "static"),
];
const postgresBundlePath = path.join(resourcesDir, "postgres-bundle");
const darwinSigning = packagerConfig.platform === "darwin"
  ? resolveDarwinSigningOptions()
  : undefined;

if (existsSync(packagerConfig.stageDir) === false) {
  throw new Error("Desktop package stage is missing. Run prepare:package-stage before packaging.");
}
if (packagerConfig.platform === "darwin") {
  const targetRoot = path.join(
    postgresBundlePath,
    `${packagerConfig.platform}-${packagerConfig.arch}`,
  );
  const manifest = verifyPreparedDesktopPostgresBundle({
    targetRoot,
    expectedPlatform: packagerConfig.platform,
    expectedArch: packagerConfig.arch,
  });
  console.log(
    `[desktop] verified self-contained Postgres ${manifest.version} `
      + `(${manifest.scannedBinaries} Mach-O binaries)`,
  );
  extraResources.push(postgresBundlePath);
} else if (existsSync(postgresBundlePath)) {
  extraResources.push(postgresBundlePath);
}

mkdirSync(packagerConfig.outDir, { recursive: true });

const outputPrefix = `${packagerConfig.appName}-${packagerConfig.platform}-${packagerConfig.arch}`;
for (const entry of [
  path.join(packagerConfig.outDir, outputPrefix),
  path.join(packagerConfig.outDir, `${outputPrefix}.app`),
]) {
  rmSync(entry, { recursive: true, force: true });
}

const packagedPaths = await electronPackager({
  appBundleId: "com.kestrel.desktop",
  appVersion: desktopPackageJson.version,
  arch: packagerConfig.arch,
  asar: false,
  dir: packagerConfig.stageDir,
  executableName: packagerConfig.executableName,
  extraResource: extraResources,
  name: packagerConfig.appName,
  out: packagerConfig.outDir,
  overwrite: true,
  platform: packagerConfig.platform,
  prune: false,
  quiet: false,
  ...(packagerConfig.platform === "darwin" && darwinSigning?.identity !== "-"
    ? {
        osxSign: darwinSigning?.options,
      }
    : {}),
});

for (const packagedPath of packagedPaths) {
  if (packagerConfig.platform === "darwin" && darwinSigning?.identity === "-") {
    signDesktopPackageAdHoc(packagedPath, packagerConfig);
  }
  verifyDesktopPackage(packagedPath, packagerConfig, darwinSigning?.hardenedRuntime);
  console.log(`[desktop] packaged app at ${packagedPath}`);
}

function signDesktopPackageAdHoc(
  packagedPath: string,
  config: { appName: string },
): void {
  const appPath = path.join(packagedPath, `${config.appName}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
}

function verifyDesktopPackage(
  packagedPath: string,
  config: { appName: string; platform: string },
  expectedHardenedRuntime: boolean | undefined,
): void {
  if (config.platform !== "darwin") {
    return;
  }

  const appPath = path.join(packagedPath, `${config.appName}.app`);
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  if (signature.status !== 0) {
    throw new Error(`Unable to inspect Desktop package signature: ${signature.stderr.trim()}`);
  }
  const signatureDetails = `${signature.stdout}\n${signature.stderr}`;
  const hasHardenedRuntime = /flags=.*\([^)]*\bruntime\b[^)]*\)/u.test(signatureDetails);
  if (hasHardenedRuntime !== expectedHardenedRuntime) {
    throw new Error(
      `Desktop package signature hardened-runtime mismatch: expected ${String(expectedHardenedRuntime)}, `
        + `received ${String(hasHardenedRuntime)}.`,
    );
  }
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appPath],
    { stdio: "inherit" },
  );
}

function resolveDarwinSigningOptions(): {
  identity: string;
  hardenedRuntime: boolean;
  options: Record<string, unknown>;
} {
  const configuredIdentity = process.env.KESTREL_DESKTOP_SIGN_IDENTITY?.trim();
  const identity = configuredIdentity && configuredIdentity.length > 0
    ? configuredIdentity
    : "-";
  if (identity !== "-") {
    return {
      identity,
      hardenedRuntime: true,
      options: { identity },
    };
  }
  return {
    identity,
    hardenedRuntime: false,
    options: {
      identity,
      identityValidation: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
  };
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}

function readPackageJson(packageJsonPath: string): { version: string } {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
    throw new Error(`Package manifest at '${packageJsonPath}' must declare a version.`);
  }
  return { version: parsed.version };
}
