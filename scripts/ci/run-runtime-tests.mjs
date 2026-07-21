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

const isolatedProcessContracts = new Set([
  "tests/integration/web-command.test.ts",
  "tests/unit/local-core-api.test.ts",
]);
const concurrentFiles = files.filter((file) => !isolatedProcessContracts.has(file));
const isolatedFiles = files.filter((file) => isolatedProcessContracts.has(file));

run(concurrentFiles, 4, "runtime unit and integration contracts");
run(isolatedFiles, 1, "isolated Local Core process contracts");

function run(selectedFiles, concurrency, label) {
  if (selectedFiles.length === 0) return;
  process.stdout.write(
    `[runtime-tests] ${label}: files=${selectedFiles.length} concurrency=${concurrency}\n`,
  );
  const result = spawnSync(
    "node",
    ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...selectedFiles],
    {
      env: { ...process.env, ...(process.platform === "darwin" ? { TMPDIR: "/tmp" } : {}) },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
