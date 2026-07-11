export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

export const KNOWLEDGE_DOCUMENT_QUEUE = "knowledge.document.ingest";

export const KNOWLEDGE_DOCUMENT_STATUS = [
  "uploaded",
  "processing",
  "ready",
  "partial",
  "failed",
] as const;

export const KNOWLEDGE_INGESTION_RUN_STAGE = [
  "upload",
  "extract",
  "chunk",
  "embed",
  "complete",
] as const;

export const KNOWLEDGE_INGESTION_RUN_STATUS = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;

export type KnowledgeDocumentStatus =
  (typeof KNOWLEDGE_DOCUMENT_STATUS)[number];
export type KnowledgeIngestionRunStage =
  (typeof KNOWLEDGE_INGESTION_RUN_STAGE)[number];
export type KnowledgeIngestionRunStatus =
  (typeof KNOWLEDGE_INGESTION_RUN_STATUS)[number];
