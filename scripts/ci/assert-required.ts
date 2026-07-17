import { appendFileSync } from "node:fs";
import { CI_GATE_IDS } from "../../src/governance/gates.js";

function parseCiEnvironment(name: string): Record<string, unknown> {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${name} must be a JSON object: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

const selections = parseCiEnvironment("CI_GATE_SELECTIONS");
const results = parseCiEnvironment("CI_GATE_RESULTS");
const failures: string[] = [];

if (process.env.CI_PLAN_RESULT !== "success") {
  failures.push(
    `ci-plan: expected success, received ${process.env.CI_PLAN_RESULT ?? "missing"}`
  );
}

for (const gate of CI_GATE_IDS) {
  const selected = selections[gate];
  const result = results[gate] ?? "missing";
  if (typeof selected !== "boolean") {
    failures.push(`${gate}: selection must be boolean, received ${String(selected)}`);
    continue;
  }
  if (typeof result !== "string") {
    failures.push(`${gate}: result must be string, received ${String(result)}`);
    continue;
  }
  if (selected && result !== "success")
    failures.push(`${gate}: expected success, received ${result}`);
  if (!selected && result !== "skipped")
    failures.push(`${gate}: expected skipped, received ${result}`);
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const rows = CI_GATE_IDS.map(
    (gate) =>
      `| \`${gate}\` | ${selections[gate] === true ? "selected" : "excluded"} | ${results[gate] ?? "missing"} |`
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
  `All ${CI_GATE_IDS.filter((gate) => selections[gate] === true).length} selected CI gates passed.\n`
);
