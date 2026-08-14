ALTER TABLE "fly_image_release_components"
  ADD COLUMN "configuration_contract_fingerprint" text;

ALTER TABLE "fly_image_release_components"
  ADD CONSTRAINT "fly_image_release_components_configuration_fingerprint_check" CHECK (
    (
      "role" = 'turn-worker'
      AND (
        "configuration_contract_fingerprint" IS NULL
        OR "configuration_contract_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
      )
    )
    OR (
      "role" <> 'turn-worker'
      AND "configuration_contract_fingerprint" IS NULL
    )
  );

ALTER TABLE "fly_image_releases"
  ADD COLUMN "turn_worker_configuration_approved_by_user_id" text
  REFERENCES "user"("id") ON DELETE SET NULL;

ALTER TABLE "fly_image_releases"
  ADD COLUMN "turn_worker_configuration_approved_at" timestamptz;

CREATE TABLE "platform_worker_heartbeats" (
  "worker_role" text NOT NULL,
  "machine_id" text NOT NULL,
  "source_revision" text NOT NULL,
  "configuration_fingerprint" text NOT NULL,
  "contract_revision" integer NOT NULL,
  "process_started_at" timestamptz NOT NULL,
  "heartbeat_at" timestamptz NOT NULL,
  CONSTRAINT "platform_worker_heartbeats_pk"
    PRIMARY KEY ("worker_role", "machine_id"),
  CONSTRAINT "platform_worker_heartbeats_role_check"
    CHECK ("worker_role" IN ('turn-worker')),
  CONSTRAINT "platform_worker_heartbeats_source_revision_check"
    CHECK ("source_revision" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "platform_worker_heartbeats_configuration_fingerprint_check"
    CHECK ("configuration_fingerprint" ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX "platform_worker_heartbeats_match_idx"
  ON "platform_worker_heartbeats" (
    "worker_role",
    "source_revision",
    "configuration_fingerprint",
    "heartbeat_at"
  );
