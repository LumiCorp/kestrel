import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ArchitectureRuleSet } from "../src/governance/contracts.js";
import { evaluateArchitecture } from "../src/governance/architecture.js";
import { listFiles, toPosixPath } from "./governance-utils.js";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "docs", "references", "architecture-rules.json");

async function main(): Promise<void> {
  const rules = await loadRules();
  const files = await listFiles(
    ROOT,
    (file) =>
      file.endsWith(".ts") &&
      isGeneratedArtifact(file) === false &&
      file.includes("/.external/") === false &&
      file.includes("/src/"),
  );
  let failures = 0;

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const imports = extractImports(raw).map((entry) => resolveImport(file, entry));
    const violations = evaluateArchitecture({
      file: toPosixPath(file),
      imports,
      rules,
    });
    for (const violation of violations) {
      process.stderr.write(
        `[arch] ${toPosixPath(path.relative(ROOT, file))}: ${violation.reason} (${violation.toLayer})\n`,
      );
      failures += 1;
    }
  }

  if (failures > 0) {
    process.stderr.write(`[arch] ${failures} architecture violations found\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`[arch] validated ${files.length} files\n`);
}

async function loadRules(): Promise<ArchitectureRuleSet[]> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as { rules: ArchitectureRuleSet[] };
  return parsed.rules;
}

function extractImports(source: string): string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    imports.push(match[1]);
  }
  return imports;
}

function resolveImport(file: string, value: string): string {
  if (value.startsWith(".")) {
    return toPosixPath(path.resolve(path.dirname(file), value));
  }
  if (value.startsWith("/")) {
    return toPosixPath(value);
  }
  return value;
}

function isGeneratedArtifact(file: string): boolean {
  return (
    file.includes("/apps/desktop/.desktop-package/") ||
    file.includes("/apps/desktop/dist/") ||
    file.includes("/apps/desktop/out/") ||
    file.includes("/apps/desktop/resources/") ||
    file.includes("/apps/cli/.cli-package/") ||
    file.includes("/apps/cli/out/")
  );
}

void main().catch((error) => {
  process.stderr.write(`check-architecture failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
