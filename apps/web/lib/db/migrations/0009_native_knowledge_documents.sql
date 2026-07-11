CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "knowledge_documents" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "uploader_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "title" text,
  "filename" text NOT NULL,
  "original_filename" text NOT NULL,
  "media_type" text NOT NULL,
  "size_bytes" integer DEFAULT 0 NOT NULL,
  "checksum_sha256" text NOT NULL,
  "storage_key" text NOT NULL,
  "status" text DEFAULT 'uploaded' NOT NULL,
  "page_count" integer,
  "chunk_count" integer DEFAULT 0 NOT NULL,
  "extraction_metadata" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_storage_key_idx"
  ON "knowledge_documents" ("storage_key");
CREATE INDEX IF NOT EXISTS "knowledge_documents_org_id_idx"
  ON "knowledge_documents" ("organization_id");
CREATE INDEX IF NOT EXISTS "knowledge_documents_uploader_user_id_idx"
  ON "knowledge_documents" ("uploader_user_id");
CREATE INDEX IF NOT EXISTS "knowledge_documents_status_idx"
  ON "knowledge_documents" ("status");
CREATE INDEX IF NOT EXISTS "knowledge_documents_created_at_idx"
  ON "knowledge_documents" ("created_at");

CREATE TABLE IF NOT EXISTS "knowledge_ingestion_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "document_id" text NOT NULL REFERENCES "knowledge_documents"("id") ON DELETE cascade,
  "requested_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "stage" text DEFAULT 'upload' NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "diagnostics" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_org_id_idx"
  ON "knowledge_ingestion_runs" ("organization_id");
CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_document_id_idx"
  ON "knowledge_ingestion_runs" ("document_id");
CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_status_idx"
  ON "knowledge_ingestion_runs" ("status");
CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_stage_idx"
  ON "knowledge_ingestion_runs" ("stage");
CREATE INDEX IF NOT EXISTS "knowledge_ingestion_runs_updated_at_idx"
  ON "knowledge_ingestion_runs" ("updated_at");

CREATE TABLE IF NOT EXISTS "knowledge_document_chunks" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "document_id" text NOT NULL REFERENCES "knowledge_documents"("id") ON DELETE cascade,
  "chunk_index" integer NOT NULL,
  "content" text NOT NULL,
  "content_length" integer DEFAULT 0 NOT NULL,
  "token_count" integer DEFAULT 0 NOT NULL,
  "page_number" integer,
  "section_title" text,
  "metadata" jsonb,
  "embedding" vector(1536) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "knowledge_document_chunks_org_id_idx"
  ON "knowledge_document_chunks" ("organization_id");
CREATE INDEX IF NOT EXISTS "knowledge_document_chunks_document_id_idx"
  ON "knowledge_document_chunks" ("document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_document_chunks_document_chunk_idx"
  ON "knowledge_document_chunks" ("document_id", "chunk_index");
CREATE INDEX IF NOT EXISTS "knowledge_document_chunks_embedding_idx"
  ON "knowledge_document_chunks" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
