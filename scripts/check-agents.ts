import { access, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const AGENTS = path.join(ROOT, "AGENTS.md");

const REQUIRED_SECTIONS = [
  "## Mission",
  "## Context Map",
  "## Execution Rules",
  "## Validation Gates",
  "## Escalation",
];

async function main(): Promise<void> {
  await access(AGENTS);
  const raw = await readFile(AGENTS, "utf8");

  let failures = 0;
  for (const section of REQUIRED_SECTIONS) {
    if (raw.includes(section) === false) {
      process.stderr.write(`[agents] missing section: ${section}\n`);
      failures += 1;
    }
  }

  const linkMatches = [...raw.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
  for (const match of linkMatches) {
    const target = match[1];
    if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) {
      continue;
    }
    const resolved = path.resolve(ROOT, target);
    try {
      await access(resolved);
    } catch {
      process.stderr.write(`[agents] broken link target: ${target}\n`);
      failures += 1;
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("[agents] AGENTS.md contract valid\n");
}

void main().catch((error) => {
  process.stderr.write(`check-agents failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
