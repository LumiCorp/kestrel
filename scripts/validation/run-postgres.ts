import { execFileSync, spawnSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "-z", "apps/web/**/*.postgres.test.ts"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .concat("apps/web/lib/environments/cutover-readiness.postgres.test.ts")
  .filter((file, index, all) => all.indexOf(file) === index)
  .sort()
  .map((file) => file.slice("apps/web/".length));

if (files.length === 0) throw new Error("No PostgreSQL contracts were discovered.");

const result = spawnSync(process.execPath, [
  "--conditions=react-server",
  "--import", "tsx",
  "--test",
  "--test-concurrency=1",
  "--test-reporter=spec",
  ...files,
], {
  cwd: "apps/web",
  env: {
    ...process.env,
    DATABASE_URL: required("KESTREL_TURN_DB_TEST_URL"),
    POSTGRES_URL: required("KESTREL_TURN_DB_TEST_URL"),
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
