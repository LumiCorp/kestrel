import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import {
  inspectReleaseControlSchema,
  RELEASE_CONTROL_SCHEMA_MIGRATION_HASH,
  RELEASE_CONTROL_SCHEMA_MIGRATION_TAG,
  RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH,
  RELEASE_CONTROL_SCHEMA_PREDECESSOR_TAG,
  type ReleaseControlSchemaReadiness,
} from "./release-control-schema";

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../db/migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_FOLDER, "meta/_journal.json");
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const TARGET_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type ReleaseControlBootstrapConfiguration = {
  databaseUrl: string;
  expectedTargetFingerprint: string;
  sourceRevision: string;
  stepSummaryPath?: string;
};

export type ReleaseControlBootstrapResult = {
  action: "applied" | "verified";
  sourceRevision: string;
  targetFingerprint: string;
  databaseName: string;
  beforeHash: string;
  afterHash: string;
  migrationTag: typeof RELEASE_CONTROL_SCHEMA_MIGRATION_TAG;
};

export type ReleaseControlBootstrapDependencies = {
  applyMigration?: (
    connection: Sql,
    target: TaggedMigrationMeta,
  ) => Promise<void>;
};

type MigrationJournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

export type TaggedMigrationMeta = MigrationMeta & MigrationJournalEntry;

export function resolveReleaseControlBootstrapConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ReleaseControlBootstrapConfiguration {
  const databaseUrl = environment.POSTGRES_URL_NON_POOLING?.trim();
  if (!databaseUrl) {
    throw new Error(
      "POSTGRES_URL_NON_POOLING is required for the release-control schema bootstrap; pooled and fallback database URLs are not accepted.",
    );
  }
  const targetFingerprint = releaseDatabaseTargetFingerprint(databaseUrl);
  const expectedTargetFingerprint =
    environment.KESTREL_RELEASE_DATABASE_TARGET_SHA256?.trim();
  if (!expectedTargetFingerprint) {
    throw new Error(
      "KESTREL_RELEASE_DATABASE_TARGET_SHA256 is required for the release-control schema bootstrap.",
    );
  }
  if (!TARGET_FINGERPRINT_PATTERN.test(expectedTargetFingerprint)) {
    throw new Error(
      "KESTREL_RELEASE_DATABASE_TARGET_SHA256 must be a sha256 fingerprint.",
    );
  }
  if (targetFingerprint !== expectedTargetFingerprint) {
    throw new Error(
      "POSTGRES_URL_NON_POOLING does not identify the approved production database target.",
    );
  }
  const sourceRevision = environment.GITHUB_SHA?.trim();
  if (!sourceRevision || !SOURCE_REVISION_PATTERN.test(sourceRevision)) {
    throw new Error(
      "GITHUB_SHA must be the exact 40-character release source revision.",
    );
  }
  return {
    databaseUrl,
    expectedTargetFingerprint,
    sourceRevision,
    stepSummaryPath: environment.GITHUB_STEP_SUMMARY?.trim() || undefined,
  };
}

export function releaseDatabaseTargetFingerprint(databaseUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("POSTGRES_URL_NON_POOLING must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("POSTGRES_URL_NON_POOLING must use PostgreSQL.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!parsed.hostname || !databaseName || databaseName.includes("/")) {
    throw new Error(
      "POSTGRES_URL_NON_POOLING must identify one PostgreSQL host and database.",
    );
  }
  const identity = `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${databaseName}`;
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export async function ensureReleaseControlSchema(
  configuration: ReleaseControlBootstrapConfiguration,
  dependencies: ReleaseControlBootstrapDependencies = {},
): Promise<ReleaseControlBootstrapResult> {
  const sourceMigrations = readSourceMigrations();
  const sourceContract =
    assertReleaseControlSourceMigrationContract(sourceMigrations);
  const connection = postgres(configuration.databaseUrl, { max: 1 });
  try {
    await connection`
      SELECT pg_advisory_lock(hashtext('kestrel-one-schema-migrate'))
    `;
    const before = await inspectWithSql(connection);
    const [databaseIdentity] = await connection<
      Array<{ databaseName: string }>
    >`SELECT current_database() AS "databaseName"`;
    const beforeHash = before.missingRequirements.includes(
      "table:drizzle.__drizzle_migrations",
    )
      ? null
      : await latestMigrationHash(connection);
    let action: ReleaseControlBootstrapResult["action"] = "verified";
    const decision = evaluateReleaseControlBootstrapState({
      readiness: before,
      latestHash: beforeHash,
    });
    if (decision === "apply") {
      await assertExactPredecessorLedger(
        connection,
        sourceMigrations,
        sourceContract.predecessorIndex,
      );
      await (dependencies.applyMigration ?? applyReleaseControlMigration)(
        connection,
        sourceContract.target,
      );
      action = "applied";
    }
    const after = await inspectWithSql(connection);
    if (!after.ready) {
      throw new Error(
        `Release-control schema verification failed: ${after.missingRequirements.join(", ")}.`,
      );
    }
    const afterHash = await latestMigrationHash(connection);
    const result: ReleaseControlBootstrapResult = {
      action,
      sourceRevision: configuration.sourceRevision,
      targetFingerprint: configuration.expectedTargetFingerprint,
      databaseName: databaseIdentity?.databaseName ?? "unknown",
      beforeHash: beforeHash ?? "none",
      afterHash: afterHash ?? "none",
      migrationTag: RELEASE_CONTROL_SCHEMA_MIGRATION_TAG,
    };
    recordReleaseControlBootstrapEvidence(
      result,
      configuration.stepSummaryPath,
    );
    return result;
  } finally {
    await connection`
      SELECT pg_advisory_unlock(hashtext('kestrel-one-schema-migrate'))
    `.catch(() => {});
    await connection.end({ timeout: 0 });
  }
}

async function applyReleaseControlMigration(
  connection: Sql,
  target: TaggedMigrationMeta,
) {
  const isolatedFolder = fs.mkdtempSync(
    path.join(os.tmpdir(), "kestrel-release-control-"),
  );
  try {
    const metadataFolder = path.join(isolatedFolder, "meta");
    fs.mkdirSync(metadataFolder);
    fs.copyFileSync(
      path.join(MIGRATIONS_FOLDER, `${target.tag}.sql`),
      path.join(isolatedFolder, `${target.tag}.sql`),
    );
    fs.writeFileSync(
      path.join(metadataFolder, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: target.version,
            when: target.when,
            tag: target.tag,
            breakpoints: target.breakpoints,
          },
        ],
      }),
      "utf8",
    );
    await migrate(drizzle(connection), { migrationsFolder: isolatedFolder });
  } finally {
    fs.rmSync(isolatedFolder, { recursive: true, force: true });
  }
}

export function evaluateReleaseControlBootstrapState(input: {
  readiness: ReleaseControlSchemaReadiness;
  latestHash: string | null;
}) {
  if (input.readiness.ready) return "verified" as const;
  if (input.latestHash !== RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH) {
    throw new Error(
      `Release-control bootstrap requires production migration predecessor ${RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH}; received ${input.latestHash || "none"}.`,
    );
  }
  return "apply" as const;
}

export function assertReleaseControlSourceMigrationContract(
  sourceMigrations: ReadonlyArray<TaggedMigrationMeta>,
) {
  const predecessorMatches = sourceMigrations
    .map((migration, index) => ({ migration, index }))
    .filter(
      ({ migration }) =>
        migration.tag === RELEASE_CONTROL_SCHEMA_PREDECESSOR_TAG,
    );
  const targetMatches = sourceMigrations
    .map((migration, index) => ({ migration, index }))
    .filter(
      ({ migration }) => migration.tag === RELEASE_CONTROL_SCHEMA_MIGRATION_TAG,
    );
  if (
    predecessorMatches.length !== 1 ||
    targetMatches.length !== 1 ||
    targetMatches[0]!.index !== predecessorMatches[0]!.index + 1
  ) {
    throw new Error(
      `Release-control bootstrap requires exactly one adjacent ${RELEASE_CONTROL_SCHEMA_PREDECESSOR_TAG} to ${RELEASE_CONTROL_SCHEMA_MIGRATION_TAG} source transition.`,
    );
  }
  const predecessor = predecessorMatches[0]!.migration;
  const target = targetMatches[0]!.migration;
  if (predecessor?.hash !== RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH) {
    throw new Error(
      `Release-control bootstrap source predecessor hash must be ${RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH}; received ${predecessor?.hash ?? "none"}.`,
    );
  }
  if (target?.hash !== RELEASE_CONTROL_SCHEMA_MIGRATION_HASH) {
    throw new Error(
      `Release-control bootstrap source migration hash must be ${RELEASE_CONTROL_SCHEMA_MIGRATION_HASH}; received ${target?.hash ?? "none"}.`,
    );
  }
  return {
    predecessor,
    target,
    predecessorIndex: predecessorMatches[0]!.index,
    targetIndex: targetMatches[0]!.index,
  };
}

function readSourceMigrations(): TaggedMigrationMeta[] {
  const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8")) as {
    entries?: MigrationJournalEntry[];
  };
  const entries = journal.entries;
  const migrations = readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  });
  if (!entries || entries.length !== migrations.length) {
    throw new Error(
      "The application migration journal does not match the repository migration files.",
    );
  }
  return migrations.map((migration, index) => {
    const entry = entries[index];
    if (!entry || entry.when !== migration.folderMillis) {
      throw new Error(
        "The application migration journal order does not match the repository migration files.",
      );
    }
    return { ...migration, ...entry };
  });
}

async function inspectWithSql(connection: Sql) {
  return inspectReleaseControlSchema(
    async <Row extends Record<string, unknown>>(statement: string) =>
      connection.unsafe<Row[]>(statement),
  );
}

async function latestMigrationHash(connection: Sql) {
  const [row] = await connection<Array<{ hash: string }>>`
    SELECT hash
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return row?.hash ?? null;
}

async function assertExactPredecessorLedger(
  connection: Sql,
  sourceMigrations: MigrationMeta[],
  predecessorIndex: number,
) {
  const expected = sourceMigrations.slice(0, predecessorIndex + 1);
  const actual = await connection<
    Array<{ hash: string; createdAt: string | number }>
  >`
    SELECT hash, created_at AS "createdAt"
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at ASC, id ASC
  `;
  const mismatch =
    actual.length !== expected.length ||
    actual.some((row, index) => {
      const migration = expected[index];
      return (
        !migration ||
        row.hash !== migration.hash ||
        Number(row.createdAt) !== migration.folderMillis
      );
    });
  if (mismatch) {
    throw new Error(
      `Release-control bootstrap requires the complete ordered production ledger through ${RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH}; the ledger is older, ambiguous, or drifted.`,
    );
  }
}

function recordReleaseControlBootstrapEvidence(
  result: ReleaseControlBootstrapResult,
  stepSummaryPath: string | undefined,
) {
  const evidence = [
    "### Release-control database schema",
    "",
    `- Action: ${result.action}`,
    `- Source revision: \`${result.sourceRevision}\``,
    `- Target fingerprint: \`${result.targetFingerprint}\``,
    `- Database: \`${result.databaseName}\``,
    `- Migration: \`${result.migrationTag}\``,
    `- Before hash: \`${result.beforeHash}\``,
    `- After hash: \`${result.afterHash}\``,
    "",
  ].join("\n");
  process.stdout.write(`${evidence}\n`);
  if (stepSummaryPath) fs.appendFileSync(stepSummaryPath, evidence, "utf8");
}
