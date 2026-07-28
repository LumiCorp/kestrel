import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DESKTOP_RESOURCE_DIRECTORIES = [
  "cli",
  "db/migrations",
  "src",
  "tools",
  "agents",
  "models",
  "bin",
  "scripts",
] as const;

export const DESKTOP_RESOURCE_DRIFT_CRITICAL_PATHS = [
  "agents",
  "src",
  "cli",
  "db/migrations",
] as const;

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
  prepareDesktopRuntimePayload(resolveRepoRoot(process.cwd()));
}

export function prepareDesktopRuntimePayload(repoRoot: string): string {
  const payloadDir = path.join(repoRoot, "apps", "desktop-runtime", "payload");
  rmSync(payloadDir, { recursive: true, force: true });
  mkdirSync(payloadDir, { recursive: true });

  for (const relativePath of DESKTOP_RESOURCE_DIRECTORIES) {
    const sourcePath = path.join(repoRoot, relativePath);
    if (!existsSync(sourcePath)) continue;
    cpSync(sourcePath, path.join(payloadDir, relativePath), {
      recursive: true,
      filter: shouldCopyDesktopResourceEntry,
    });
  }

  console.log(`[desktop] prepared Local Core payload in ${payloadDir}`);
  return payloadDir;
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined &&
    path.resolve(entryPath) === fileURLToPath(import.meta.url);
}

function isLocalEnvFile(basename: string): boolean {
  return basename === ".env" || basename.startsWith(".env.");
}

export function shouldCopyDesktopResourceEntry(entry: string): boolean {
  const basename = path.basename(entry);
  return !EXCLUDED_BASENAMES.has(basename) && !isLocalEnvFile(basename);
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

export function checkDesktopResourceDrift(
  input: DesktopResourceDriftCheckInput,
): DesktopResourceDriftCheckResult {
  const payloadDir = input.desktopResourcesDir ??
    path.join(input.repoRoot, "apps", "desktop-runtime", "payload");
  const criticalPaths = [
    ...(input.criticalPaths ?? DESKTOP_RESOURCE_DRIFT_CRITICAL_PATHS),
  ];
  if (!existsSync(payloadDir)) {
    return {
      ok: true,
      skipped: true,
      checkedPaths: criticalPaths,
      message: `Desktop generated runtime payload is absent at '${payloadDir}'; drift check skipped.`,
    };
  }

  const stalePaths: string[] = [];
  for (const criticalPath of criticalPaths) {
    const sourceRoot = path.join(input.repoRoot, criticalPath);
    if (!existsSync(sourceRoot)) continue;
    for (const relativeFile of collectResourceFiles(sourceRoot)) {
      const outputPath = path.join(payloadDir, criticalPath, relativeFile);
      if (
        !existsSync(outputPath) ||
        !readFileSync(path.join(sourceRoot, relativeFile)).equals(
          readFileSync(outputPath),
        )
      ) {
        stalePaths.push(
          path.join(criticalPath, relativeFile).split(path.sep).join("/"),
        );
      }
    }
  }

  return stalePaths.length > 0
    ? {
        ok: false,
        skipped: false,
        checkedPaths: criticalPaths,
        stalePaths,
        message:
          "Desktop generated runtime payload is stale. Run `pnpm --filter @kestrel/desktop prepare:resources`.",
      }
    : {
        ok: true,
        skipped: false,
        checkedPaths: criticalPaths,
        message: "Desktop generated runtime payload matches tracked sources.",
      };
}

function collectResourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (current: string, relativeDir: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (!shouldCopyDesktopResourceEntry(entryPath)) continue;
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) visit(entryPath, relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  visit(root, "");
  return files.sort();
}
