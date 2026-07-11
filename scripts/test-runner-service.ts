import { spawnSync } from "node:child_process";

const suites = [
  {
    label: "runner-service-core",
    args: [
      "--import",
      "tsx",
      "--test",
      "tests/integration/runner-protocol.test.ts",
      "tests/integration/runner-service-parity-smoke.test.ts",
      "tests/integration/runner-service.test.ts",
      "tests/integration/runner-service-openai-compat.test.ts",
      "tests/unit/remote-runner-transport.test.ts",
      "tests/unit/native-runner-client.test.ts",
      "tests/unit/web-runner-adapter.test.ts",
      "apps/web/tests/routes.test.ts",
    ],
  },
  {
    label: "runner-service-http",
    args: ["--import", "tsx", "--test", "tests/integration/runner-service-http.test.ts"],
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
