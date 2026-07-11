import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_LINT_INVARIANTS,
  checkInvariantViolations,
  resolveInvariantSeverity,
} from "../src/governance/invariants.js";
import { listFiles, toPosixPath } from "./governance-utils.js";

const ROOT = process.cwd();

async function main(): Promise<void> {
  const files = await listFiles(
    ROOT,
    (file) =>
      file.endsWith(".ts") &&
      isGeneratedArtifact(file) === false &&
      file.includes("/.external/") === false &&
      (file.includes("/src/") ||
        file.includes("/tools/") ||
        file.includes("/apps/web/")),
  );
  let failures = 0;
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const violations = checkInvariantViolations({
      file: toPosixPath(file),
      content: raw,
    });
    for (const violation of violations) {
      const invariant = DEFAULT_LINT_INVARIANTS.find((candidate) => candidate.rule_id === violation.rule_id);
      const relativeFile = toPosixPath(path.relative(ROOT, file));
      const level = resolveInvariantSeverity(invariant, relativeFile);
      process.stderr.write(
        `[invariants][${level}] ${relativeFile} ${violation.rule_id}: ${violation.message}\n`,
      );
      if (level === "error") {
        failures += 1;
      }
    }
  }
  if (failures > 0) {
    process.stderr.write(`[invariants] failed with ${failures} error-level violations\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("[invariants] checks passed\n");
}

function isGeneratedArtifact(file: string): boolean {
  return (
    file.includes("/apps/desktop/.desktop-package/") ||
    file.includes("/apps/desktop/dist/") ||
    file.includes("/apps/desktop/out/") ||
    file.includes("/apps/desktop/resources/")
  );
}

void main().catch((error) => {
  process.stderr.write(`check-invariants failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
