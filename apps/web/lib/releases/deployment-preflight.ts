import postgres, { type Sql } from "postgres";

export const LEGACY_RELEASE_COMPATIBILITY_BOOTSTRAP =
  "allow-legacy-stable";

export type FlyReleaseDeploymentReadiness =
  | { ready: true; mode: "enforced" | "legacy_bridge"; warning?: string }
  | { ready: false; code: string; message: string };

const RELEASE_COMPATIBILITY_COLUMNS = [
  ["fly_image_releases", "environment_gateway_config_version"],
  ["fly_image_releases", "recovery_of_release_id"],
  [
    "fly_image_release_components",
    "environment_gateway_accepted_versions",
  ],
] as const;

export type FlyReleaseCompatibilitySchemaReadiness = {
  ready: boolean;
  missingColumns: string[];
};

async function inspectFlyReleaseCompatibilitySchemaWithSql(
  sql: Sql,
): Promise<FlyReleaseCompatibilitySchemaReadiness> {
  const requiredColumns = RELEASE_COMPATIBILITY_COLUMNS.map(
    ([table, column]) => [table, column] as const,
  );
  const rows = await sql<Array<{ requirement: string }>>`
    WITH required("table", "column") AS (
      VALUES ${sql(requiredColumns)}
    )
    SELECT required."table" || '.' || required."column" AS requirement
    FROM required
    WHERE NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = required."table"
        AND column_name = required."column"
    )
    ORDER BY requirement
  `;
  const missingColumns = rows.map((row) => row.requirement);
  return { ready: missingColumns.length === 0, missingColumns };
}

export async function inspectFlyReleaseCompatibilitySchema(
  databaseUrl: string,
): Promise<FlyReleaseCompatibilitySchemaReadiness> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await inspectFlyReleaseCompatibilitySchemaWithSql(sql);
  } finally {
    await sql.end({ timeout: 0 });
  }
}

export function evaluateFlyReleaseDeploymentReadiness(input: {
  activeStatus: string | null;
  stableAcceptedVersions: number[] | null;
  producedVersion: number;
  bootstrap: string | undefined;
}): FlyReleaseDeploymentReadiness {
  if (input.activeStatus === "approved" || input.activeStatus === "deploying") {
    return {
      ready: false,
      code: "RELEASE_ACTIVE",
      message:
        "A Fly image release is actively mutating production. Pause or complete it before deploying Kestrel One.",
    };
  }
  if (input.stableAcceptedVersions === null) {
    if (input.bootstrap !== LEGACY_RELEASE_COMPATIBILITY_BOOTSTRAP) {
      return {
        ready: false,
        code: "RELEASE_COMPATIBILITY_UNKNOWN",
        message:
          "The stable Environment Router has no compatibility evidence. The one-time legacy bridge must be explicitly enabled.",
      };
    }
    return {
      ready: true,
      mode: "legacy_bridge",
      warning:
        "Legacy Fly release compatibility bridge is active. Recover forward to a metadata-bearing exact candidate before removing it.",
    };
  }
  if (input.bootstrap !== undefined) {
    return {
      ready: false,
      code: "RELEASE_COMPATIBILITY_BOOTSTRAP_EXPIRED",
      message:
        "Stable compatibility evidence exists. Remove KESTREL_RELEASE_COMPATIBILITY_BOOTSTRAP.",
    };
  }
  if (!input.stableAcceptedVersions.includes(input.producedVersion)) {
    return {
      ready: false,
      code: "RELEASE_COMPATIBILITY_BLOCKED",
      message: `The stable Environment Router does not accept gateway configuration version ${input.producedVersion}.`,
    };
  }
  return { ready: true, mode: "enforced" };
}

export async function inspectFlyReleaseDeploymentReadiness(input: {
  databaseUrl: string;
  producedVersion: number;
  bootstrap: string | undefined;
}) {
  const sql = postgres(input.databaseUrl, { max: 1 });
  try {
    const schemaState = await inspectFlyReleaseCompatibilitySchemaWithSql(sql);
    const [state] = schemaState.ready
      ? await sql<
          Array<{
            active_status: string | null;
            stable_accepted_versions: number[] | null;
          }>
        >`
          SELECT
            active_release.status AS active_status,
            router.environment_gateway_accepted_versions AS stable_accepted_versions
          FROM fly_image_release_settings settings
          LEFT JOIN fly_image_releases active_release
            ON active_release.id = settings.active_release_id
          LEFT JOIN fly_image_release_components router
            ON router.release_id = settings.stable_release_id
           AND router.role = 'environment-router'
          WHERE settings.id = 'platform'
        `
      : await sql<
          Array<{
            active_status: string | null;
            stable_accepted_versions: null;
          }>
        >`
          SELECT
            active_release.status AS active_status,
            NULL::integer[] AS stable_accepted_versions
          FROM fly_image_release_settings settings
          LEFT JOIN fly_image_releases active_release
            ON active_release.id = settings.active_release_id
          WHERE settings.id = 'platform'
        `;
    return evaluateFlyReleaseDeploymentReadiness({
      activeStatus: state?.active_status ?? null,
      stableAcceptedVersions: state?.stable_accepted_versions ?? null,
      producedVersion: input.producedVersion,
      bootstrap: input.bootstrap,
    });
  } finally {
    await sql.end({ timeout: 0 });
  }
}
