import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Arch, build, Platform, type Configuration } from "electron-builder";

import {
  parseDesktopUpdateChannel,
  resolveDesktopBuilderConfiguration,
} from "../apps/desktop/src/builderConfig.js";

const repoRoot = resolveRepoRoot(process.cwd());
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const stageDir = path.join(desktopRoot, ".desktop-package");
const desktopManifestPath = path.join(desktopRoot, "package.json");
const version = readVersion(desktopManifestPath);
const electronVersion = readDependencyVersion(desktopManifestPath, "electron");
const packageMode = parsePackageMode(process.env.KESTREL_DESKTOP_PACKAGE_MODE);
const releaseBuild = process.env.KESTREL_DESKTOP_RELEASE === "1";

if (!existsSync(stageDir)) {
  throw new Error(
    "Desktop package stage is missing. Run prepare:package-stage before packaging.",
  );
}
if (
  (process.env.KESTREL_DESKTOP_PLATFORM?.trim() || process.platform) !== "darwin" ||
  (process.env.KESTREL_DESKTOP_ARCH?.trim() || process.arch) !== "arm64"
) {
  throw new Error("Desktop packaging currently supports macOS arm64 only.");
}

writeDesktopPublicAppConfiguration();
prepareDesktopUninstallHelper();

const config = resolveDesktopBuilderConfiguration({
  repoRoot,
  version,
  electronVersion,
  releaseBuild,
  updateChannel: parseDesktopUpdateChannel(
    process.env.KESTREL_DESKTOP_UPDATE_CHANNEL,
  ),
  signingIdentity: process.env.KESTREL_DESKTOP_SIGN_IDENTITY,
  packageMode,
});

await build({
  projectDir: stageDir,
  targets: Platform.MAC.createTarget(
    packageMode === "dir" ? ["dir"] : ["dmg", "zip"],
    Arch.arm64,
  ),
  config: config as Configuration,
  publish: "never",
});

if (releaseBuild) {
  const appPath = path.join(
    desktopRoot,
    "out",
    "mac-arm64",
    "Kestrel.app",
  );
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appPath],
    { stdio: "inherit" },
  );
  execFileSync("xcrun", ["stapler", "validate", appPath], {
    stdio: "inherit",
  });
  execFileSync(
    "spctl",
    ["--assess", "--type", "execute", "--verbose=4", appPath],
    { stdio: "inherit" },
  );
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

function readVersion(packageJsonPath: string): string {
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
  return parsed.version;
}

function readDependencyVersion(
  packageJsonPath: string,
  dependencyName: string,
): string {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    devDependencies?: Record<string, unknown> | undefined;
  };
  const value = parsed.devDependencies?.[dependencyName];
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/u.test(value)) {
    throw new Error(
      `${dependencyName} in '${packageJsonPath}' must use an exact version.`,
    );
  }
  return value;
}

function parsePackageMode(value: string | undefined): "dir" | "release" {
  if (value === "dir" || value === "release") return value;
  throw new Error(
    "KESTREL_DESKTOP_PACKAGE_MODE must be 'dir' or 'release'. Use desktop:package:dir for unsigned local proof.",
  );
}

function prepareDesktopUninstallHelper(): void {
  const sourcePath = path.join(
    desktopRoot,
    "native",
    "kestrel-uninstall-helper.swift",
  );
  const resourcesDir = path.join(desktopRoot, "resources");
  const outputPath = path.join(resourcesDir, "kestrel-uninstall-helper");
  const moduleCachePath = path.join(resourcesDir, ".swift-module-cache");
  if (existsSync(sourcePath) === false) {
    throw new Error("Desktop uninstall helper source is missing.");
  }
  mkdirSync(moduleCachePath, { recursive: true });
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-module-cache-path",
      moduleCachePath,
      "-target",
      "arm64-apple-macosx13.0",
      sourcePath,
      "-O",
      "-o",
      outputPath,
    ],
    { stdio: "inherit" },
  );
}

function writeDesktopPublicAppConfiguration(): void {
  const slackClientId = process.env.KESTREL_SLACK_MCP_CLIENT_ID?.trim();
  const microsoft365ClientId =
    process.env.KESTREL_MICROSOFT_365_CLIENT_ID?.trim();
  const googleWorkspaceClientId =
    process.env.KESTREL_GOOGLE_WORKSPACE_CLIENT_ID?.trim();
  if (
    releaseBuild &&
    (!slackClientId || !microsoft365ClientId || !googleWorkspaceClientId)
  ) {
    throw new Error(
      "KESTREL_SLACK_MCP_CLIENT_ID, KESTREL_MICROSOFT_365_CLIENT_ID, and KESTREL_GOOGLE_WORKSPACE_CLIENT_ID are required for a Desktop release build.",
    );
  }
  writeFileSync(
    path.join(stageDir, "app-connections.json"),
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
