import { appendFileSync } from "node:fs";
import type { CiGatePlan } from "../../src/governance/contracts.js";
import { CI_GATE_IDS } from "../../src/governance/gates.js";

const plan = JSON.parse(process.env.CI_GATE_PLAN ?? "") as CiGatePlan;
const results = JSON.parse(process.env.CI_JOB_RESULTS ?? "") as Record<
  string,
  { result?: string | undefined }
>;
const failures: string[] = [];

if (process.env.CI_PLAN_RESULT !== "success") {
  failures.push(
    `ci-plan: expected success, received ${process.env.CI_PLAN_RESULT ?? "missing"}`
  );
}

for (const gate of CI_GATE_IDS) {
  const result = results[gate]?.result ?? "missing";
  const selected = plan.gates[gate].selected;
  if (selected && result !== "success")
    failures.push(`${gate}: expected success, received ${result}`);
  if (!selected && result !== "skipped")
    failures.push(`${gate}: expected skipped, received ${result}`);
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const rows = CI_GATE_IDS.map(
    (gate) =>
      `| \`${gate}\` | ${plan.gates[gate].selected ? "selected" : "excluded"} | ${results[gate]?.result ?? "missing"} |`
  );
  appendFileSync(
    summaryPath,
    [
      "## Required gate results",
      "",
      "| Gate | Plan | Result |",
      "| --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
    "utf8"
  );
}

if (failures.length > 0)
  throw new Error(`Required CI gate mismatch:\n${failures.join("\n")}`);
process.stdout.write(
  `All ${CI_GATE_IDS.filter((gate) => plan.gates[gate].selected).length} selected CI gates passed.\n`
);
