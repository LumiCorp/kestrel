import { spawnSync } from "node:child_process";

const suites = [
  {
    label: "web-runner-unit",
    args: ["--import", "tsx", "--test", "tests/unit/web-command.test.ts"],
  },
  {
    label: "web-runner-integration",
    args: ["--import", "tsx", "--test", "tests/integration/web-command.test.ts"],
  },
] as const;

for (const suite of suites) {
  process.stdout.write(`\n[${suite.label}]\n`);
  const result = spawnSync(process.execPath, suite.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
