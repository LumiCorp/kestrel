import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMigrationDatabaseConnection } from "./migration-connection";
import {
  assertReleaseControlSourceMigrationContract,
  evaluateReleaseControlBootstrapState,
  releaseDatabaseTargetFingerprint,
  resolveReleaseControlBootstrapConfiguration,
} from "../releases/release-control-schema-bootstrap";
import {
  RELEASE_CONTROL_SCHEMA_MIGRATION_HASH,
  RELEASE_CONTROL_SCHEMA_MIGRATION_TAG,
  RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH,
  RELEASE_CONTROL_SCHEMA_PREDECESSOR_TAG,
} from "../releases/release-control-schema";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relativePath: string) =>
  fs.readFileSync(path.join(appRoot, relativePath), "utf8");

test("Vercel compilation never mutates the database", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  const buildCommands = new Map<string, string>();
  const visitBuildScript = (name: string) => {
    assert.ok(!buildCommands.has(name), `build script cycle at ${name}`);
    const command = packageJson.scripts[name];
    assert.ok(command, `missing ${name} script`);
    buildCommands.set(name, command);
    for (const match of command.matchAll(/\bpnpm run ([\w:-]+)/gu)) {
      visitBuildScript(match[1]);
    }
  };

  visitBuildScript("build");
  assert.ok(
    [...buildCommands.values()].some((command) =>
      /(?:^|&&\s*)next build(?:\s|$)/u.test(command),
    ),
    "build must resolve to a Next.js production compilation",
  );

  const buildChain = [...buildCommands.values()].join("\n");
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (!name.startsWith("db:migrate")) continue;
    assert.doesNotMatch(buildChain, new RegExp(`\\bpnpm run ${name}\\b`, "u"));
    assert.ok(!buildChain.includes(command), `build must not execute ${name}`);
  }
});

test("production migrations serialize and repair known skipped schema", () => {
  const migrate = read("lib/db/migrate.ts");
  const reconciliation = read("lib/db/schema-reconciliation.ts");
  assert.match(migrate, /pg_advisory_lock/u);
  assert.match(migrate, /reconcilePublishedMigrationLedgerTimestamps/u);
  assert.ok(
    migrate.indexOf("reconcilePublishedMigrationLedgerTimestamps(connection)") <
      migrate.indexOf("await migrate(db"),
  );
  assert.match(migrate, /hasKnownMigrationLedgerDrift/u);
  assert.ok(
    migrate.indexOf("hasKnownMigrationLedgerDrift(connection)") <
      migrate.indexOf("await migrate(db"),
  );
  assert.match(reconciliation, /transactionBreakBefore/u);
  assert.match(
    reconciliation,
    /ccd8f19f3733f4e36ec75cbf619a4958b77f2d602adb9cd54ef2db68e17ff581/u,
  );
  assert.match(reconciliation, /timestamp: 1_783_922_400_000/u);
  assert.match(reconciliation, /recordReconciledMigration/u);
  assert.match(reconciliation, /public\.environment_workspaces/u);
  assert.match(reconciliation, /public\.mcp_credentials/u);
  assert.match(
    reconciliation,
    /ALTER TABLE "projects" ALTER COLUMN "environment_id" SET NOT NULL/u,
  );
  for (const tag of [
    "0014_platform_email_config",
    "0015_managed_runpod_deployments",
    "0018_environment_project_ownership",
    "0019_hosted_mcp_control_plane",
    "0020_environment_router_upgrade",
    "0021_mcp_interaction_hardening",
    "0022_mcp_sampling_processing_deadline",
  ]) {
    assert.match(reconciliation, new RegExp(tag, "u"));
  }
});

test("production migrations prefer a direct database connection", () => {
  assert.deepEqual(
    resolveMigrationDatabaseConnection({
      POSTGRES_URL_NON_POOLING: "postgres://direct-postgres",
      DATABASE_URL_UNPOOLED: "postgres://direct-database",
      POSTGRES_URL: "postgres://pooled-postgres",
      DATABASE_URL: "postgres://pooled-database",
    }),
    {
      key: "POSTGRES_URL_NON_POOLING",
      url: "postgres://direct-postgres",
    },
  );
  assert.deepEqual(
    resolveMigrationDatabaseConnection({
      DATABASE_URL_UNPOOLED: "postgres://direct-database",
      POSTGRES_URL: "postgres://pooled-postgres",
      DATABASE_URL: "postgres://pooled-database",
    }),
    {
      key: "DATABASE_URL_UNPOOLED",
      url: "postgres://direct-database",
    },
  );
  assert.deepEqual(
    resolveMigrationDatabaseConnection({
      POSTGRES_URL: "postgres://pooled-postgres",
      DATABASE_URL: "postgres://pooled-database",
    }),
    {
      key: "POSTGRES_URL",
      url: "postgres://pooled-postgres",
    },
  );
  assert.equal(resolveMigrationDatabaseConnection({}), null);
});

test("release-control bootstrap requires the exact approved direct database", () => {
  const direct =
    "postgresql://release:secret@db.example.test:5432/kestrel?sslmode=require";
  const fingerprint = releaseDatabaseTargetFingerprint(direct);
  assert.equal(
    fingerprint,
    releaseDatabaseTargetFingerprint(
      "postgresql://another:credential@DB.EXAMPLE.TEST/kestrel?sslmode=disable",
    ),
  );
  for (const environment of [
    {},
    { POSTGRES_URL: direct },
    { DATABASE_URL: direct },
  ]) {
    assert.throws(
      () => resolveReleaseControlBootstrapConfiguration(environment),
      /POSTGRES_URL_NON_POOLING is required/u,
    );
  }
  assert.throws(
    () =>
      resolveReleaseControlBootstrapConfiguration({
        POSTGRES_URL_NON_POOLING: "not-a-url",
      }),
    /valid PostgreSQL URL/u,
  );
  assert.throws(
    () =>
      resolveReleaseControlBootstrapConfiguration({
        POSTGRES_URL_NON_POOLING: direct,
        KESTREL_RELEASE_DATABASE_TARGET_SHA256: `sha256:${"0".repeat(64)}`,
        GITHUB_SHA: "a".repeat(40),
      }),
    /approved production database target/u,
  );
  assert.deepEqual(
    resolveReleaseControlBootstrapConfiguration({
      POSTGRES_URL_NON_POOLING: direct,
      KESTREL_RELEASE_DATABASE_TARGET_SHA256: fingerprint,
      GITHUB_SHA: "a".repeat(40),
      GITHUB_STEP_SUMMARY: "/tmp/release-summary",
    }),
    {
      databaseUrl: direct,
      expectedTargetFingerprint: fingerprint,
      sourceRevision: "a".repeat(40),
      stepSummaryPath: "/tmp/release-summary",
    },
  );
});

test("release-control bootstrap applies only the exact 0068 to 0069 transition", () => {
  const missing = {
    ready: false,
    missingRequirements: ["migration:0069_unified_release_attempt"],
  };
  assert.equal(
    evaluateReleaseControlBootstrapState({
      readiness: { ready: true, missingRequirements: [] },
      latestHash: "future",
    }),
    "verified",
  );
  assert.equal(
    evaluateReleaseControlBootstrapState({
      readiness: missing,
      latestHash: RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH,
    }),
    "apply",
  );
  assert.throws(
    () =>
      evaluateReleaseControlBootstrapState({
        readiness: missing,
        latestHash: "drifted",
      }),
    /production migration predecessor/u,
  );
});

test("release-control bootstrap rejects source SQL hash drift before migration", () => {
  const migration = (tag: string, hash: string, index: number) => ({
    idx: index,
    version: "7",
    when: index,
    tag,
    breakpoints: true,
    sql: [],
    folderMillis: index,
    hash,
    bps: true,
  });
  assert.doesNotThrow(() =>
    assertReleaseControlSourceMigrationContract([
      migration(
        RELEASE_CONTROL_SCHEMA_PREDECESSOR_TAG,
        RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH,
        68,
      ),
      migration(
        RELEASE_CONTROL_SCHEMA_MIGRATION_TAG,
        RELEASE_CONTROL_SCHEMA_MIGRATION_HASH,
        69,
      ),
      migration("0070_future_migration", "future", 70),
    ]),
  );
  assert.throws(
    () =>
      assertReleaseControlSourceMigrationContract([
        migration(RELEASE_CONTROL_SCHEMA_PREDECESSOR_TAG, "drifted", 68),
        migration(
          RELEASE_CONTROL_SCHEMA_MIGRATION_TAG,
          RELEASE_CONTROL_SCHEMA_MIGRATION_HASH,
          69,
        ),
      ]),
    /source predecessor hash/u,
  );
  assert.throws(
    () =>
      assertReleaseControlSourceMigrationContract([
        migration(
          RELEASE_CONTROL_SCHEMA_PREDECESSOR_TAG,
          RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH,
          68,
        ),
        migration(RELEASE_CONTROL_SCHEMA_MIGRATION_TAG, "drifted", 69),
      ]),
    /source migration hash/u,
  );
  assert.throws(
    () =>
      assertReleaseControlSourceMigrationContract([
        migration(
          RELEASE_CONTROL_SCHEMA_PREDECESSOR_TAG,
          RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH,
          68,
        ),
        migration("0069_interloper", "interloper", 69),
        migration(
          RELEASE_CONTROL_SCHEMA_MIGRATION_TAG,
          RELEASE_CONTROL_SCHEMA_MIGRATION_HASH,
          70,
        ),
      ]),
    /exactly one adjacent/u,
  );
});

test("release-control migration stays outside the Vercel build and fails closed in CI", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  const bootstrap = read("lib/releases/release-control-schema-bootstrap.ts");
  assert.equal(
    packageJson.scripts["db:migrate:release-control"],
    "tsx scripts/ensure-release-control-schema.ts",
  );
  assert.match(bootstrap, /POSTGRES_URL_NON_POOLING is required/u);
  assert.match(bootstrap, /pg_advisory_lock/u);
  assert.match(bootstrap, /pg_advisory_unlock/u);
  assert.doesNotMatch(packageJson.scripts.build, /db:migrate:release-control/u);
});
