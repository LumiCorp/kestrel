import { execFileSync, spawnSync } from "node:child_process";

const DATABASE_ENVIRONMENTS = [
  "KESTREL_TURN_DB_TEST_URL",
  "KESTREL_ENVIRONMENT_DB_TEST_URL",
  "KESTREL_APPS_DB_TEST_URL",
] as const;

const databaseUrls = DATABASE_ENVIRONMENTS.map((name) => {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for PostgreSQL integration.`);
  return value;
});

const uniqueDatabaseUrls = [...new Set(databaseUrls)];
for (const databaseUrl of uniqueDatabaseUrls) {
  for (let pass = 1; pass <= 2; pass += 1) {
    process.stdout.write(
      `[postgres-integration] migration pass ${pass}/2 for database ${uniqueDatabaseUrls.indexOf(databaseUrl) + 1}/${uniqueDatabaseUrls.length}\n`
    );
    run("pnpm", ["--filter", "@kestrel/kestrel-one", "db:migrate"], {
      ...process.env,
      DATABASE_URL: databaseUrl,
      POSTGRES_URL: databaseUrl,
    });
    run("pnpm", ["--filter", "@kestrel/kestrel-one", "db:migrate:contract"], {
      ...process.env,
      DATABASE_URL: databaseUrl,
      POSTGRES_URL: databaseUrl,
    });
  }
}

const files = execFileSync(
  "git",
  ["ls-files", "-z", "apps/web/**/*.postgres.test.ts"],
  { encoding: "utf8" }
)
  .split("\0")
  .filter(Boolean)
  .sort();
if (files.length === 0) {
  throw new Error("No PostgreSQL integration suites were discovered.");
}

process.stdout.write(
  `[postgres-integration] executing ${files.length} PostgreSQL suites serially\n`
);
const result = spawnSync(
  "node",
  [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
    ...files.map((file) => file.slice("apps/web/".length)),
  ],
  {
    cwd: "apps/web",
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrls[0],
      POSTGRES_URL: databaseUrls[0],
    },
  }
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);
if (
  /^(?:ok|not ok)\b.*# SKIP\b/imu.test(result.stdout ?? "") ||
  /^# skipped [1-9]\d*$/gmu.test(result.stdout ?? "")
) {
  throw new Error("PostgreSQL integration reported a skipped test.");
}
process.stdout.write(
  `[postgres-integration] migrations=passed-twice suites=${files.length} skips=0\n`
);

function run(executable: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(executable, args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
