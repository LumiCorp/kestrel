ALTER TABLE "organization"
  ADD COLUMN "lifecycle_state" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_lifecycle_state_check"
  CHECK ("lifecycle_state" IN ('active', 'deleting'));
--> statement-breakpoint
CREATE TABLE "organization_deletion_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "organization_name" text NOT NULL,
  "requested_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "stage" text DEFAULT 'requested' NOT NULL,
  "idempotency_key" text NOT NULL,
  "inventory" jsonb,
  "result" jsonb,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_deletion_operations_status_check"
    CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_deletion_operations_idempotency_idx"
  ON "organization_deletion_operations" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "organization_deletion_operations_org_status_idx"
  ON "organization_deletion_operations" ("organization_id", "status");
