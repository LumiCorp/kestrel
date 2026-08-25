DROP INDEX IF EXISTS "knowledge_documents_org_checksum_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "knowledge_documents_project_checksum_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "knowledge_documents_storage_key_idx";
--> statement-breakpoint
CREATE INDEX "knowledge_documents_org_checksum_idx"
  ON "knowledge_documents" ("organization_id", "checksum_sha256")
  WHERE "project_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "knowledge_documents_project_checksum_idx"
  ON "knowledge_documents" ("project_id", "checksum_sha256")
  WHERE "project_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "knowledge_documents_storage_key_idx"
  ON "knowledge_documents" ("storage_key");
