import { appendFileSync } from "node:fs";
import { assertRequiredLaneResults, CI_LANES } from "./proof-model.mjs";

function parseObject(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed;
}

const selections = parseObject("CI_LANE_SELECTIONS");
const results = parseObject("CI_LANE_RESULTS");
assertRequiredLaneResults({
  planResult: process.env.CI_PLAN_RESULT ?? "missing",
  selections,
  results,
});

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  appendFileSync(
    summaryPath,
    [
      "## Required contract-proof results",
      "",
      "| Lane | Plan | Result |",
      "| --- | --- | --- |",
      ...CI_LANES.map(
        (lane) => `| \`${lane}\` | ${selections[lane] === true ? "selected" : "excluded"} | ${results[lane] ?? "missing"} |`,
      ),
      "",
    ].join("\n"),
    "utf8",
  );
}

process.stdout.write(
  `All ${CI_LANES.filter((lane) => selections[lane] === true).length} selected contract-proof lanes passed.\n`,
);
