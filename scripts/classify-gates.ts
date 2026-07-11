import { checksForTier, classifyRiskTier } from "../src/governance/gates.js";

async function main(): Promise<void> {
  const changed = (process.env.CHANGED_PATHS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const tier = classifyRiskTier(changed);
  const checks = checksForTier(tier);
  process.stdout.write(
    `${JSON.stringify({ tier, checks, changedPaths: changed }, null, 2)}\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`classify-gates failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
