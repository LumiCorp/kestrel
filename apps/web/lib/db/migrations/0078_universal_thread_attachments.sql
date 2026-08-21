CREATE TABLE "file_blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "file_blobs_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
	CONSTRAINT "file_blobs_size_check" CHECK ("size_bytes" BETWEEN 0 AND 104857600),
	CONSTRAINT "file_blobs_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "file_blobs_scan_check" CHECK ("scan_status" IN ('pending', 'clean', 'quarantined', 'unavailable'))
);
--> statement-breakpoint
CREATE INDEX "file_blobs_org_id_idx" ON "file_blobs" ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "file_blobs_org_sha256_idx" ON "file_blobs" ("organization_id", "sha256") WHERE "sha256" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "file_blobs_object_key_idx" ON "file_blobs" ("object_key");
--> statement-breakpoint
CREATE TABLE "kestrel_files" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"uploader_user_id" text,
	"blob_id" text NOT NULL,
	"filename" text NOT NULL,
	"declared_media_type" text,
	"detected_media_type" text,
	"size_bytes" integer NOT NULL,
	"sha256" text,
	"lifecycle_state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kestrel_files_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
	CONSTRAINT "kestrel_files_uploader_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "user"("id") ON DELETE set null,
	CONSTRAINT "kestrel_files_blob_fk" FOREIGN KEY ("blob_id") REFERENCES "file_blobs"("id") ON DELETE restrict,
	CONSTRAINT "kestrel_files_size_check" CHECK ("size_bytes" BETWEEN 0 AND 104857600),
	CONSTRAINT "kestrel_files_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "kestrel_files_lifecycle_check" CHECK ("lifecycle_state" IN ('draft', 'ready', 'quarantined', 'failed', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX "kestrel_files_org_id_idx" ON "kestrel_files" ("organization_id");
--> statement-breakpoint
CREATE INDEX "kestrel_files_blob_id_idx" ON "kestrel_files" ("blob_id");
--> statement-breakpoint
CREATE INDEX "kestrel_files_lifecycle_created_idx" ON "kestrel_files" ("lifecycle_state", "created_at");
--> statement-breakpoint
CREATE TABLE "file_scope_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"thread_id" text,
	"project_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "file_scope_grants_file_fk" FOREIGN KEY ("file_id") REFERENCES "kestrel_files"("id") ON DELETE cascade,
	CONSTRAINT "file_scope_grants_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
	CONSTRAINT "file_scope_grants_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE cascade,
	CONSTRAINT "file_scope_grants_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
	CONSTRAINT "file_scope_grants_creator_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE set null,
	CONSTRAINT "file_scope_grants_scope_check" CHECK (
		("scope_type" = 'thread' AND "thread_id" IS NOT NULL AND "project_id" IS NULL)
		OR ("scope_type" = 'project' AND "thread_id" IS NULL AND "project_id" IS NOT NULL)
		OR ("scope_type" = 'organization' AND "thread_id" IS NULL AND "project_id" IS NULL)
	)
);
--> statement-breakpoint
CREATE INDEX "file_scope_grants_file_idx" ON "file_scope_grants" ("file_id");
--> statement-breakpoint
CREATE INDEX "file_scope_grants_thread_idx" ON "file_scope_grants" ("thread_id");
--> statement-breakpoint
CREATE INDEX "file_scope_grants_project_idx" ON "file_scope_grants" ("project_id");
--> statement-breakpoint
CREATE INDEX "file_scope_grants_org_scope_idx" ON "file_scope_grants" ("organization_id", "scope_type");
--> statement-breakpoint
CREATE UNIQUE INDEX "file_scope_grants_live_thread_idx" ON "file_scope_grants" ("file_id", "thread_id") WHERE "scope_type" = 'thread' AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "file_scope_grants_live_project_idx" ON "file_scope_grants" ("file_id", "project_id") WHERE "scope_type" = 'project' AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "file_scope_grants_live_org_idx" ON "file_scope_grants" ("file_id", "organization_id") WHERE "scope_type" = 'organization' AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "file_representations" (
	"id" text PRIMARY KEY NOT NULL,
	"blob_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"media_type" text NOT NULL,
	"text_content" text,
	"object_key" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_representations_blob_fk" FOREIGN KEY ("blob_id") REFERENCES "file_blobs"("id") ON DELETE cascade,
	CONSTRAINT "file_representations_kind_check" CHECK ("kind" IN ('native_image', 'extracted_text', 'metadata_only')),
	CONSTRAINT "file_representations_status_check" CHECK ("status" IN ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "file_representations_blob_kind_idx" ON "file_representations" ("blob_id", "kind");
--> statement-breakpoint
CREATE INDEX "file_representations_status_idx" ON "file_representations" ("status");
--> statement-breakpoint
CREATE TABLE "thread_message_files" (
	"message_id" text NOT NULL,
	"file_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "thread_message_files_pk" PRIMARY KEY("message_id", "file_id"),
	CONSTRAINT "thread_message_files_message_fk" FOREIGN KEY ("message_id") REFERENCES "thread_messages"("id") ON DELETE cascade,
	CONSTRAINT "thread_message_files_file_fk" FOREIGN KEY ("file_id") REFERENCES "kestrel_files"("id") ON DELETE cascade,
	CONSTRAINT "thread_message_files_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 19)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_message_files_message_ordinal_idx" ON "thread_message_files" ("message_id", "ordinal");
--> statement-breakpoint
CREATE INDEX "thread_message_files_file_id_idx" ON "thread_message_files" ("file_id");
--> statement-breakpoint
CREATE TABLE "file_backfill_progress" (
	"source" text PRIMARY KEY NOT NULL,
	"cursor_created_at" timestamp with time zone,
	"cursor_record_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"scanned_count" integer DEFAULT 0 NOT NULL,
	"registered_count" integer DEFAULT 0 NOT NULL,
	"missing_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_backfill_progress_status_check" CHECK ("status" IN ('pending', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "file_backfill_results" (
	"source_key" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"file_id" text,
	"status" text NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_backfill_results_file_fk" FOREIGN KEY ("file_id") REFERENCES "kestrel_files"("id") ON DELETE set null,
	CONSTRAINT "file_backfill_results_status_check" CHECK ("status" IN ('registered', 'missing', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "file_backfill_results_source_idx" ON "file_backfill_results" ("source");
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "file_id" text;
--> statement-breakpoint
INSERT INTO "file_blobs" ("id", "organization_id", "object_key", "size_bytes", "sha256", "scan_status", "created_at")
SELECT DISTINCT ON ("organization_id", "checksum_sha256")
	'blob-knowledge-' || "id", "organization_id", "storage_key", "size_bytes", "checksum_sha256", 'unavailable', "created_at"
FROM "knowledge_documents"
ORDER BY "organization_id", "checksum_sha256", "created_at", "id";
--> statement-breakpoint
INSERT INTO "kestrel_files" ("id", "organization_id", "uploader_user_id", "blob_id", "filename", "declared_media_type", "detected_media_type", "size_bytes", "sha256", "lifecycle_state", "created_at")
SELECT
	'file-knowledge-' || document."id",
	document."organization_id",
	document."uploader_user_id",
	blob."id",
	document."original_filename",
	document."media_type",
	document."media_type",
	document."size_bytes",
	document."checksum_sha256",
	CASE WHEN document."status" = 'failed' THEN 'failed' ELSE 'ready' END,
	document."created_at"
FROM "knowledge_documents" document
JOIN "file_blobs" blob
	ON blob."organization_id" = document."organization_id"
	AND blob."sha256" = document."checksum_sha256";
--> statement-breakpoint
UPDATE "knowledge_documents" SET "file_id" = 'file-knowledge-' || "id";
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ALTER COLUMN "file_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_file_fk" FOREIGN KEY ("file_id") REFERENCES "kestrel_files"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX "knowledge_documents_file_id_idx" ON "knowledge_documents" ("file_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_file_org_scope_idx" ON "knowledge_documents" ("file_id", "scope") WHERE "scope" = 'organization' AND "project_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_file_project_scope_idx" ON "knowledge_documents" ("file_id", "project_id") WHERE "scope" = 'project' AND "project_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "file_scope_grants" ("id", "file_id", "organization_id", "scope_type", "project_id", "created_by_user_id", "created_at")
SELECT
	'grant-knowledge-' || "id",
	"file_id",
	"organization_id",
	CASE WHEN "project_id" IS NULL THEN 'organization' ELSE 'project' END,
	"project_id",
	"uploader_user_id",
	"created_at"
FROM "knowledge_documents";
