CREATE TABLE "browser_download_staged_objects" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "generation" integer NOT NULL,
  "pending_download_id" text NOT NULL,
  "sha256" text NOT NULL,
  "effect_revision" text NOT NULL,
  "object_key" text NOT NULL,
  "state" text NOT NULL,
  "file_id" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "browser_download_staged_objects_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "browser_download_staged_objects_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "browser_download_staged_objects_state_check" CHECK ("state" IN ('receiving', 'staged', 'cleanup_pending', 'cleaned', 'promoted'))
);
--> statement-breakpoint
ALTER TABLE "browser_download_staged_objects"
  ADD CONSTRAINT "browser_download_staged_objects_organization_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_download_staged_objects"
  ADD CONSTRAINT "browser_download_staged_objects_file_fk"
  FOREIGN KEY ("file_id") REFERENCES "kestrel_files"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_download_staged_objects_quarantine_idx"
  ON "browser_download_staged_objects" (
    "organization_id", "session_id", "generation", "pending_download_id"
  );
--> statement-breakpoint
CREATE INDEX "browser_download_staged_objects_expiry_idx"
  ON "browser_download_staged_objects" ("state", "expires_at");
