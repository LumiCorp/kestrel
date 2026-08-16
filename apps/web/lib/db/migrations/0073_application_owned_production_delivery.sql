ALTER TABLE "environment_runtime_versions"
  DROP CONSTRAINT "environment_runtime_versions_workspace_image_check",
  DROP CONSTRAINT "environment_runtime_versions_router_image_check";

ALTER TABLE "environment_runtime_versions"
  ADD CONSTRAINT "environment_runtime_versions_workspace_image_check"
    CHECK ("workspace_runtime_image" ~ '^ghcr\.io/lumicorp/kestrel-workspace-runtime(@sha256:[0-9a-f]{64}|:production-[1-9][0-9]*-[1-9][0-9]*)$'),
  ADD CONSTRAINT "environment_runtime_versions_router_image_check"
    CHECK ("environment_router_image" ~ '^ghcr\.io/lumicorp/kestrel-environment-router(@sha256:[0-9a-f]{64}|:production-[1-9][0-9]*-[1-9][0-9]*)$');

ALTER TABLE "environment_runtime_channels"
  ADD COLUMN "desired_version_id" text
    REFERENCES "environment_runtime_versions"("id") ON DELETE RESTRICT;
