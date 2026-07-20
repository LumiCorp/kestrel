import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const files = execFileSync(
  "git",
  ["ls-files", "-z", "apps/web/app/**/*.test.ts", "apps/web/lib/**/*.test.ts"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((file) => !file.endsWith(".postgres.test.ts"))
  .map((file) => file.slice("apps/web/".length))
  .sort();

if (files.length === 0) throw new Error("No Kestrel One unit contracts were discovered.");
const result = spawnSync(
  "node",
  ["--import", "tsx", "--test", "--test-reporter=tap", ...files],
  { cwd: path.join(root, "apps/web"), env: process.env, stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
