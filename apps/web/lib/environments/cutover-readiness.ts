import postgres from "postgres";

export type HostedEnvironmentCutoverSnapshot = {
  enabledOrganizationCount: number;
  enabledOrganizationWithoutReadyDefaultCount: number;
  invalidProjectBindingCount: number;
  invalidThreadBindingCount: number;
  invalidExecutionCount: number;
  activeExecutionCount: number;
  enabledOrganizationThreadCount: number;
  boundThreadCount: number;
  terminalExecutionCount: number;
};

export type HostedEnvironmentCutoverReadiness = {
  ready: boolean;
  blockers: string[];
  snapshot: HostedEnvironmentCutoverSnapshot;
};

type SnapshotRow = {
  enabledOrganizationCount: number;
  enabledOrganizationWithoutReadyDefaultCount: number;
  invalidProjectBindingCount: number;
  invalidThreadBindingCount: number;
  invalidExecutionCount: number;
  activeExecutionCount: number;
  enabledOrganizationThreadCount: number;
  boundThreadCount: number;
  terminalExecutionCount: number;
};

export function evaluateHostedEnvironmentCutoverReadiness(
  snapshot: HostedEnvironmentCutoverSnapshot
): HostedEnvironmentCutoverReadiness {
  const blockers: string[] = [];
  if (snapshot.enabledOrganizationCount === 0) {
    blockers.push(
      "No organization has the hosted Environments feature enabled."
    );
  }
  if (snapshot.enabledOrganizationWithoutReadyDefaultCount > 0) {
    blockers.push(
      `${snapshot.enabledOrganizationWithoutReadyDefaultCount} enabled organization(s) do not have a fully provisioned default Environment.`
    );
  }
  if (snapshot.invalidProjectBindingCount > 0) {
    blockers.push(
      `${snapshot.invalidProjectBindingCount} Project Environment binding(s) violate tenant or availability invariants.`
    );
  }
  if (snapshot.invalidThreadBindingCount > 0) {
    blockers.push(
      `${snapshot.invalidThreadBindingCount} Thread execution binding(s) violate tenant, Environment, or Workspace ownership invariants.`
    );
  }
  if (snapshot.invalidExecutionCount > 0) {
    blockers.push(
      `${snapshot.invalidExecutionCount} Environment execution record(s) violate tenant or route identity invariants.`
    );
  }
  if (snapshot.activeExecutionCount > 0) {
    blockers.push(
      `${snapshot.activeExecutionCount} Environment execution(s) are still routed or running.`
    );
  }
  return { ready: blockers.length === 0, blockers, snapshot };
}

export async function inspectHostedEnvironmentCutoverReadiness(input: {
  databaseUrl: string;
}): Promise<HostedEnvironmentCutoverReadiness> {
  const sql = postgres(input.databaseUrl, { max: 1 });
  try {
    const [snapshot] = await sql<SnapshotRow[]>`
      WITH enabled_organizations AS (
        SELECT "organization_id"
        FROM "organization_feature_flags"
        WHERE "key" = 'hosted_environments' AND "enabled" = true
      )
      SELECT
        (
          SELECT count(*)::integer
          FROM enabled_organizations
        ) AS "enabledOrganizationCount",
        (
          SELECT count(*)::integer
          FROM enabled_organizations enabled
          WHERE NOT EXISTS (
            SELECT 1
            FROM "environments" environment
            WHERE environment."organization_id" = enabled."organization_id"
              AND environment."is_default" = true
              AND environment."archived_at" IS NULL
              AND environment."status" = 'ready'
              AND environment."fly_app_name" IS NOT NULL
              AND environment."fly_network_name" IS NOT NULL
              AND environment."fly_gateway_machine_id" IS NOT NULL
              AND environment."router_url" IS NOT NULL
              AND environment."router_image" IS NOT NULL
              AND environment."runtime_image" IS NOT NULL
          )
        ) AS "enabledOrganizationWithoutReadyDefaultCount",
        (
          SELECT count(*)::integer
          FROM "project_environment_bindings" binding
          JOIN enabled_organizations enabled
            ON enabled."organization_id" = binding."organization_id"
          LEFT JOIN "projects" project ON project."id" = binding."project_id"
          LEFT JOIN "environments" environment
            ON environment."id" = binding."environment_id"
          WHERE project."id" IS NULL
            OR project."organization_id" IS DISTINCT FROM binding."organization_id"
            OR environment."id" IS NULL
            OR environment."organization_id" IS DISTINCT FROM binding."organization_id"
            OR environment."archived_at" IS NOT NULL
            OR environment."status" IS DISTINCT FROM 'ready'
        ) AS "invalidProjectBindingCount",
        (
          SELECT count(*)::integer
          FROM "thread_execution_bindings" binding
          JOIN enabled_organizations enabled
            ON enabled."organization_id" = binding."organization_id"
          LEFT JOIN "threads" thread ON thread."id" = binding."thread_id"
          LEFT JOIN "environments" environment
            ON environment."id" = binding."environment_id"
          LEFT JOIN "environment_workspaces" workspace
            ON workspace."id" = binding."workspace_id"
          WHERE thread."id" IS NULL
            OR thread."organization_id" IS DISTINCT FROM binding."organization_id"
            OR environment."id" IS NULL
            OR environment."organization_id" IS DISTINCT FROM binding."organization_id"
            OR environment."archived_at" IS NOT NULL
            OR environment."status" IS DISTINCT FROM 'ready'
            OR workspace."id" IS NULL
            OR workspace."organization_id" IS DISTINCT FROM binding."organization_id"
            OR workspace."environment_id" IS DISTINCT FROM binding."environment_id"
            OR workspace."deleted_at" IS NOT NULL
            OR workspace."status" IN ('deleting', 'deleted', 'failed')
            OR (
              thread."project_id" IS NULL
              AND workspace."standalone_thread_id" IS DISTINCT FROM thread."id"
            )
            OR (
              thread."project_id" IS NOT NULL
              AND workspace."project_id" IS DISTINCT FROM thread."project_id"
            )
        ) AS "invalidThreadBindingCount",
        (
          SELECT count(*)::integer
          FROM "environment_run_executions" execution
          JOIN enabled_organizations enabled
            ON enabled."organization_id" = execution."organization_id"
          LEFT JOIN "threads" thread ON thread."id" = execution."thread_id"
          LEFT JOIN "environments" environment
            ON environment."id" = execution."environment_id"
          LEFT JOIN "environment_workspaces" workspace
            ON workspace."id" = execution."workspace_id"
          WHERE thread."id" IS NULL
            OR thread."organization_id" IS DISTINCT FROM execution."organization_id"
            OR environment."id" IS NULL
            OR environment."organization_id" IS DISTINCT FROM execution."organization_id"
            OR workspace."id" IS NULL
            OR workspace."organization_id" IS DISTINCT FROM execution."organization_id"
            OR workspace."environment_id" IS DISTINCT FROM execution."environment_id"
        ) AS "invalidExecutionCount",
        (
          SELECT count(*)::integer
          FROM "environment_run_executions" execution
          JOIN enabled_organizations enabled
            ON enabled."organization_id" = execution."organization_id"
          WHERE execution."status" IN ('routed', 'running')
        ) AS "activeExecutionCount",
        (
          SELECT count(*)::integer
          FROM "threads" thread
          JOIN enabled_organizations enabled
            ON enabled."organization_id" = thread."organization_id"
        ) AS "enabledOrganizationThreadCount",
        (
          SELECT count(*)::integer
          FROM "thread_execution_bindings" binding
          JOIN enabled_organizations enabled
            ON enabled."organization_id" = binding."organization_id"
        ) AS "boundThreadCount",
        (
          SELECT count(*)::integer
          FROM "environment_run_executions" execution
          JOIN enabled_organizations enabled
            ON enabled."organization_id" = execution."organization_id"
          WHERE execution."status" IN ('completed', 'failed', 'cancelled')
        ) AS "terminalExecutionCount"
    `;
    if (!snapshot) {
      throw new Error("Hosted Environment cutover inspection returned no row.");
    }
    return evaluateHostedEnvironmentCutoverReadiness(snapshot);
  } finally {
    await sql.end({ timeout: 0 });
  }
}
