import process from "node:process";
import { pathToFileURL } from "node:url";

import { Pool, type PoolClient } from "pg";
import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";
import { applyKestrelLocalEnvDefaults, buildDefaultKestrelDatabaseUrl } from "../src/config/localDev.js";

export type Scope = "active-resumable" | "all" | "ids";

export interface CliOptions {
  dryRun: boolean;
  apply: boolean;
  scope: Scope;
  sessionIds: string[];
}

export interface CandidateSession {
  sessionId: string;
  currentVersion: number;
  currentStepAgent?: string | undefined;
  schemaVersion?: number | undefined;
  legacyReadonly: boolean;
  hasActiveRun: boolean;
  hasPendingEffects: boolean;
  hasPendingOutbox: boolean;
  hasStepAgent: boolean;
}

export interface PlanResult {
  migratable: CandidateSession[];
  archiveOnly: CandidateSession[];
  blocked: Array<{ sessionId: string; reason: string }>;
}

async function main(): Promise<void> {
  await loadShellAndDotEnv(process.cwd(), {
    preferDotEnvKeys: ["DATABASE_URL"],
  });
  applyKestrelLocalEnvDefaults(process.env);
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL ?? buildDefaultKestrelDatabaseUrl(process.env);
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await ensureV3MigrationPrerequisites(pool);
    const sessions = await loadCandidates(pool);
    const plan = buildPlan(sessions, options);

    printPlan(plan, options);
    if (options.dryRun) {
      return;
    }

    await applyPlan(pool, plan);
  } finally {
    await pool.end();
  }
}

async function ensureV3MigrationPrerequisites(pool: Pool): Promise<void> {
  const result = await pool.query<{
    has_schema_version: boolean;
    has_legacy_readonly: boolean;
    has_active_state_parent: boolean;
    has_active_state_child: boolean;
    has_active_region: boolean;
    has_run_events: boolean;
    has_legacy_archives: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'schema_version'
       ) AS has_schema_version,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'legacy_readonly'
       ) AS has_legacy_readonly,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'active_state_parent'
       ) AS has_active_state_parent,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'active_state_child'
       ) AS has_active_state_child,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'active_region'
       ) AS has_active_region,
       to_regclass('public.run_events') IS NOT NULL AS has_run_events,
       to_regclass('public.legacy_session_archives') IS NOT NULL AS has_legacy_archives`,
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      "Unable to verify migration prerequisites. Run `pnpm run db:migrate` and retry.",
    );
  }

  const missing: string[] = [];
  if (row.has_schema_version !== true) missing.push("sessions.schema_version");
  if (row.has_legacy_readonly !== true) missing.push("sessions.legacy_readonly");
  if (row.has_active_state_parent !== true) missing.push("sessions.active_state_parent");
  if (row.has_active_state_child !== true) missing.push("sessions.active_state_child");
  if (row.has_active_region !== true) missing.push("sessions.active_region");
  if (row.has_run_events !== true) missing.push("run_events");
  if (row.has_legacy_archives !== true) missing.push("legacy_session_archives");

  if (missing.length > 0) {
    throw new Error(
      `Database schema is missing v3 prerequisites (${missing.join(", ")}). Run 'pnpm run db:migrate' first, then retry.`,
    );
  }
}

export function parseArgs(args: string[]): CliOptions {
  let dryRun = false;
  let apply = false;
  let scope: Scope = "active-resumable";
  let sessionIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--scope") {
      const value = args[index + 1];
      if (value !== "active-resumable" && value !== "all" && value !== "ids") {
        throw new Error(`Invalid --scope value '${value ?? ""}'. Expected active-resumable|all|ids.`);
      }
      scope = value;
      index += 1;
      continue;
    }
    if (arg === "--session-ids") {
      const value = args[index + 1];
      if (value === undefined || value.trim().length === 0) {
        throw new Error("--session-ids requires a comma-separated list.");
      }
      sessionIds = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (dryRun && apply) {
    throw new Error("Use either --dry-run or --apply, not both.");
  }
  if (dryRun === false && apply === false) {
    dryRun = true;
  }
  if (scope === "ids" && sessionIds.length === 0) {
    throw new Error("--scope ids requires --session-ids <csv>.");
  }

  return { dryRun, apply, scope, sessionIds };
}

async function loadCandidates(pool: Pool): Promise<CandidateSession[]> {
  const result = await pool.query<{
    session_id: string;
    current_version: number;
    current_step_agent: string | null;
    schema_version: number | null;
    legacy_readonly: boolean;
    has_active_run: boolean;
    has_pending_effects: boolean;
    has_pending_outbox: boolean;
  }>(
    `SELECT
       s.session_id,
       s.current_version,
       s.current_step_agent,
       s.schema_version,
       s.legacy_readonly,
       EXISTS (
         SELECT 1
         FROM runs r
         WHERE r.session_id = s.session_id
           AND r.status IN ('RUNNING', 'WAITING')
       ) AS has_active_run,
       EXISTS (
         SELECT 1
         FROM effects e
         WHERE e.session_id = s.session_id
           AND e.status = 'PENDING'
       ) AS has_pending_effects,
       EXISTS (
         SELECT 1
         FROM runtime_events_outbox o
         WHERE o.session_id = s.session_id
           AND o.status <> 'DELIVERED'
       ) AS has_pending_outbox
     FROM sessions s
     ORDER BY s.session_id ASC`,
  );

  return result.rows.map((row) => ({
    sessionId: row.session_id,
    currentVersion: row.current_version,
    currentStepAgent: row.current_step_agent ?? undefined,
    schemaVersion: row.schema_version ?? undefined,
    legacyReadonly: row.legacy_readonly,
    hasActiveRun: row.has_active_run,
    hasPendingEffects: row.has_pending_effects,
    hasPendingOutbox: row.has_pending_outbox,
    hasStepAgent: row.current_step_agent !== null && row.current_step_agent.trim().length > 0,
  }));
}

export function buildPlan(sessions: CandidateSession[], options: CliOptions): PlanResult {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const blocked: Array<{ sessionId: string; reason: string }> = [];
  const selected: CandidateSession[] = [];

  if (options.scope === "ids") {
    for (const sessionId of options.sessionIds) {
      const candidate = byId.get(sessionId);
      if (candidate === undefined) {
        blocked.push({ sessionId, reason: "session_not_found" });
        continue;
      }
      selected.push(candidate);
    }
  } else {
    selected.push(...sessions);
  }

  const migratable = selected.filter((candidate) => {
    if (candidate.legacyReadonly) {
      return false;
    }
    if (options.scope === "all" || options.scope === "ids") {
      return true;
    }
    return isResumableSignal(candidate);
  });

  const migratableIds = new Set(migratable.map((candidate) => candidate.sessionId));
  const archiveOnly = selected.filter((candidate) => migratableIds.has(candidate.sessionId) === false);

  return {
    migratable,
    archiveOnly,
    blocked,
  };
}

export function isResumableSignal(candidate: CandidateSession): boolean {
  return (
    candidate.hasActiveRun ||
    candidate.hasPendingEffects ||
    candidate.hasPendingOutbox ||
    candidate.hasStepAgent
  );
}

function printPlan(plan: PlanResult, options: CliOptions): void {
  process.stdout.write(
    `[migrate-v2-to-v3] mode=${options.dryRun ? "dry-run" : "apply"} scope=${options.scope}\n`,
  );
  process.stdout.write(`migratable=${plan.migratable.length}\n`);
  process.stdout.write(`archive_only=${plan.archiveOnly.length}\n`);
  process.stdout.write(`blocked=${plan.blocked.length}\n`);

  if (plan.migratable.length > 0) {
    process.stdout.write(`migratable_ids=${plan.migratable.map((item) => item.sessionId).join(",")}\n`);
  }
  if (plan.archiveOnly.length > 0) {
    process.stdout.write(`archive_only_ids=${plan.archiveOnly.map((item) => item.sessionId).join(",")}\n`);
  }
  if (plan.blocked.length > 0) {
    for (const blocked of plan.blocked) {
      process.stdout.write(`blocked=${blocked.sessionId}:${blocked.reason}\n`);
    }
  }
}

async function applyPlan(pool: Pool, plan: PlanResult): Promise<void> {
  for (const candidate of plan.migratable) {
    await withTransaction(pool, async (client) => {
      const state = await loadCurrentState(client, candidate.sessionId, candidate.currentVersion);
      const patched = patchStateForV3(state, candidate.sessionId);
      const stateNode = asRecord(patched.stateNode) ?? { parent: "root", child: "idle" };

      await client.query(
        `UPDATE session_versions
            SET state_json = $3::jsonb,
                state_node_json = $4::jsonb
          WHERE session_id = $1
            AND version = $2`,
        [
          candidate.sessionId,
          candidate.currentVersion,
          JSON.stringify(patched),
          JSON.stringify(stateNode),
        ],
      );

      await client.query(
        `UPDATE sessions
            SET schema_version = 3,
                legacy_readonly = FALSE,
                active_state_parent = $2,
                active_state_child = $3,
                active_region = $4,
                updated_at = NOW()
          WHERE session_id = $1`,
        [
          candidate.sessionId,
          typeof stateNode.parent === "string" ? stateNode.parent : "root",
          typeof stateNode.child === "string" ? stateNode.child : "idle",
          typeof stateNode.region === "string" ? stateNode.region : null,
        ],
      );

      await insertMigrationEvent(client, candidate.sessionId, "migration.session_migrated", {
        scope: "v2_to_v3",
      });
    });
  }

  for (const candidate of plan.archiveOnly) {
    await withTransaction(pool, async (client) => {
      const state = await loadCurrentState(client, candidate.sessionId, candidate.currentVersion);
      const snapshot = {
        session: {
          sessionId: candidate.sessionId,
          currentVersion: candidate.currentVersion,
          currentStepAgent: candidate.currentStepAgent ?? null,
          schemaVersion: candidate.schemaVersion ?? null,
          legacyReadonly: candidate.legacyReadonly,
        },
        state,
        signals: {
          hasActiveRun: candidate.hasActiveRun,
          hasPendingEffects: candidate.hasPendingEffects,
          hasPendingOutbox: candidate.hasPendingOutbox,
          hasStepAgent: candidate.hasStepAgent,
        },
      };

      const reason = candidate.legacyReadonly
        ? "already_legacy_readonly"
        : "not_in_migration_scope";
      await client.query(
        `INSERT INTO legacy_session_archives (session_id, snapshot_json, reason)
         VALUES ($1, $2::jsonb, $3)`,
        [candidate.sessionId, JSON.stringify(snapshot), reason],
      );
      await client.query(
        `UPDATE sessions
            SET legacy_readonly = TRUE,
                updated_at = NOW()
          WHERE session_id = $1`,
        [candidate.sessionId],
      );

      await insertMigrationEvent(client, candidate.sessionId, "migration.session_archived", {
        reason,
      });
    });
  }

  process.stdout.write(
    `[migrate-v2-to-v3] applied migrated=${plan.migratable.length} archived=${plan.archiveOnly.length}\n`,
  );
}

async function loadCurrentState(
  client: PoolClient,
  sessionId: string,
  currentVersion: number,
): Promise<Record<string, unknown>> {
  const result = await client.query<{ state_json: Record<string, unknown> | null }>(
    `SELECT state_json
       FROM session_versions
      WHERE session_id = $1
        AND version = $2
      LIMIT 1`,
    [sessionId, currentVersion],
  );
  return result.rows[0]?.state_json ?? {};
}

export function patchStateForV3(
  state: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  const patched: Record<string, unknown> = { ...state };

  const memory = asRecord(state.memory);
  patched.memory = {
    working: asRecord(memory?.working) ?? {},
    episodicRef:
      typeof memory?.episodicRef === "string" && memory.episodicRef.trim().length > 0
        ? memory.episodicRef
        : `episodic:migrated:${sessionId}`,
    semanticRef:
      typeof memory?.semanticRef === "string" && memory.semanticRef.trim().length > 0
        ? memory.semanticRef
        : "semantic:default",
  };

  const budget = asRecord(state.budget);
  patched.budget = {
    remainingMs:
      typeof budget?.remainingMs === "number" && Number.isFinite(budget.remainingMs)
        ? budget.remainingMs
        : 30_000,
    tokensUsed:
      typeof budget?.tokensUsed === "number" && Number.isFinite(budget.tokensUsed)
        ? budget.tokensUsed
        : 0,
    toolCallsUsed:
      typeof budget?.toolCallsUsed === "number" && Number.isFinite(budget.toolCallsUsed)
        ? budget.toolCallsUsed
        : 0,
    ...(typeof budget?.costUsd === "number" && Number.isFinite(budget.costUsd)
      ? { costUsd: budget.costUsd }
      : {}),
  };

  const stateNode = asRecord(state.stateNode);
  patched.stateNode = {
    parent:
      typeof stateNode?.parent === "string" && stateNode.parent.trim().length > 0
        ? stateNode.parent
        : "root",
    child:
      typeof stateNode?.child === "string" && stateNode.child.trim().length > 0
        ? stateNode.child
        : "idle",
    ...(typeof stateNode?.region === "string" && stateNode.region.trim().length > 0
      ? { region: stateNode.region }
      : {}),
  };

  return patched;
}

async function insertMigrationEvent(
  client: PoolClient,
  sessionId: string,
  eventType: "migration.session_archived" | "migration.session_migrated",
  metadata: Record<string, unknown>,
): Promise<void> {
  const runId = `migration:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await client.query(
    `INSERT INTO runs (run_id, session_id, event_type, status, completed_at)
     VALUES ($1, $2, 'migration', 'COMPLETED', NOW())`,
    [runId, sessionId],
  );
  await client.query(
    `INSERT INTO run_events (run_id, session_id, event_type, level, metadata_json, occurred_at)
     VALUES ($1, $2, $3, 'INFO', $4::jsonb, NOW())`,
    [runId, sessionId, eventType, JSON.stringify(metadata)],
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

async function withTransaction(
  pool: Pool,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  void main().catch((error) => {
    process.stderr.write(
      `[migrate-v2-to-v3] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
