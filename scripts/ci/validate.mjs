import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const proofSystemTests = readdirSync(path.join("scripts", "ci"))
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => path.join("scripts", "ci", file));

const steps = [
  ["Node.js 22 preflight", pnpm, ["run", "validate:node"]],
  ["shared package build", pnpm, ["run", "ci:build:shared"]],
  ["root typecheck", pnpm, ["run", "typecheck"]],
  ["proof-system tests", process.execPath, ["--test", ...proofSystemTests]],
  ["governance", pnpm, ["run", "governance:check"]],
  ["Ruhroh configuration", pnpm, ["run", "ruhroh:validate"]],
  ["OpenAPI drift", pnpm, ["run", "ci:openapi-drift"]],
  ["route ownership", pnpm, ["run", "ci:route-ownership"]],
  ["runtime", pnpm, ["run", "ci:runtime"]],
  ["public packages", pnpm, ["run", "ci:packages"]],
  ["Web", pnpm, ["run", "ci:web"]],
  ["hosted services", pnpm, ["run", "ci:services"]],
  ["Docker PostgreSQL", pnpm, ["run", "ci:postgres:local"]],
  ["Chromium product", pnpm, ["run", "ci:product"]],
  ["Desktop", pnpm, ["run", "ci:desktop"]],
  ["documentation", pnpm, ["run", "ci:docs"]],
];

if (proofSystemTests.length === 0) {
  throw new Error("No proof-system tests were discovered under scripts/ci.");
}

for (const [label, command, args] of steps) {
  process.stdout.write(`\n[validate] ${label}: ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    env: { ...process.env, CI: "true" },
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(`[validate] FAILED: ${label}\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("\n[validate] complete\n");
