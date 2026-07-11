import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectLocalCoreMigrationState,
  type LocalCoreMigrationReadinessReport,
} from "../src/localCore/index.js";

function printText(report: LocalCoreMigrationReadinessReport): void {
  process.stdout.write(`Kestrel Local Core migration readiness\n`);
  process.stdout.write(`generatedAt: ${report.generatedAt}\n`);
  for (const message of report.messages) {
    process.stdout.write(`- ${message}\n`);
  }
  for (const entry of report.entries) {
    process.stdout.write(`\n${entry.name}: ${entry.status}\n`);
    process.stdout.write(`path: ${entry.path}\n`);
    if (entry.evidence.length > 0) {
      process.stdout.write(`evidence: ${entry.evidence.join(", ")}\n`);
    }
  }
}

function parseArgs(argv: string[]): { json: boolean } {
  return { json: argv.includes("--json") };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const report = detectLocalCoreMigrationState();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printText(report);
  }
}
