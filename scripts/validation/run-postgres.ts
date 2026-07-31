import { execFileSync, spawn } from "node:child_process";

const files = execFileSync("git", ["ls-files", "-z", "apps/web/**/*.postgres.test.ts"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .concat(
    "apps/web/lib/costs/store.postgres.test.ts",
    "apps/web/lib/environments/desktop.postgres.test.ts",
    "apps/web/lib/environments/cutover-readiness.postgres.test.ts",
    "apps/web/lib/projects/skills.postgres.test.ts",
  )
  .filter((file, index, all) => all.indexOf(file) === index)
  .sort()
  .map((file) => file.slice("apps/web/".length));

if (files.length === 0) throw new Error("No PostgreSQL contracts were discovered.");

const runtimeFiles = execFileSync("git", ["ls-files", "-z", "tests/**/*.postgres.test.ts"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .concat("tests/mission-control-project-authority.postgres.test.ts")
  .filter((file, index, all) => all.indexOf(file) === index)
  .sort();

const groups = [
  {
    name: "Apps",
    databaseUrl: required("KESTREL_APPS_DB_TEST_URL"),
    files: [
      "lib/apps/service.postgres.test.ts",
      "lib/db/edge-only-retirement.postgres.test.ts",
    ],
  },
  {
    name: "Environment",
    databaseUrl: required("KESTREL_ENVIRONMENT_DB_TEST_URL"),
    files: [
      "lib/ai/gateways.postgres.test.ts",
      "lib/costs/store.postgres.test.ts",
      "lib/email/config.postgres.test.ts",
      "lib/environments/backup-execution-guard.postgres.test.ts",
      "lib/environments/cutover-readiness.postgres.test.ts",
      "lib/environments/desktop.postgres.test.ts",
      "lib/environments/fly-connection.postgres.test.ts",
      "lib/environments/reconcile-lock.postgres.test.ts",
      "lib/environments/reconciliation-status.postgres.test.ts",
      "lib/environments/store.postgres.test.ts",
      "lib/integrations/github-action-approvals.postgres.test.ts",
      "lib/projects/skills.postgres.test.ts",
    ],
  },
  {
    name: "Turns",
    databaseUrl: required("KESTREL_TURN_DB_TEST_URL"),
    files: [
      "lib/turns/mobile-store.postgres.test.ts",
      "lib/turns/store.postgres.test.ts",
    ],
  },
];

const assigned = groups.flatMap((group) => group.files).sort();
if (JSON.stringify(assigned) !== JSON.stringify(files)) {
  throw new Error(`PostgreSQL contract assignment drifted.\nDiscovered: ${files.join(", ")}\nAssigned: ${assigned.join(", ")}`);
}

await Promise.all([
  ...groups.map(runGroup),
  runRuntimeGroup(),
]);

function runGroup(group: (typeof groups)[number]): Promise<void> {
  process.stdout.write(`[postgres] ${group.name}: ${group.files.join(", ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--conditions=react-server",
      "--import", "tsx",
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      ...group.files,
    ], {
      cwd: "apps/web",
      env: {
        ...process.env,
        DATABASE_URL: group.databaseUrl,
        POSTGRES_URL: group.databaseUrl,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${group.name} PostgreSQL contracts failed${signal ? ` from ${signal}` : ` with exit ${code ?? 1}`}`));
    });
  });
}

function runRuntimeGroup(): Promise<void> {
  if (
    JSON.stringify(runtimeFiles) !==
    JSON.stringify(["tests/mission-control-project-authority.postgres.test.ts"])
  ) {
    throw new Error(
      `Runtime PostgreSQL contract assignment drifted.\nDiscovered: ${runtimeFiles.join(", ")}`,
    );
  }
  process.stdout.write(`[postgres] Runtime: ${runtimeFiles.join(", ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "tsx",
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      ...runtimeFiles,
    ], {
      env: {
        ...process.env,
        KESTREL_PRODUCT_RUNNER_DATABASE_URL: required(
          "KESTREL_PRODUCT_RUNNER_DATABASE_URL",
        ),
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(
        new Error(
          `Runtime PostgreSQL contracts failed${signal ? ` from ${signal}` : ` with exit ${code ?? 1}`}`,
        ),
      );
    });
  });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
