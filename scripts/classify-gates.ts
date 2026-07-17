import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import type { CiChangedPath } from "../src/governance/contracts.js";
import {
  CI_GATE_IDS,
  classifyOwnedPath,
  parseCiNameStatus,
  planCiGates,
} from "../src/governance/gates.js";

interface Options {
  base: string;
  head: string;
  full: boolean;
  githubOutput?: string | undefined;
  verifyOwnership: boolean;
}

function readOptions(args: string[]): Options {
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    base: value("--base") ?? process.env.CI_BASE_SHA ?? "origin/main",
    head: value("--head") ?? process.env.CI_HEAD_SHA ?? "HEAD",
    full: args.includes("--full") || process.env.CI_FULL === "true",
    githubOutput: value("--github-output") ?? process.env.GITHUB_OUTPUT,
    verifyOwnership: args.includes("--verify-ownership"),
  };
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function readChanges(base: string, head: string): CiChangedPath[] {
  return parseCiNameStatus(
    git(["diff", "--name-status", "-z", "--find-renames", base, head])
  );
}

function verifyTrackedOwnership(): string[] {
  return git(["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .filter((path) => classifyOwnedPath(path).length === 0);
}

async function writeGitHubOutput(
  path: string,
  plan: ReturnType<typeof planCiGates>
) {
  const lines = [
    "plan<<KESTREL_CI_PLAN",
    JSON.stringify(plan),
    "KESTREL_CI_PLAN",
    `base=${plan.base}`,
    `head=${plan.head}`,
  ];
  for (const gate of CI_GATE_IDS) {
    lines.push(`${gate.replaceAll("-", "_")}=${plan.gates[gate].selected}`);
  }
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function writeGitHubSummary(plan: ReturnType<typeof planCiGates>) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const rows = CI_GATE_IDS.map((gate) => {
    const selection = plan.gates[gate];
    const reasons =
      selection.reasons.join("<br>") ||
      "Not selected by the ownership manifest";
    return `| \`${gate}\` | ${selection.selected ? "selected" : "skipped"} | ${reasons} |`;
  });
  const content = [
    "## CI gate plan",
    "",
    `Base: \`${plan.base}\`  `,
    `Head: \`${plan.head}\`  `,
    `Risk: **${plan.risk}**  `,
    `Mode: **${plan.full ? "full" : "changed paths"}**`,
    "",
    "| Gate | Decision | Reason |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  await appendFile(summaryPath, content, "utf8");
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  const ownershipFailures = options.verifyOwnership
    ? verifyTrackedOwnership()
    : [];
  const changes = options.full ? [] : readChanges(options.base, options.head);
  const plan = planCiGates({
    base: options.base,
    head: options.head,
    changes,
    full: options.full,
  });
  const unowned = [
    ...new Set([...ownershipFailures, ...plan.unownedPaths]),
  ].sort();
  const reportedPlan = { ...plan, unownedPaths: unowned };
  process.stdout.write(`${JSON.stringify(reportedPlan, null, 2)}\n`);
  if (options.githubOutput)
    await writeGitHubOutput(options.githubOutput, reportedPlan);
  await writeGitHubSummary(reportedPlan);
  if (unowned.length > 0) {
    throw new Error(
      `CI ownership is missing for:\n${unowned.map((path) => `- ${path}`).join("\n")}`
    );
  }
}

void main().catch((error) => {
  process.stderr.write(
    `classify-gates failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
