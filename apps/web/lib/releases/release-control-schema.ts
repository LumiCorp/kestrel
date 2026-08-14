export const RELEASE_CONTROL_SCHEMA_MIGRATION_TAG =
  "0069_unified_release_attempt";
export const RELEASE_CONTROL_SCHEMA_MIGRATION_HASH =
  "2e657c68d3974a8b5827a66ae5861ce1c7291cbb4bb650fb75c45bbcc4f33c4b";
export const RELEASE_CONTROL_SCHEMA_PREDECESSOR_TAG = "0068_byo_fly_onboarding";
export const RELEASE_CONTROL_SCHEMA_PREDECESSOR_HASH =
  "f3f77bfff13d5204bd0868dfd178850596d6f8d8bd7c965ef84624d94c8b6b25";

const REQUIRED_TABLES = [
  ["drizzle", "__drizzle_migrations"],
  ["public", "fly_image_release_attempts"],
  ["public", "release_worker_heartbeats"],
] as const;

const REQUIRED_COLUMNS = [
  ["public", "fly_image_release_attempts", "id", "text", "NO"],
  ["public", "fly_image_release_attempts", "source_revision", "text", "NO"],
  ["public", "fly_image_release_attempts", "trigger", "text", "NO"],
  ["public", "fly_image_release_attempts", "force_all", "boolean", "NO"],
  ["public", "fly_image_release_attempts", "github_run_id", "text", "NO"],
  [
    "public",
    "fly_image_release_attempts",
    "github_run_attempt",
    "integer",
    "NO",
  ],
  ["public", "fly_image_release_attempts", "status", "text", "NO"],
  [
    "public",
    "fly_image_release_attempts",
    "lease_expires_at",
    "timestamp with time zone",
    "NO",
  ],
  ["public", "fly_image_release_attempts", "release_id", "text", "YES"],
  ["public", "fly_image_release_attempts", "failure_evidence", "jsonb", "YES"],
  [
    "public",
    "fly_image_release_attempts",
    "created_at",
    "timestamp with time zone",
    "NO",
  ],
  [
    "public",
    "fly_image_release_attempts",
    "updated_at",
    "timestamp with time zone",
    "NO",
  ],
  ["public", "fly_image_releases", "manifest_version", "integer", "NO"],
  ["public", "fly_image_releases", "attempt_id", "text", "YES"],
  ["public", "fly_image_releases", "migration_expected_head", "text", "YES"],
  [
    "public",
    "fly_image_releases",
    "migration_expected_history_lock_hash",
    "text",
    "YES",
  ],
  [
    "public",
    "fly_image_releases",
    "migration_verified_at",
    "timestamp with time zone",
    "YES",
  ],
  ["public", "fly_image_releases", "controller_image", "text", "YES"],
  [
    "public",
    "fly_image_releases",
    "controller_input_fingerprint",
    "text",
    "YES",
  ],
  [
    "public",
    "fly_image_releases",
    "controller_contract_revision",
    "integer",
    "YES",
  ],
  [
    "public",
    "fly_image_releases",
    "controller_prepared_at",
    "timestamp with time zone",
    "YES",
  ],
  ["public", "release_controller_heartbeats", "source_revision", "text", "YES"],
  ["public", "release_controller_heartbeats", "image", "text", "YES"],
  [
    "public",
    "release_controller_heartbeats",
    "input_fingerprint",
    "text",
    "YES",
  ],
  ["public", "release_controller_heartbeats", "machine_id", "text", "YES"],
  ["public", "release_controller_heartbeats", "id", "text", "NO"],
  [
    "public",
    "release_controller_heartbeats",
    "contract_revision",
    "integer",
    "NO",
  ],
  [
    "public",
    "release_controller_heartbeats",
    "heartbeat_at",
    "timestamp with time zone",
    "NO",
  ],
  [
    "public",
    "release_controller_heartbeats",
    "started_at",
    "timestamp with time zone",
    "NO",
  ],
  ["public", "release_worker_heartbeats", "role", "text", "NO"],
  ["public", "release_worker_heartbeats", "source_revision", "text", "NO"],
  ["public", "release_worker_heartbeats", "image", "text", "NO"],
  ["public", "release_worker_heartbeats", "machine_id", "text", "NO"],
  [
    "public",
    "release_worker_heartbeats",
    "started_at",
    "timestamp with time zone",
    "NO",
  ],
  [
    "public",
    "release_worker_heartbeats",
    "heartbeat_at",
    "timestamp with time zone",
    "NO",
  ],
] as const;

const REQUIRED_CONSTRAINTS = [
  ["public", "fly_image_release_attempts", "fly_image_release_attempts_pkey"],
  [
    "public",
    "fly_image_release_attempts",
    "fly_image_release_attempts_source_revision_check",
  ],
  [
    "public",
    "fly_image_release_attempts",
    "fly_image_release_attempts_run_id_check",
  ],
  [
    "public",
    "fly_image_release_attempts",
    "fly_image_release_attempts_run_attempt_check",
  ],
  [
    "public",
    "fly_image_release_attempts",
    "fly_image_release_attempts_status_check",
  ],
  [
    "public",
    "fly_image_releases",
    "fly_image_releases_attempt_id_fly_image_release_attempts_id_fk",
  ],
  [
    "public",
    "release_worker_heartbeats",
    "release_worker_heartbeats_role_machine_pk",
  ],
  [
    "public",
    "release_worker_heartbeats",
    "release_worker_heartbeats_role_check",
  ],
  [
    "public",
    "release_worker_heartbeats",
    "release_worker_heartbeats_revision_check",
  ],
  [
    "public",
    "release_worker_heartbeats",
    "release_worker_heartbeats_image_check",
  ],
] as const;

const REQUIRED_INDEXES = [
  ["public", "fly_image_release_attempts_github_run_idx"],
  ["public", "fly_image_release_attempts_status_lease_idx"],
  ["public", "fly_image_releases_attempt_idx"],
  ["public", "release_controller_heartbeats_age_idx"],
  ["public", "release_worker_heartbeats_age_idx"],
] as const;

export type ReleaseControlSchemaQuery = <Row extends Record<string, unknown>>(
  statement: string,
) => Promise<Row[]>;

export type ReleaseControlSchemaReadiness = {
  ready: boolean;
  missingRequirements: string[];
};

export async function inspectReleaseControlSchema(
  query: ReleaseControlSchemaQuery,
): Promise<ReleaseControlSchemaReadiness> {
  const structuralRows = await query<{ requirement: string }>(
    structuralInspectionSql(),
  );
  const missingRequirements = structuralRows.map((row) => row.requirement);
  if (!missingRequirements.includes("table:drizzle.__drizzle_migrations")) {
    const [ledger] = await query<{ present: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM drizzle.__drizzle_migrations
        WHERE hash = '${RELEASE_CONTROL_SCHEMA_MIGRATION_HASH}'
      ) AS present
    `);
    if (!ledger?.present) {
      missingRequirements.push(
        `migration:${RELEASE_CONTROL_SCHEMA_MIGRATION_TAG}`,
      );
    }
  } else {
    missingRequirements.push(
      `migration:${RELEASE_CONTROL_SCHEMA_MIGRATION_TAG}`,
    );
  }
  missingRequirements.sort();
  return {
    ready: missingRequirements.length === 0,
    missingRequirements,
  };
}

function structuralInspectionSql() {
  const requirements = [
    ...REQUIRED_TABLES.map(([schema, table]) => [
      "table",
      schema,
      table,
      "",
      "",
      "",
    ]),
    ...REQUIRED_COLUMNS.map(([schema, table, column, dataType, nullable]) => [
      "column",
      schema,
      table,
      column,
      dataType,
      nullable,
    ]),
    ...REQUIRED_CONSTRAINTS.map(([schema, table, constraint]) => [
      "constraint",
      schema,
      table,
      constraint,
      "",
      "",
    ]),
    ...REQUIRED_INDEXES.map(([schema, index]) => [
      "index",
      schema,
      "",
      index,
      "",
      "",
    ]),
  ];
  const values = requirements
    .map(
      ([kind, schema, relation, member, dataType, nullable]) =>
        `(${[kind, schema, relation, member, dataType, nullable].map(sqlLiteral).join(", ")})`,
    )
    .join(",\n        ");
  return `
    WITH required(kind, schema_name, relation_name, member_name, data_type, nullable) AS (
      VALUES ${values}
    )
    SELECT
      kind || ':' || schema_name || '.' ||
        CASE WHEN relation_name = '' THEN member_name
             WHEN member_name = '' THEN relation_name
             ELSE relation_name || '.' || member_name END AS requirement
    FROM required
    WHERE CASE kind
      WHEN 'table' THEN to_regclass(format('%I.%I', schema_name, relation_name)) IS NULL
      WHEN 'column' THEN NOT EXISTS (
        SELECT 1
        FROM information_schema.columns column_record
        WHERE column_record.table_schema = schema_name
          AND column_record.table_name = relation_name
          AND column_record.column_name = member_name
          AND column_record.data_type = required.data_type
          AND column_record.is_nullable = required.nullable
      )
      WHEN 'constraint' THEN NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint constraint_record
        JOIN pg_catalog.pg_class relation_record
          ON relation_record.oid = constraint_record.conrelid
        JOIN pg_catalog.pg_namespace namespace_record
          ON namespace_record.oid = relation_record.relnamespace
        WHERE namespace_record.nspname = schema_name
          AND relation_record.relname = relation_name
          AND constraint_record.conname = member_name
      )
      WHEN 'index' THEN to_regclass(format('%I.%I', schema_name, member_name)) IS NULL
      ELSE true
    END
    ORDER BY requirement
  `;
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
