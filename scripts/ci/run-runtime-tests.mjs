import { execFileSync, spawnSync } from "node:child_process";

const files = execFileSync(
  "git",
  ["ls-files", "-z", "tests/**/*.test.ts", "agents/**/*.test.ts", "tools/**/*.test.ts"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((file) => !file.startsWith("tests/macos/"))
  .filter((file) => !file.startsWith("tests/ops/"))
  .filter((file) => !file.startsWith("tests/e2e/sdk-ecosystem/"))
  .filter((file) => file !== "tests/smoke/local-dev-shell-service.smoke.ts")
  .sort();

if (files.length === 0) throw new Error("No runtime tests were discovered.");
const result = spawnSync(
  "node",
  ["--import", "tsx", "--test", "--test-concurrency=4", ...files],
  {
    encoding: "utf8",
    env: { ...process.env, ...(process.platform === "darwin" ? { TMPDIR: "/tmp" } : {}) },
  },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
