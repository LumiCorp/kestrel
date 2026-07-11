import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ACTIVE_SOURCE_ROOTS = [
  "src",
  "cli",
  "agents",
  "apps/web",
  "packages/sdk/src",
  "scripts",
  "benchmarks/terminal_bench",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".py", ".sh"]);

const FORBIDDEN_EMITTER_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "turn emits legacy act interactionMode",
    pattern: /\binteractionMode\s*:\s*["']act["']|["']interactionMode["']\s*:\s*["']act["']/u,
  },
  {
    label: "profile emits legacy act defaultInteractionMode",
    pattern: /\bdefaultInteractionMode\s*:\s*["']act["']|["']defaultInteractionMode["']\s*:\s*["']act["']/u,
  },
  {
    label: "public type advertises legacy act interactionMode",
    pattern: /\b(?:interactionMode|defaultInteractionMode)\??\s*:\s*[^;\n]*["']act["']/u,
  },
];

const LEGACY_INPUT_NORMALIZER_PATTERN =
  /(?:\bvalue|\bcandidateMode|\bmodeValue|\binteractionMode|record\?\.defaultInteractionMode)\s*={2,3}\s*["']act["']|\.startsWith\(["']act\s/u;

const LEGACY_INPUT_NORMALIZER_ALLOWLIST = new Set([
  "apps/web/app/_components/ChatPageClient.tsx",
  "apps/web/lib/server/routes.ts",
  "cli/config/ProfileStore.ts",
  "src/operatorShell.ts",
  "src/orchestration/RuntimeComposer.ts",
  "src/runtime/RuntimeThreadedTurnExecutor.ts",
  "src/runtime/waitForPrompt.ts",
]);

test("active source does not emit or advertise legacy act interaction mode", async () => {
  const failures: string[] = [];
  for (const source of await readActiveSources()) {
    for (const { label, pattern } of FORBIDDEN_EMITTER_PATTERNS) {
      if (pattern.test(source.content)) {
        failures.push(`${source.relativePath}: ${label}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("legacy act mode mentions are limited to documented input normalizers", async () => {
  const failures: string[] = [];
  for (const source of await readActiveSources()) {
    if (LEGACY_INPUT_NORMALIZER_PATTERN.test(source.content) === false) {
      continue;
    }
    if (LEGACY_INPUT_NORMALIZER_ALLOWLIST.has(source.relativePath) === false) {
      failures.push(`${source.relativePath}: legacy act comparison is not allowlisted`);
      continue;
    }
    if (source.content.includes("Legacy") === false || source.content.includes("normalization") === false) {
      failures.push(`${source.relativePath}: legacy act normalizer must be explicitly documented`);
    }
  }

  assert.deepEqual(failures, []);
});

async function readActiveSources(): Promise<Array<{ relativePath: string; content: string }>> {
  const root = process.cwd();
  const files: Array<{ relativePath: string; content: string }> = [];
  for (const sourceRoot of ACTIVE_SOURCE_ROOTS) {
    await collectSourceFiles(root, path.join(root, sourceRoot), files);
  }
  return files;
}

async function collectSourceFiles(
  root: string,
  current: string,
  files: Array<{ relativePath: string; content: string }>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") {
      continue;
    }
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(root, entryPath, files);
      continue;
    }
    if (entry.isFile() === false || SOURCE_EXTENSIONS.has(path.extname(entry.name)) === false) {
      continue;
    }
    files.push({
      relativePath: path.relative(root, entryPath).split(path.sep).join("/"),
      content: await readFile(entryPath, "utf8"),
    });
  }
}
