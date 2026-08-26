import { execFileSync, spawn } from "node:child_process";

const files = execFileSync(
  "git",
  ["ls-files", "-z", "apps/web/**/*.postgres.test.ts"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .concat(
    "apps/web/lib/knowledge/queue.postgres.test.ts",
    "apps/web/lib/ai/managed-runpod-lifecycle.postgres.test.ts",
    "apps/web/lib/costs/store.postgres.test.ts",
    "apps/web/lib/environments/authorization-renewal.postgres.test.ts",
    "apps/web/lib/environments/desktop.postgres.test.ts",
    "apps/web/lib/environments/cutover-readiness.postgres.test.ts",
    "apps/web/lib/environments/workspace-backup-revision.postgres.test.ts",
    "apps/web/lib/mobile/v2/snapshot.postgres.test.ts",
    "apps/web/lib/projects/context-grants.postgres.test.ts",
    "apps/web/lib/projects/skills.postgres.test.ts",
    "apps/web/lib/schedules/store.postgres.test.ts",
    "apps/web/lib/signup-access-codes.postgres.test.ts",
    "apps/web/lib/files/service.postgres.test.ts",
    "apps/web/lib/files/availability.postgres.test.ts",
    "apps/web/lib/files/blob-repair-atomicity.postgres.test.ts",
  )
  .filter((file, index, all) => all.indexOf(file) === index)
  .sort()
  .map((file) => file.slice("apps/web/".length));

if (files.length === 0)
  throw new Error("No PostgreSQL contracts were discovered.");

const runtimeFiles = execFileSync(
  "git",
  ["ls-files", "-z", "tests/**/*.postgres.test.ts"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .concat(
    "tests/action-bound-approval-grants.postgres.test.ts",
    "tests/budget-ledger.postgres.test.ts",
    "tests/mission-control-project-authority.postgres.test.ts",
    "tests/mission-control-review-acceptance.postgres.test.ts",
    "tests/sandbox-capability-leases.postgres.test.ts",
  )
  .filter((file, index, all) => all.indexOf(file) === index)
  .sort();

const mcpFiles = execFileSync(
  "git",
  ["ls-files", "-z", "apps/mcp-service/**/*.postgres.test.ts"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .concat("apps/mcp-service/tests/approval-authorizer.postgres.test.ts")
  .filter((file, index, all) => all.indexOf(file) === index)
  .sort()
  .map((file) => file.slice("apps/mcp-service/".length));

const groups = [
  {
    name: "Apps",
    databaseUrl: required("KESTREL_APPS_DB_TEST_URL"),
    files: [
      "lib/apps/service.postgres.test.ts",
      "lib/db/edge-only-retirement.postgres.test.ts",
      "lib/signup-access-codes.postgres.test.ts",
    ],
  },
  {
    name: "Environment",
    databaseUrl: required("KESTREL_ENVIRONMENT_DB_TEST_URL"),
    files: [
      "lib/ai/gateways.postgres.test.ts",
      "lib/ai/managed-runpod-lifecycle.postgres.test.ts",
      "lib/costs/store.postgres.test.ts",
      "lib/email/config.postgres.test.ts",
      "lib/environments/authorization-renewal.postgres.test.ts",
      "lib/environments/backup-execution-guard.postgres.test.ts",
      "lib/environments/config.postgres.test.ts",
      "lib/environments/cutover-readiness.postgres.test.ts",
      "lib/environments/desktop.postgres.test.ts",
      "lib/environments/fly-connection.postgres.test.ts",
      "lib/environments/reconcile-lock.postgres.test.ts",
      "lib/environments/reconciliation-status.postgres.test.ts",
      "lib/environments/runtime-channel.postgres.test.ts",
      "lib/environments/store.postgres.test.ts",
      "lib/environments/workspace-backup-revision.postgres.test.ts",
      "lib/files/availability.postgres.test.ts",
      "lib/files/blob-repair-atomicity.postgres.test.ts",
      "lib/files/service.postgres.test.ts",
      "lib/integrations/github-action-approvals.postgres.test.ts",
      "lib/knowledge/queue.postgres.test.ts",
      "lib/projects/skills.postgres.test.ts",
      "lib/schedules/store.postgres.test.ts",
      "scripts/lib/reset-organization-files.postgres.test.ts",
    ],
  },
  {
    name: "Turns",
    databaseUrl: required("KESTREL_TURN_DB_TEST_URL"),
    files: [
      "lib/projects/context-grants.postgres.test.ts",
      "lib/mobile/v2/snapshot.postgres.test.ts",
      "lib/turns/conversation-snapshot.postgres.test.ts",
      "lib/turns/mobile-store.postgres.test.ts",
      "lib/turns/store.postgres.test.ts",
    ],
  },
];

const assigned = groups.flatMap((group) => group.files).sort();
if (JSON.stringify(assigned) !== JSON.stringify(files)) {
  throw new Error(
    `PostgreSQL contract assignment drifted.\nDiscovered: ${files.join(", ")}\nAssigned: ${assigned.join(", ")}`,
  );
}

await Promise.all([...groups.map(runGroup), runMcpGroup(), runRuntimeGroup()]);

function runMcpGroup(): Promise<void> {
  if (
    JSON.stringify(mcpFiles) !==
    JSON.stringify(["tests/approval-authorizer.postgres.test.ts"])
  ) {
    throw new Error(
      `MCP PostgreSQL contract assignment drifted.\nDiscovered: ${mcpFiles.join(", ")}`,
    );
  }
  process.stdout.write(`[postgres] MCP: ${mcpFiles.join(", ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        ...mcpFiles,
      ],
      {
        cwd: "apps/mcp-service",
        env: {
          ...process.env,
          KESTREL_PRODUCT_RUNNER_DATABASE_URL: required(
            "KESTREL_PRODUCT_RUNNER_DATABASE_URL",
          ),
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `MCP PostgreSQL contracts failed${signal ? ` from ${signal}` : ` with exit ${code ?? 1}`}`,
          ),
        );
    });
  });
}

function runGroup(group: (typeof groups)[number]): Promise<void> {
  process.stdout.write(`[postgres] ${group.name}: ${group.files.join(", ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        ...group.files,
      ],
      {
        cwd: "apps/web",
        env: {
          ...process.env,
          DATABASE_URL: group.databaseUrl,
          POSTGRES_URL: group.databaseUrl,
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${group.name} PostgreSQL contracts failed${signal ? ` from ${signal}` : ` with exit ${code ?? 1}`}`,
          ),
        );
    });
  });
}

function runRuntimeGroup(): Promise<void> {
  if (
    JSON.stringify(runtimeFiles) !==
    JSON.stringify([
      "tests/action-bound-approval-grants.postgres.test.ts",
      "tests/budget-ledger.postgres.test.ts",
      "tests/mission-control-project-authority.postgres.test.ts",
      "tests/mission-control-review-acceptance.postgres.test.ts",
      "tests/sandbox-capability-leases.postgres.test.ts",
    ])
  ) {
    throw new Error(
      `Runtime PostgreSQL contract assignment drifted.\nDiscovered: ${runtimeFiles.join(", ")}`,
    );
  }
  process.stdout.write(`[postgres] Runtime: ${runtimeFiles.join(", ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        ...runtimeFiles,
      ],
      {
        env: {
          ...process.env,
          KESTREL_PRODUCT_RUNNER_DATABASE_URL: required(
            "KESTREL_PRODUCT_RUNNER_DATABASE_URL",
          ),
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
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
