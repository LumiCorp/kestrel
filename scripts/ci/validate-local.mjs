import { spawnSync } from "node:child_process";
import { CI_LANES, createCiPlan, parseNameStatus } from "./proof-model.mjs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const full = args.includes("--full");
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : "origin/main";
const changes = full
  ? []
  : parseNameStatus(execFileSync("git", ["diff", "--name-status", "-z", base, "HEAD"], { encoding: "utf8" }));
const plan = createCiPlan({ base, head: "HEAD", changes, full });
if (plan.unownedPaths.length) throw new Error(`Unowned paths:\n${plan.unownedPaths.join("\n")}`);

const commands = {
  policy: ["pnpm", ["run", "governance:check"]],
  runtime: ["pnpm", ["run", "ci:runtime"]],
  packages: ["pnpm", ["run", "ci:packages"]],
  web: ["pnpm", ["run", "ci:web"]],
  services: ["pnpm", ["run", "ci:services"]],
  postgres: ["pnpm", ["run", "ci:postgres:local"]],
  product: ["pnpm", ["run", "ci:product"]],
  desktop: ["pnpm", ["run", "ci:desktop"]],
  docs: ["pnpm", ["run", "ci:docs"]],
  "package-macos": ["pnpm", ["run", "ci:package-macos"]],
};

for (const lane of CI_LANES) {
  if (!plan.lanes[lane].selected) continue;
  if (lane === "package-macos" && process.platform !== "darwin") {
    throw new Error("The selected package-macos proof requires macOS.");
  }
  const [command, commandArgs] = commands[lane];
  process.stdout.write(`\n[ci-local] ${lane}: ${command} ${commandArgs.join(" ")}\n`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
