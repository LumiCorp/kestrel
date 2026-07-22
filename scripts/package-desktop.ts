import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveDesktopPackagerConfig } from "../apps/desktop/src/packageConfig.ts";

const repoRoot = resolveRepoRoot(process.cwd());
const desktopPackageJson = readPackageJson(
  path.join(repoRoot, "apps", "desktop", "package.json"),
);
const desktopRequire = createRequire(
  path.join(repoRoot, "apps", "desktop", "package.json"),
);
const electronPackager = desktopRequire("electron-packager") as (
  options: Record<string, unknown>,
) => Promise<string[]>;
const packagerConfig = resolveDesktopPackagerConfig({
  repoRoot,
  platform: process.env.KESTREL_DESKTOP_PLATFORM,
  arch: process.env.KESTREL_DESKTOP_ARCH,
});
const resourcesDir = path.join(repoRoot, "apps", "desktop", "resources");
const extraResources = [
  path.join(resourcesDir, "kestrel-repo"),
  path.join(repoRoot, "apps", "desktop", "static"),
  path.join(repoRoot, "apps", "desktop", "assets", "kestrel-head.png"),
];
const releaseBuild = process.env.KESTREL_DESKTOP_RELEASE === "1";
const darwinSigning =
  packagerConfig.platform === "darwin"
    ? resolveDarwinSigningOptions()
    : undefined;

if (existsSync(packagerConfig.stageDir) === false) {
  throw new Error(
    "Desktop package stage is missing. Run prepare:package-stage before packaging.",
  );
}
writeDesktopPublicAppConfiguration();
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
  icon: packagerConfig.iconPath,
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
  verifyDesktopPackage(
    packagedPath,
    packagerConfig,
    darwinSigning?.hardenedRuntime,
  );
  if (packagerConfig.platform === "darwin" && releaseBuild) {
    notarizeDesktopPackage(packagedPath, packagerConfig);
  } else if (packagerConfig.platform === "darwin") {
    const archivePath = createDesktopPackageArchive(
      packagedPath,
      packagerConfig,
    );
    console.log(`[desktop] packaged archive at ${archivePath}`);
  }
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
    throw new Error(
      `Unable to inspect Desktop package signature: ${signature.stderr.trim()}`,
    );
  }
  const signatureDetails = `${signature.stdout}\n${signature.stderr}`;
  const hasHardenedRuntime = /flags=.*\([^)]*\bruntime\b[^)]*\)/u.test(
    signatureDetails,
  );
  if (hasHardenedRuntime !== expectedHardenedRuntime) {
    throw new Error(
      `Desktop package signature hardened-runtime mismatch: expected ${String(expectedHardenedRuntime)}, ` +
        `received ${String(hasHardenedRuntime)}.`,
    );
  }
  if (
    releaseBuild &&
    !signatureDetails.includes("Authority=Developer ID Application:")
  ) {
    throw new Error(
      "Desktop release package must be signed with a Developer ID Application certificate.",
    );
  }
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appPath],
    { stdio: "inherit" },
  );
}

function notarizeDesktopPackage(
  packagedPath: string,
  config: { appName: string; platform: string; arch: string },
): void {
  const notaryProfile = process.env.KESTREL_DESKTOP_NOTARY_PROFILE?.trim();
  if (notaryProfile === undefined || notaryProfile.length === 0) {
    throw new Error(
      "KESTREL_DESKTOP_NOTARY_PROFILE is required for a Desktop release build.",
    );
  }
  const appPath = path.join(packagedPath, `${config.appName}.app`);
  const submissionZip = path.join(
    packagerConfig.outDir,
    `${config.appName}-${desktopPackageJson.version}-${config.platform}-${config.arch}.notary.zip`,
  );
  rmSync(submissionZip, { force: true });
  execFileSync(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, submissionZip],
    {
      stdio: "inherit",
    },
  );
  try {
    execFileSync(
      "xcrun",
      [
        "notarytool",
        "submit",
        submissionZip,
        "--keychain-profile",
        notaryProfile,
        "--wait",
      ],
      { stdio: "inherit" },
    );
    execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "validate", appPath], {
      stdio: "inherit",
    });
    execFileSync(
      "spctl",
      ["--assess", "--type", "execute", "--verbose=4", appPath],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(submissionZip, { force: true });
  }
  const releaseZip = createDesktopPackageArchive(packagedPath, config);
  console.log(`[desktop] notarized release artifact at ${releaseZip}`);
}

function createDesktopPackageArchive(
  packagedPath: string,
  config: { appName: string; platform: string; arch: string },
): string {
  const appPath = path.join(packagedPath, `${config.appName}.app`);
  const archivePath = path.join(
    packagerConfig.outDir,
    `${config.appName}-${desktopPackageJson.version}-${config.platform}-${config.arch}.zip`,
  );
  rmSync(archivePath, { force: true });
  execFileSync(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archivePath],
    {
      stdio: "inherit",
    },
  );
  return archivePath;
}

function resolveDarwinSigningOptions(): {
  identity: string;
  hardenedRuntime: boolean;
  options: Record<string, unknown>;
} {
  const configuredIdentity = process.env.KESTREL_DESKTOP_SIGN_IDENTITY?.trim();
  const identity =
    configuredIdentity && configuredIdentity.length > 0
      ? configuredIdentity
      : "-";
  if (releaseBuild && identity === "-") {
    throw new Error(
      "KESTREL_DESKTOP_SIGN_IDENTITY must name a Developer ID Application certificate for a release build.",
    );
  }
  if (identity !== "-") {
    return {
      identity,
      hardenedRuntime: true,
      options: { identity, hardenedRuntime: true },
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
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  if (
    typeof parsed.version !== "string" ||
    parsed.version.trim().length === 0
  ) {
    throw new Error(
      `Package manifest at '${packageJsonPath}' must declare a version.`,
    );
  }
  return { version: parsed.version };
}

function writeDesktopPublicAppConfiguration(): void {
  const slackClientId = process.env.KESTREL_SLACK_MCP_CLIENT_ID?.trim();
  const microsoft365ClientId = process.env.KESTREL_MICROSOFT_365_CLIENT_ID?.trim();
  const googleWorkspaceClientId = process.env.KESTREL_GOOGLE_WORKSPACE_CLIENT_ID?.trim();
  if (releaseBuild && (!slackClientId || !microsoft365ClientId || !googleWorkspaceClientId)) {
    throw new Error(
      "KESTREL_SLACK_MCP_CLIENT_ID, KESTREL_MICROSOFT_365_CLIENT_ID, and KESTREL_GOOGLE_WORKSPACE_CLIENT_ID are required for a Desktop release build.",
    );
  }
  writeFileSync(
    path.join(packagerConfig.stageDir, "app-connections.json"),
    `${JSON.stringify(
      {
        version: 1,
        publicClientIds: {
          ...(slackClientId ? { slack: slackClientId } : {}),
          ...(microsoft365ClientId
            ? { microsoft_365: microsoft365ClientId }
            : {}),
          ...(googleWorkspaceClientId
            ? { google_workspace: googleWorkspaceClientId }
            : {}),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
