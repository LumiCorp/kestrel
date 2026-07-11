WITH ranked_documents AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY organization_id, checksum_sha256
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS duplicate_rank
  FROM knowledge_documents
)
DELETE FROM knowledge_documents
WHERE id IN (
  SELECT id
  FROM ranked_documents
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_org_checksum_idx"
  ON "knowledge_documents" ("organization_id", "checksum_sha256");
