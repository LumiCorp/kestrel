ALTER TABLE "environment_runtime_versions"
  DROP CONSTRAINT IF EXISTS "environment_runtime_versions_workspace_image_check",
  DROP CONSTRAINT IF EXISTS "environment_runtime_versions_router_image_check",
  DROP CONSTRAINT IF EXISTS "environment_runtime_versions_workspace_revision_check",
  DROP CONSTRAINT IF EXISTS "environment_runtime_versions_router_revision_check",
  DROP CONSTRAINT IF EXISTS "environment_runtime_versions_run_identity_check",
  DROP COLUMN IF EXISTS "workspace_runtime_source_revision",
  DROP COLUMN IF EXISTS "environment_router_source_revision",
  DROP COLUMN IF EXISTS "github_run_id",
  DROP COLUMN IF EXISTS "github_run_attempt";

ALTER INDEX IF EXISTS "environment_runtime_versions_digest_pair_unique"
  RENAME TO "environment_runtime_versions_image_pair_unique";

ALTER TABLE "environment_runtime_channels"
  DROP CONSTRAINT IF EXISTS "environment_runtime_channels_run_identity_check",
  DROP COLUMN IF EXISTS "desired_version_id",
  DROP COLUMN IF EXISTS "last_github_run_id",
  DROP COLUMN IF EXISTS "last_github_run_attempt";

DROP TABLE IF EXISTS "fly_image_release_settings";
DROP TABLE IF EXISTS "fly_image_release_targets";
DROP TABLE IF EXISTS "fly_image_release_components";
DROP TABLE IF EXISTS "fly_image_releases";
DROP TABLE IF EXISTS "fly_image_release_attempts";
DROP TABLE IF EXISTS "release_controller_heartbeats";
DROP TABLE IF EXISTS "release_worker_heartbeats";
DROP TABLE IF EXISTS "platform_worker_heartbeats";
