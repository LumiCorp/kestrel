import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED_GOVERNANCE_DIRECTORIES = new Set([
  ".external",
  ".git",
  ".kestrel",
  ".cli-package",
  ".next",
  ".pnpm-store",
  ".turbo",
  ".venv-swebench",
  "__pycache__",
  "coverage",
  "dist",
  "jobs",
  "logs",
  "node_modules",
  "out",
  "output",
  "runs",
  "test-results",
  "tmp",
]);

export async function listFiles(root: string, predicate: (file: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  await walk(root, predicate, out);
  return out;
}

async function walk(root: string, predicate: (file: string) => boolean, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipGovernanceDirectory(entry.name)) {
        continue;
      }
      await walk(full, predicate, out);
      continue;
    }
    if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function shouldSkipGovernanceDirectory(name: string): boolean {
  return IGNORED_GOVERNANCE_DIRECTORIES.has(name);
}
