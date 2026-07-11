import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDesktopResourceDrift } from "./prepare-desktop-resources.js";

if (isDirectExecution()) {
  main();
}

function main(): void {
  const repoRoot = resolveRepoRoot(process.cwd());
  const result = checkDesktopResourceDrift({ repoRoot });
  if (result.ok) {
    console.log(`[desktop] ${result.message}`);
    return;
  }

  console.error(`[desktop] ${result.message}`);
  for (const stalePath of result.stalePaths.slice(0, 50)) {
    console.error(`- ${stalePath}`);
  }
  if (result.stalePaths.length > 50) {
    console.error(`... ${result.stalePaths.length - 50} more stale files`);
  }
  process.exitCode = 1;
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
