import postgres from "postgres";

export const LEGACY_RELEASE_COMPATIBILITY_BOOTSTRAP =
  "allow-legacy-stable";

export type FlyReleaseDeploymentReadiness =
  | { ready: true; mode: "enforced" | "legacy_bridge"; warning?: string }
  | { ready: false; code: string; message: string };

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
    const [schemaState] = await sql<Array<{ metadata_available: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'fly_image_release_components'
          AND column_name = 'environment_gateway_accepted_versions'
      ) AS metadata_available
    `;
    const [state] = schemaState?.metadata_available
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
