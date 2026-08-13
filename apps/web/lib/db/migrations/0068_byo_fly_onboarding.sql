ALTER TABLE "organization_feature_flags"
  ALTER COLUMN "updated_by_user_id" DROP NOT NULL;

INSERT INTO "organization_feature_flags" (
  "organization_id",
  "key",
  "enabled",
  "updated_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "organization"."id",
  'hosted_environments',
  true,
  NULL,
  now(),
  now()
FROM "organization"
ON CONFLICT ("organization_id", "key") DO NOTHING;

ALTER TABLE "fly_image_release_components"
  DROP CONSTRAINT "fly_image_release_components_image_check";

ALTER TABLE "fly_image_release_components"
  ADD CONSTRAINT "fly_image_release_components_image_check" CHECK (
    (
      "role" = 'workspace-runtime'
      AND (
        "image" ~ '^ghcr\.io/lumicorp/kestrel-workspace-runtime@sha256:[0-9a-f]{64}$'
        OR "image" ~ '^registry\.fly\.io/kestrel-one-runner@sha256:[0-9a-f]{64}$'
      )
    )
    OR (
      "role" = 'environment-router'
      AND (
        "image" ~ '^ghcr\.io/lumicorp/kestrel-environment-router@sha256:[0-9a-f]{64}$'
        OR "image" ~ '^registry\.fly\.io/kestrel-one-runner@sha256:[0-9a-f]{64}$'
      )
    )
    OR ("role" = 'preview-edge' AND "image" ~ '^registry\.fly\.io/kestrel-preview-edge@sha256:[0-9a-f]{64}$')
    OR ("role" = 'turn-worker' AND "image" ~ '^registry\.fly\.io/kestrel-one-turn-worker@sha256:[0-9a-f]{64}$')
    OR ("role" = 'runpod-worker' AND "image" ~ '^registry\.fly\.io/kestrel-one-runpod-worker@sha256:[0-9a-f]{64}$')
  );
