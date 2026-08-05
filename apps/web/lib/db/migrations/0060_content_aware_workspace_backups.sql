ALTER TABLE "workspace_backups"
  DROP CONSTRAINT IF EXISTS "workspace_backups_status_check";
--> statement-breakpoint
ALTER TABLE "workspace_backups"
  ADD CONSTRAINT "workspace_backups_status_check" CHECK (
    "status" IN ('queued', 'creating', 'available', 'deleting', 'delete_failed', 'failed', 'expired')
  );
--> statement-breakpoint
CREATE TABLE "release_controller_heartbeats" (
  "id" text PRIMARY KEY NOT NULL,
  "contract_revision" integer NOT NULL,
  "heartbeat_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "release_controller_heartbeats_age_idx"
  ON "release_controller_heartbeats" ("heartbeat_at");
--> statement-breakpoint
CREATE TABLE "workspace_backup_protections" (
  "id" text PRIMARY KEY NOT NULL,
  "backup_id" text NOT NULL REFERENCES "workspace_backups"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK (
    "kind" IN ('checkpoint', 'daily', 'pre_destructive', 'pre_promotion')
  ),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "workspace_backup_protections" (
  "id", "backup_id", "kind", "created_at", "expires_at"
)
SELECT "id" || ':legacy', "id", "reason", "created_at", "expires_at"
FROM "workspace_backups"
WHERE "status" = 'available';
--> statement-breakpoint
CREATE INDEX "workspace_backup_protections_backup_expiry_idx"
  ON "workspace_backup_protections" ("backup_id", "expires_at");
--> statement-breakpoint
CREATE INDEX "workspace_backup_protections_kind_expiry_idx"
  ON "workspace_backup_protections" ("kind", "expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_backup_protections_backup_kind_idx"
  ON "workspace_backup_protections" ("backup_id", "kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_backups_active_revision_idx"
  ON "workspace_backups" ("workspace_id", "source_revision")
  WHERE "source_revision" IS NOT NULL
    AND "status" IN ('queued', 'creating', 'available', 'deleting', 'delete_failed');
