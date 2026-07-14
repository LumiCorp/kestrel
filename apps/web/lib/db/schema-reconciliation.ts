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

export async function reconcileSkippedMigrations(connection: Sql) {
  for (const phase of phases) {
    const before = await phaseState(connection, phase);
    if (before.complete) continue;
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
  }
}

export const skippedMigrationTags = phases.map((phase) => phase.tag);
