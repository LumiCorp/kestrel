import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadDocIndexEntry, requiresFreshness } from "../src/governance/docs.js";
import { listFiles, toPosixPath } from "./governance-utils.js";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const ROOT_DOCS = [
  path.join(ROOT, "ARCHITECTURE.md"),
  path.join(ROOT, "DESIGN.md"),
  path.join(ROOT, "RELIABILITY.md"),
  path.join(ROOT, "SECURITY.md"),
  path.join(ROOT, "QUALITY_SCORE.md"),
];
const STALE_AFTER_DAYS = Number.parseInt(process.env.DOC_STALE_DAYS ?? "45", 10);

async function main(): Promise<void> {
  const files = [...(await listFiles(DOCS_DIR, (file) => file.endsWith(".md"))), ...ROOT_DOCS];
  let failures = 0;

  for (const file of files) {
    const relative = toPosixPath(path.relative(ROOT, file));
    const raw = await readFile(file, "utf8");
    const entry = await loadDocIndexEntry(file);
    if (entry === null) {
      process.stderr.write(`[docs] missing frontmatter entry: ${relative}\n`);
      failures += 1;
      continue;
    }
    const date = new Date(entry.last_verified_at);
    if (Number.isFinite(date.getTime()) === false) {
      process.stderr.write(`[docs] invalid last_verified_at: ${relative}\n`);
      failures += 1;
    }
    const ageDays = (Date.now() - date.getTime()) / (24 * 60 * 60 * 1000);
    if (requiresFreshness(entry) && ageDays > STALE_AFTER_DAYS) {
      process.stderr.write(
        `[docs] stale document (${Math.floor(ageDays)}d > ${STALE_AFTER_DAYS}d): ${relative}\n`,
      );
      failures += 1;
    }
    if (/\[[^\]]+\]\([^)]+\)/.test(raw) === false) {
      process.stdout.write(`[docs][warn] no links found: ${relative}\n`);
    }
  }

  if (failures > 0) {
    process.stderr.write(`[docs] failed with ${failures} issues\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`[docs] validated ${files.length} markdown files\n`);
}

void main().catch((error) => {
  process.stderr.write(`check-docs failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
