import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDesktopPostgresBundle } from "./prepare-desktop-postgres-bundle.js";
import {
  resolveRuntimeDependencyInstallArgs,
  resolveRuntimePackageDependencies,
} from "./runtime-package-dependencies.js";

export const DESKTOP_RESOURCE_DIRECTORIES = [
  "cli",
  "db",
  "src",
  "tools",
  "agents",
  "models",
  "bin",
  "scripts",
];

export const DESKTOP_RESOURCE_DRIFT_CRITICAL_PATHS = ["agents", "src", "cli"] as const;
const EXCLUDED_BASENAMES = new Set([
  "test-results",
  "tsconfig.tsbuildinfo",
  "node_modules",
  ".next",
  "coverage",
  ".turbo",
  "dist",
  "out",
  ".kestrel",
]);

if (isDirectExecution()) {
  main();
}

function main(): void {
  const repoRoot = resolveRepoRoot(process.cwd());
  const desktopResourcesDir = path.join(repoRoot, "apps", "desktop", "resources", "kestrel-repo");

  rmSync(desktopResourcesDir, { recursive: true, force: true });
  mkdirSync(desktopResourcesDir, { recursive: true });

  for (const relativePath of DESKTOP_RESOURCE_DIRECTORIES) {
    const sourcePath = path.join(repoRoot, relativePath);
    if (existsSync(sourcePath) === false) {
      continue;
    }
    cpSync(sourcePath, path.join(desktopResourcesDir, relativePath), {
      recursive: true,
      filter: shouldCopyDesktopResourceEntry,
    });
  }

  writeDesktopRuntimeManifest(repoRoot, desktopResourcesDir);
  if (shouldInstallDesktopRuntimeDependencies({ packageStage: false })) {
    installDesktopRuntimeDependencies(desktopResourcesDir);
  }
  const postgresBundle = prepareDesktopPostgresBundle({ repoRoot });
  if (!postgresBundle.prepared && process.platform === "darwin") {
    console.warn(`[desktop] bundled postgres unavailable: ${postgresBundle.reason ?? "unavailable"}`);
  }

  console.log(`[desktop] prepared resources in ${desktopResourcesDir}`);
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

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) {
    return false;
  }
  return path.resolve(entryPath) === fileURLToPath(import.meta.url);
}

function isLocalEnvFile(basename: string): boolean {
  return basename === ".env" || basename.startsWith(".env.");
}

export function shouldCopyDesktopResourceEntry(entry: string): boolean {
  const basename = path.basename(entry);
  if (EXCLUDED_BASENAMES.has(basename)) {
    return false;
  }
  return isLocalEnvFile(basename) === false;
}

export interface DesktopResourceDriftCheckInput {
  repoRoot: string;
  desktopResourcesDir?: string | undefined;
  criticalPaths?: readonly string[] | undefined;
}

export type DesktopResourceDriftCheckResult =
  | {
      ok: true;
      skipped: boolean;
      checkedPaths: string[];
      message: string;
    }
  | {
      ok: false;
      skipped: false;
      checkedPaths: string[];
      stalePaths: string[];
      message: string;
    };

export function checkDesktopResourceDrift(input: DesktopResourceDriftCheckInput): DesktopResourceDriftCheckResult {
  const desktopResourcesDir = input.desktopResourcesDir ??
    path.join(input.repoRoot, "apps", "desktop", "resources", "kestrel-repo");
  const criticalPaths = [...(input.criticalPaths ?? DESKTOP_RESOURCE_DRIFT_CRITICAL_PATHS)];
  if (existsSync(desktopResourcesDir) === false) {
    return {
      ok: true,
      skipped: true,
      checkedPaths: criticalPaths,
      message: `Desktop generated resources are absent at '${desktopResourcesDir}'; drift check skipped.`,
    };
  }

  const stalePaths: string[] = [];
  for (const criticalPath of criticalPaths) {
    const sourceRoot = path.join(input.repoRoot, criticalPath);
    if (existsSync(sourceRoot) === false) {
      continue;
    }
    for (const relativeFile of collectResourceFiles(sourceRoot)) {
      const sourcePath = path.join(sourceRoot, relativeFile);
      const resourceRelativePath = path.join(criticalPath, relativeFile);
      const outputPath = path.join(desktopResourcesDir, resourceRelativePath);
      if (
        existsSync(outputPath) === false ||
        readFileSync(sourcePath).equals(readFileSync(outputPath)) === false
      ) {
        stalePaths.push(resourceRelativePath.split(path.sep).join("/"));
      }
    }
  }

  if (stalePaths.length > 0) {
    return {
      ok: false,
      skipped: false,
      checkedPaths: criticalPaths,
      stalePaths,
      message: [
        "Desktop generated resources are stale.",
        "Run `pnpm --filter @kestrel/desktop prepare:resources` and restart or repackage desktop.",
      ].join(" "),
    };
  }

  return {
    ok: true,
    skipped: false,
    checkedPaths: criticalPaths,
    message: "Desktop generated resources match tracked runtime sources.",
  };
}

function collectResourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (current: string, relativeDir: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (shouldCopyDesktopResourceEntry(entryPath) === false) {
        continue;
      }
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  visit(root, "");
  return files.sort();
}

function writeDesktopRuntimeManifest(repoRoot: string, outputDir: string): void {
  const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version: string;
    packageManager?: string | undefined;
    engines?: Record<string, string> | undefined;
    dependencies?: Record<string, string> | undefined;
    devDependencies?: Record<string, string> | undefined;
  };
  const desktopPackage = JSON.parse(readFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8")) as {
    overrides?: Record<string, string> | undefined;
  };

  const dependencies = resolveRuntimePackageDependencies({
    repoRoot,
    runtimeVersion: rootPackage.version,
    dependencies: rootPackage.dependencies,
    tsxVersion: rootPackage.devDependencies?.tsx,
  });

  writeFileSync(
    path.join(outputDir, "package.json"),
    `${JSON.stringify(
      {
        name: "kestrel-desktop-runtime",
        private: true,
        type: "module",
        ...(rootPackage.packageManager !== undefined ? { packageManager: rootPackage.packageManager } : {}),
        ...(rootPackage.engines !== undefined ? { engines: rootPackage.engines } : {}),
        ...(desktopPackage.overrides !== undefined ? { overrides: desktopPackage.overrides } : {}),
        dependencies,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function shouldInstallDesktopRuntimeDependencies(input: { packageStage: boolean }): boolean {
  return input.packageStage;
}

export function installDesktopRuntimeDependencies(
  outputDir: string,
  input?: {
    npmCacheDir?: string | undefined;
    localPackages?: readonly string[] | undefined;
  },
): void {
  if (existsSync(path.join(outputDir, "package.json")) === false) {
    throw new Error(`Desktop runtime package.json not found at '${outputDir}'. Run prepare:resources first.`);
  }
  const npmCacheDir = input?.npmCacheDir ?? path.join(outputDir, ".npm-cache");
  mkdirSync(npmCacheDir, { recursive: true });
  rmSync(path.join(outputDir, "node_modules"), { recursive: true, force: true });
  execFileSync(resolveNpmCommand(), resolveRuntimeDependencyInstallArgs(input?.localPackages), {
    cwd: outputDir,
    env: {
      ...process.env,
      CI: "1",
      npm_config_cache: npmCacheDir,
    },
    stdio: "inherit",
  });
}

function resolveNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
