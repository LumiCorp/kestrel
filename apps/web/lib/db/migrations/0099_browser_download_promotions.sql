CREATE TABLE "browser_download_promotions" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "session_id" text NOT NULL,
  "generation" integer NOT NULL,
  "pending_download_id" text NOT NULL,
  "sha256" text NOT NULL,
  "effect_revision" text NOT NULL,
  "file_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "browser_download_promotions_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "browser_download_promotions_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "browser_download_promotions_effect_revision_check" CHECK ("effect_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "browser_download_promotions"
  ADD CONSTRAINT "browser_download_promotions_organization_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_download_promotions"
  ADD CONSTRAINT "browser_download_promotions_thread_fk"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "browser_download_promotions"
  ADD CONSTRAINT "browser_download_promotions_file_fk"
  FOREIGN KEY ("file_id") REFERENCES "kestrel_files"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_download_promotions_file_idx"
  ON "browser_download_promotions" ("file_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_download_promotions_quarantine_idx"
  ON "browser_download_promotions" (
    "organization_id", "session_id", "generation", "pending_download_id"
  );
--> statement-breakpoint
CREATE INDEX "browser_download_promotions_thread_idx"
  ON "browser_download_promotions" ("thread_id");
