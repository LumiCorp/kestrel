import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { CI_LANES, componentsForPath, createCiPlan, parseNameStatus } from "./proof-model.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const base = option("--base", process.env.CI_BASE_SHA ?? "origin/main");
const head = option("--head", process.env.CI_HEAD_SHA ?? "HEAD");
const outputPath = option("--github-output", process.env.GITHUB_OUTPUT);
const full = args.includes("--full") || process.env.CI_FULL === "true";
const verifyOwnership = args.includes("--verify-ownership");

const git = (gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8" });
const readChanges = () => {
  const changes = parseNameStatus(
    git(["diff", "--name-status", "-z", "--find-renames", base, head]),
  );
  if (head === "HEAD") {
    changes.push(
      ...parseNameStatus(git(["diff", "--name-status", "-z", "--find-renames", "HEAD"])),
      ...git(["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean)
        .map((path) => ({ status: "A", path })),
    );
  }
  return [...new Map(changes.map((change) => [JSON.stringify(change), change])).values()];
};

const changes = full ? [] : readChanges();
const plan = createCiPlan({ base, head, changes, full });
const trackedUnowned = verifyOwnership
  ? git(["ls-files", "-z"])
      .split("\0")
      .filter(Boolean)
      .filter((file) => componentsForPath(file).length === 0)
  : [];
plan.unownedPaths = [...new Set([...plan.unownedPaths, ...trackedUnowned])].sort();

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

if (outputPath) {
  const lines = [
    "plan<<KESTREL_CI_PLAN",
    JSON.stringify(plan),
    "KESTREL_CI_PLAN",
    `base=${plan.base}`,
    `head=${plan.head}`,
  ];
  for (const lane of CI_LANES) {
    lines.push(`${lane.replaceAll("-", "_")}=${plan.lanes[lane].selected}`);
  }
  appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const catalog = JSON.parse(readFileSync("tests/proof/catalog.json", "utf8"));
  const selectedLanes = new Set(CI_LANES.filter((lane) => plan.lanes[lane].selected));
  const selectedTests = catalog.tests.filter((item) => selectedLanes.has(item.lane));
  const selectedContracts = [...new Set(selectedTests.map((item) => item.contractId))].sort();
  const rows = CI_LANES.map((lane) => {
    const selection = plan.lanes[lane];
    return `| \`${lane}\` | ${selection.selected ? "selected" : "excluded"} | ${selection.reasons.join("<br>") || "No owned change"} |`;
  });
  appendFileSync(
    summaryPath,
    [
      "## Contract-proof plan",
      "",
      `Components: ${plan.components.map((value) => `\`${value}\``).join(", ") || "none"}`,
      `Contracts: ${selectedContracts.map((value) => `\`${value}\``).join(", ") || "none"}`,
      `Registered tests: ${selectedTests.length}`,
      "",
      "| Lane | Decision | Exact reasons |",
      "| --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
    "utf8",
  );
}

if (plan.unownedPaths.length > 0) {
  throw new Error(
    `CI component ownership is missing for:\n${plan.unownedPaths.map((file) => `- ${file}`).join("\n")}`,
  );
}
