ALTER TABLE "fly_image_releases"
  ADD COLUMN "environment_gateway_config_version" integer,
  ADD COLUMN "recovery_of_release_id" text;
--> statement-breakpoint
ALTER TABLE "fly_image_releases"
  ADD CONSTRAINT "fly_image_releases_gateway_config_version_check"
  CHECK (
    "environment_gateway_config_version" IS NULL
    OR "environment_gateway_config_version" > 0
  );
--> statement-breakpoint
ALTER TABLE "fly_image_releases"
  ADD CONSTRAINT "fly_image_releases_recovery_of_fk"
  FOREIGN KEY ("recovery_of_release_id")
  REFERENCES "fly_image_releases"("id")
  ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "fly_image_release_components"
  ADD COLUMN "environment_gateway_accepted_versions" integer[];
--> statement-breakpoint
ALTER TABLE "fly_image_release_components"
  ADD CONSTRAINT "fly_image_release_components_gateway_versions_role_check"
  CHECK (
    "environment_gateway_accepted_versions" IS NULL
    OR "role" = 'environment-router'
  );
