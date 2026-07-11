import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();

const ACTIVE_PATHS = [
  "tools/catalog.ts",
  "tools/index.ts",
  "tools/createDefaultToolGateway.ts",
  "agents/reference-react/src/steps/deliberator.ts",
  "tests/scenario/promptSuiteHarness.ts",
  "apps/web/lib/agent/kestrel-capabilities.ts",
] as const;

const ACTIVE_DIRECTORIES = [] as const;

const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "retired_tool.source.search", pattern: /\bsource\.search\b/ },
  { label: "retired_tool.source.fetch", pattern: /\bsource\.fetch\b/ },
  { label: "retired_tool.source.triage", pattern: /\bsource\.triage\b/ },
  { label: "retired_tool.free.wikipedia.lookup", pattern: /\bfree\.wikipedia\.lookup\b/ },
  { label: "retired_tool.free.wikipedia.links", pattern: /\bfree\.wikipedia\.links\b/ },
  { label: "retired_capability.encyclopedia", pattern: /\bencyclopedia\.(lookup|summary|links)\b/ },
  { label: "retired_capability.web.triage", pattern: /\bweb\.triage\b/ },
];

test("active internet migration paths do not reference retired wiki/source surfaces", async () => {
  const files = new Set<string>(ACTIVE_PATHS.map((target) => path.join(ROOT, target)));
  for (const directory of ACTIVE_DIRECTORIES) {
    const nested = await collectTypeScriptFiles(path.join(ROOT, directory));
    for (const entry of nested) {
      files.add(entry);
    }
  }

  const violations: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const candidate of FORBIDDEN_PATTERNS) {
      if (candidate.pattern.test(content)) {
        violations.push(`${path.relative(ROOT, file)} -> ${candidate.label}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Retired tool/capability references detected in active internet migration paths:\n${violations.join("\n")}`,
  );
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}
