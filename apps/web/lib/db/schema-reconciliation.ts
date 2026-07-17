import fs from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";

type Requirement =
  | { kind: "relation"; name: string }
  | { kind: "column"; relation: string; name: string }
  | { kind: "index"; name: string };

type ReconciliationPhase = {
  tag: string;
  requirements: Requirement[];
  allowPartial?: boolean;
  transactionBreakBefore?: string;
};

type PublishedMigrationLedgerTimestamp = {
  tag: string;
  hashes: string[];
  timestamp: number;
};

const publishedMigrationLedgerTimestamps: PublishedMigrationLedgerTimestamp[] = [
  {
    tag: "0014_platform_email_config",
    hashes: [
      "a83c717278f3942b4b32baf816bec2220d767c8a28f43476c1fe4d96ef7f0aae",
    ],
    timestamp: 1_783_886_400_000,
  },
  {
    tag: "0015_managed_runpod_deployments",
    hashes: [
      "e0b7d20f37ba828c917a1ab88155984dbe3da4590660dd93b8ba5de186f6e2f1",
    ],
    timestamp: 1_783_897_200_000,
  },
  {
    tag: "0016_hosted_environments",
    hashes: [
      "ccd8f19f3733f4e36ec75cbf619a4958b77f2d602adb9cd54ef2db68e17ff581",
      "34e56f5959b0da038e48bcb22696e74a8be682bcc9e0157fb25b7ccbb2c423d7",
    ],
    timestamp: 1_783_900_800_000,
  },
  {
    tag: "0017_github_user_oauth",
    hashes: [
      "7e02aeaceb039d0c9e757deb8575f3051d69f4bb913b5a31ed27624226358ce5",
    ],
    timestamp: 1_783_904_400_000,
  },
  {
    tag: "0018_environment_project_ownership",
    hashes: [
      "63e281b8f7c753c768b2ef97b4481964e7ef58b6a2868bbf9acfd83d4e95ce43",
    ],
    timestamp: 1_783_908_000_000,
  },
  {
    tag: "0019_hosted_mcp_control_plane",
    hashes: [
      "b7cd6518636ab85989237e5962e599804fc745a01811fe45a0584d72df51cb9a",
    ],
    timestamp: 1_783_911_600_000,
  },
  {
    tag: "0020_environment_router_upgrade",
    hashes: [
      "1a09f068f081dd124a5009ec6c0cdc45467c040d0a52429cffef39fa0238bc6c",
    ],
    timestamp: 1_783_915_200_000,
  },
  {
    tag: "0021_mcp_interaction_hardening",
    hashes: [
      "02ce28dc4f9c52f26c0854d3d241e9c1a5194bba75f5407a279e9a1727c02b38",
    ],
    timestamp: 1_783_918_800_000,
  },
  {
    tag: "0022_mcp_sampling_processing_deadline",
    hashes: [
      "fe48d40bb922a2c602d3cd6be3473c7896204aad6d1cafcb1f36e08f2e50488f",
    ],
    timestamp: 1_783_922_400_000,
  },
];

const phases: ReconciliationPhase[] = [
  {
    tag: "0014_platform_email_config",
    requirements: [{ kind: "relation", name: "platform_email_config" }],
  },
  {
    tag: "0015_managed_runpod_deployments",
    requirements: [
      { kind: "relation", name: "ai_provider_connections" },
      { kind: "relation", name: "ai_deployment_profiles" },
      { kind: "relation", name: "organization_ai_deployment_policies" },
      { kind: "relation", name: "organization_ai_deployment_entitlements" },
      { kind: "relation", name: "ai_deployments" },
      { kind: "relation", name: "ai_deployment_runs" },
      { kind: "relation", name: "ai_deployment_usage" },
      { kind: "column", relation: "ai_gateways", name: "organization_id" },
      { kind: "column", relation: "ai_gateways", name: "deployment_id" },
      {
        kind: "column",
        relation: "ai_gateways",
        name: "provider_connection_id",
      },
    ],
  },
  {
    tag: "0018_environment_project_ownership",
    transactionBreakBefore:
      'ALTER TABLE "projects" ALTER COLUMN "environment_id" SET NOT NULL;',
    requirements: [
      { kind: "index", name: "environments_org_id_idx" },
      { kind: "column", relation: "projects", name: "environment_id" },
      { kind: "index", name: "projects_environment_id_idx" },
    ],
  },
  {
    tag: "0019_hosted_mcp_control_plane",
    requirements: [
      { kind: "relation", name: "mcp_credentials" },
      { kind: "relation", name: "mcp_oauth_authorizations" },
      { kind: "relation", name: "mcp_servers" },
      { kind: "relation", name: "mcp_capability_snapshots" },
      { kind: "relation", name: "mcp_discovery_jobs" },
      { kind: "relation", name: "mcp_capabilities" },
      { kind: "relation", name: "mcp_project_capability_restrictions" },
      { kind: "relation", name: "mcp_project_resource_references" },
      { kind: "relation", name: "mcp_run_grants" },
      { kind: "relation", name: "mcp_invocations" },
      { kind: "relation", name: "mcp_interaction_checkpoints" },
    ],
  },
  {
    tag: "0020_environment_router_upgrade",
    allowPartial: true,
    requirements: [
      {
        kind: "column",
        relation: "environments",
        name: "fly_gateway_machine_id",
      },
      { kind: "column", relation: "environments", name: "router_url" },
      { kind: "column", relation: "environments", name: "router_image" },
    ],
  },
  {
    tag: "0021_mcp_interaction_hardening",
    requirements: [
      {
        kind: "column",
        relation: "mcp_interaction_checkpoints",
        name: "failure_code",
      },
      {
        kind: "column",
        relation: "mcp_interaction_checkpoints",
        name: "failure_message",
      },
    ],
  },
  {
    tag: "0022_mcp_sampling_processing_deadline",
    requirements: [
      {
        kind: "column",
        relation: "mcp_interaction_checkpoints",
        name: "processing_started_at",
      },
      {
        kind: "column",
        relation: "mcp_interaction_checkpoints",
        name: "processing_expires_at",
      },
      {
        kind: "index",
        name: "mcp_interaction_checkpoints_processing_expiry_idx",
      },
    ],
  },
];

async function requirementExists(connection: Sql, requirement: Requirement) {
  if (requirement.kind === "relation") {
    const [row] = await connection<Array<{ present: boolean }>>`
      SELECT to_regclass(${`public.${requirement.name}`}) IS NOT NULL AS present
    `;
    return row?.present ?? false;
  }
  if (requirement.kind === "index") {
    const [row] = await connection<Array<{ present: boolean }>>`
      SELECT to_regclass(${`public.${requirement.name}`}) IS NOT NULL AS present
    `;
    return row?.present ?? false;
  }
  const [row] = await connection<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${requirement.relation}
        AND column_name = ${requirement.name}
    ) AS present
  `;
  return row?.present ?? false;
}

async function phaseState(connection: Sql, phase: ReconciliationPhase) {
  const states = await Promise.all(
    phase.requirements.map((requirement) =>
      requirementExists(connection, requirement)
    )
  );
  return {
    complete: states.every(Boolean),
    partial: states.some(Boolean) && !states.every(Boolean),
  };
}

async function applyPhase(connection: Sql, phase: ReconciliationPhase) {
  const migrationPath = path.join(
    process.cwd(),
    "lib",
    "db",
    "migrations",
    `${phase.tag}.sql`
  );
  const migration = await fs.readFile(migrationPath, "utf8");
  const batches = phase.transactionBreakBefore
    ? splitMigrationBefore(migration, phase.transactionBreakBefore, phase.tag)
    : [migration];
  for (const batch of batches) {
    await connection.begin(async (transaction) => {
      await transaction.unsafe(batch);
    });
  }
}

function splitMigrationBefore(
  migration: string,
  marker: string,
  tag: string
) {
  const markerIndex = migration.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Schema reconciliation marker is missing for ${tag}.`);
  }
  return [migration.slice(0, markerIndex), migration.slice(markerIndex)].filter(
    (batch) => batch.trim().length > 0
  );
}

export async function hasKnownMigrationLedgerDrift(connection: Sql) {
  const [row] = await connection<Array<{ laterSchemaPresent: boolean }>>`
    SELECT (
      to_regclass('public.thread_turns') IS NOT NULL
      OR to_regclass('public.account_deletion_requests') IS NOT NULL
      OR to_regclass('public.environment_workspaces') IS NOT NULL
      OR to_regclass('public.mcp_credentials') IS NOT NULL
    ) AS "laterSchemaPresent"
  `;
  if (!row?.laterSchemaPresent) return false;
  const required = await Promise.all(
    phases
      .flatMap((phase) => phase.requirements)
      .map((requirement) => requirementExists(connection, requirement))
  );
  return required.some((present) => !present);
}

export async function reconcilePublishedMigrationLedgerTimestamps(
  connection: Sql
) {
  const [ledger] = await connection<Array<{ present: boolean }>>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present
  `;
  if (!ledger?.present) return;

  for (const migration of publishedMigrationLedgerTimestamps) {
    for (const hash of migration.hashes) {
      const updated = await connection<Array<{ id: number }>>`
        UPDATE drizzle.__drizzle_migrations
        SET created_at = ${migration.timestamp}
        WHERE hash = ${hash}
          AND created_at < ${migration.timestamp}
        RETURNING id
      `;
      if (updated.length > 0) {
        process.stdout.write(
          `Reconciled published migration timestamp for ${migration.tag}.\n`
        );
      }
    }
  }
}

async function recordReconciledMigration(
  connection: Sql,
  tag: string
) {
  const migration = publishedMigrationLedgerTimestamps.find(
    (candidate) => candidate.tag === tag
  );
  if (!migration) {
    throw new Error(`Missing published migration ledger metadata for ${tag}.`);
  }
  const hash = migration.hashes.at(-1);
  if (!hash) {
    throw new Error(`Missing published migration hash for ${tag}.`);
  }
  await connection`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    SELECT ${hash}, ${migration.timestamp}
    WHERE NOT EXISTS (
      SELECT 1
      FROM drizzle.__drizzle_migrations
      WHERE hash = ${hash}
    )
  `;
}

export async function reconcileSkippedMigrations(connection: Sql) {
  for (const phase of phases) {
    const before = await phaseState(connection, phase);
    if (before.complete) {
      await recordReconciledMigration(connection, phase.tag);
      continue;
    }
    if (before.partial && !phase.allowPartial) {
      throw new Error(
        `Schema reconciliation found a partially applied ${phase.tag}; manual inspection is required.`
      );
    }
    process.stdout.write(`Reconciling skipped migration ${phase.tag}...\n`);
    await applyPhase(connection, phase);
    const after = await phaseState(connection, phase);
    if (!after.complete) {
      throw new Error(`Schema reconciliation did not complete ${phase.tag}.`);
    }
    await recordReconciledMigration(connection, phase.tag);
  }
}

export const skippedMigrationTags = phases.map((phase) => phase.tag);
