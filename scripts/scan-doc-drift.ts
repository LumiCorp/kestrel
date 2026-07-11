import { readFile } from "node:fs/promises";
import path from "node:path";

import { findDocDrift, loadDocIndexEntry } from "../src/governance/docs.js";
import type { DocDriftFinding } from "../src/governance/contracts.js";
import { listFiles, toPosixPath } from "./governance-utils.js";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");

async function main(): Promise<void> {
  const files = await listFiles(DOCS_DIR, (file) => file.endsWith(".md"));
  const findings: DocDriftFinding[] = [];
  const now = new Date();

  for (const file of files) {
    const entry = await loadDocIndexEntry(file);
    if (entry === null) {
      continue;
    }
    const content = await readFile(file, "utf8");
    findings.push(
      ...findDocDrift({
        docPath: toPosixPath(path.relative(ROOT, file)),
        entry,
        now,
        staleAfterDays: 45,
        content,
      }),
    );
  }

  if (findings.length === 0) {
    process.stdout.write("doc-drift findings=0\n");
    return;
  }
  process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`scan-doc-drift failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
