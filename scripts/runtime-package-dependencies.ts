import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  RUNTIME_WORKSPACE_PACKAGES,
  type RuntimeWorkspacePackageDescriptor,
} from "../src/localCore/runtimeWorkspacePackages.js";

export { RUNTIME_WORKSPACE_PACKAGES, type RuntimeWorkspacePackageDescriptor };

export function resolveRuntimePackageDependencies(input: {
  repoRoot: string;
  dependencies?: Record<string, string> | undefined;
  tsxVersion?: string | undefined;
}): Record<string, string> {
  const workspaceVersions = Object.fromEntries(
    RUNTIME_WORKSPACE_PACKAGES.map((workspacePackage) => {
      if (input.dependencies?.[workspacePackage.name] === undefined) {
        throw new Error(
          `Runtime manifest must declare ${workspacePackage.name}.`,
        );
      }
      const manifestPath = path.join(
        input.repoRoot,
        workspacePackage.directory,
        "package.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        manifest.name !== workspacePackage.name ||
        typeof manifest.version !== "string" ||
        !manifest.version.trim()
      ) {
        throw new Error(
          `Workspace manifest at '${manifestPath}' must declare ${workspacePackage.name} and a version.`,
        );
      }
      return [workspacePackage.name, manifest.version.trim()];
    }),
  );

  return {
    ...input.dependencies,
    ...(input.tsxVersion !== undefined ? { tsx: input.tsxVersion } : {}),
    ...workspaceVersions,
  };
}

export function packPublicProtocolPackage(input: {
  repoRoot: string;
  packDir: string;
}): string {
  return packRuntimeWorkspacePackage(input, RUNTIME_WORKSPACE_PACKAGES[0]);
}

export function packRuntimeWorkspacePackages(input: {
  repoRoot: string;
  packDir: string;
}): string[] {
  return RUNTIME_WORKSPACE_PACKAGES.map((workspacePackage) =>
    packRuntimeWorkspacePackage(input, workspacePackage),
  );
}

function packRuntimeWorkspacePackage(
  input: { repoRoot: string; packDir: string },
  workspacePackage: RuntimeWorkspacePackageDescriptor,
): string {
  const packageDir = path.join(input.repoRoot, workspacePackage.directory);
  const before = new Set(readdirSync(input.packDir));
  execFileSync(resolvePnpmCommand(), ["run", "build"], {
    cwd: packageDir,
    stdio: "inherit",
  });
  execFileSync(
    resolvePnpmCommand(),
    ["pack", "--pack-destination", input.packDir],
    {
      cwd: packageDir,
      stdio: "inherit",
    },
  );
  const tarballs = readdirSync(input.packDir).filter(
    (entry) =>
      before.has(entry) === false &&
      entry.startsWith(workspacePackage.tarballPrefix) &&
      entry.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one packed ${workspacePackage.name} artifact; found ${tarballs.length}.`,
    );
  }
  return path.join(input.packDir, tarballs[0]!);
}

export function resolveRuntimeDependencyInstallArgs(
  localPackages: readonly string[] = [],
): string[] {
  return [
    "install",
    "--omit=dev",
    ...(localPackages.length > 0 ? ["--no-save", ...localPackages] : []),
  ];
}

function resolvePnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
