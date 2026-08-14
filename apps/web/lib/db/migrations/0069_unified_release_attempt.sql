CREATE TABLE "fly_image_release_attempts" (
  "id" text PRIMARY KEY NOT NULL,
  "source_revision" text NOT NULL,
  "trigger" text NOT NULL,
  "force_all" boolean NOT NULL,
  "github_run_id" text NOT NULL,
  "github_run_attempt" integer NOT NULL,
  "status" text DEFAULT 'acquired' NOT NULL,
  "lease_expires_at" timestamp with time zone NOT NULL,
  "release_id" text,
  "failure_evidence" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fly_image_release_attempts_source_revision_check" CHECK ("source_revision" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "fly_image_release_attempts_run_id_check" CHECK ("github_run_id" ~ '^[0-9]+$'),
  CONSTRAINT "fly_image_release_attempts_run_attempt_check" CHECK ("github_run_attempt" > 0),
  CONSTRAINT "fly_image_release_attempts_status_check" CHECK ("status" IN ('acquired', 'building', 'candidate', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fly_image_release_attempts_github_run_idx" ON "fly_image_release_attempts" USING btree ("github_run_id", "github_run_attempt");
--> statement-breakpoint
CREATE INDEX "fly_image_release_attempts_status_lease_idx" ON "fly_image_release_attempts" USING btree ("status", "lease_expires_at");
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD COLUMN "manifest_version" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD COLUMN "attempt_id" text;
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD COLUMN "migration_expected_head" text;
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD COLUMN "migration_expected_history_lock_hash" text;
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD COLUMN "migration_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD COLUMN "controller_image" text;
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD COLUMN "controller_input_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD COLUMN "controller_contract_revision" integer;
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD COLUMN "controller_prepared_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fly_image_releases" ADD CONSTRAINT "fly_image_releases_attempt_id_fly_image_release_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."fly_image_release_attempts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "fly_image_releases_attempt_idx" ON "fly_image_releases" USING btree ("attempt_id") WHERE "attempt_id" is not null;
--> statement-breakpoint
ALTER TABLE "release_controller_heartbeats" ADD COLUMN "source_revision" text;
--> statement-breakpoint
ALTER TABLE "release_controller_heartbeats" ADD COLUMN "image" text;
--> statement-breakpoint
ALTER TABLE "release_controller_heartbeats" ADD COLUMN "input_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "release_controller_heartbeats" ADD COLUMN "machine_id" text;
--> statement-breakpoint
CREATE TABLE "release_worker_heartbeats" (
  "role" text NOT NULL,
  "source_revision" text NOT NULL,
  "image" text NOT NULL,
  "machine_id" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "heartbeat_at" timestamp with time zone NOT NULL,
  CONSTRAINT "release_worker_heartbeats_role_machine_pk" PRIMARY KEY("role", "machine_id"),
  CONSTRAINT "release_worker_heartbeats_role_check" CHECK ("role" IN ('turn-worker', 'runpod-worker')),
  CONSTRAINT "release_worker_heartbeats_revision_check" CHECK ("source_revision" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "release_worker_heartbeats_image_check" CHECK ("image" ~ '^registry\.fly\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "release_worker_heartbeats_age_idx" ON "release_worker_heartbeats" USING btree ("heartbeat_at");
