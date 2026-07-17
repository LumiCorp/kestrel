import { execFileSync, spawnSync } from "node:child_process";
import type { CiGateId } from "../../src/governance/contracts.js";
import { parseCiNameStatus, planCiGates } from "../../src/governance/gates.js";

interface Command {
  executable: string;
  args: string[];
}

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const base = value("--base", "origin/main");
const head = value("--head", "HEAD");
const full = args.includes("--full");
const changes = full ? [] : readLocalChanges(base, head);
const plan = planCiGates({ base, head, changes, full });
const pnpm = (...commandArgs: string[]): Command => ({
  executable: "pnpm",
  args: commandArgs,
});
const commands: Partial<Record<CiGateId, Command[]>> = {
  "static-policy": [
    pnpm("run", "governance:check"),
    pnpm(
      "run",
      "ci:lint",
      "--",
      "--base",
      base,
      "--head",
      head,
      "--include-worktree"
    ),
  ],
  "runtime-unit": [pnpm("run", "ci:runtime")],
  "package-contracts": [pnpm("run", "ci:packages")],
  "web-unit": [pnpm("run", "ci:web")],
  "web-build": [pnpm("run", "ci:web:build")],
  "service-contracts": [pnpm("run", "ci:services")],
  "postgres-integration": [pnpm("run", "ci:postgres:local")],
  "kestrel-one-product": [pnpm("run", "ci:product")],
  "docs-contracts": [pnpm("run", "ci:docs")],
  "desktop-contracts": [pnpm("run", "ci:desktop")],
  "package-macos":
    process.platform === "darwin"
      ? [
          pnpm("run", "cli:package"),
          pnpm("run", "cli:release-check"),
          pnpm("run", "desktop:package"),
          pnpm("run", "desktop:release-check"),
        ]
      : undefined,
};

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
for (const [gate, selection] of Object.entries(plan.gates) as Array<
  [CiGateId, (typeof plan.gates)[CiGateId]]
>) {
  if (!selection.selected) continue;
  const gateCommands = commands[gate];
  if (!gateCommands) {
    process.stdout.write(
      `[validate] ${gate} is unavailable on ${process.platform}.\n`
    );
    continue;
  }
  for (const command of gateCommands) {
    const result = spawnSync(command.executable, command.args, {
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

function readLocalChanges(baseRef: string, headRef: string) {
  const parse = (...diffArgs: string[]) =>
    parseCiNameStatus(execFileSync("git", diffArgs, { encoding: "utf8" }));
  const changes = parse(
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    baseRef,
    headRef
  );
  if (headRef === "HEAD") {
    changes.push(
      ...parse("diff", "--name-status", "-z", "--find-renames", "HEAD"),
      ...execFileSync(
        "git",
        ["ls-files", "--others", "--exclude-standard", "-z"],
        { encoding: "utf8" }
      )
        .split("\0")
        .filter(Boolean)
        .map((path) => ({ status: "A" as const, path }))
    );
  }
  return [
    ...new Map(
      changes.map((change) => [JSON.stringify(change), change])
    ).values(),
  ];
}
