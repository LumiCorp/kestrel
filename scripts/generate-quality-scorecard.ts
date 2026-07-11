import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildQualityScorecard } from "../src/governance/qualityScorecard.js";

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, "docs", "generated", "quality-scorecard.json");

async function main(): Promise<void> {
  const scorecard = buildQualityScorecard([
    {
      domain: "runtime",
      architectureCompliance: 88,
      testDepth: 84,
      incidentRate: 18,
      drift: 12,
      replayStability: 90,
      latency: 78,
      previousScore: 82,
    },
    {
      domain: "web",
      architectureCompliance: 80,
      testDepth: 72,
      incidentRate: 25,
      drift: 22,
      replayStability: 76,
      latency: 74,
      previousScore: 76,
    },
    {
      domain: "tooling",
      architectureCompliance: 86,
      testDepth: 81,
      incidentRate: 16,
      drift: 19,
      replayStability: 84,
      latency: 80,
      previousScore: 80,
    },
  ]);

  await writeFile(OUTPUT, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  process.stdout.write(`quality-scorecard written: ${path.relative(ROOT, OUTPUT)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`generate-quality-scorecard failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
