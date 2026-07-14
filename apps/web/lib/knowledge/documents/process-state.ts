import type { KnowledgeEmbeddingProvenance } from "./embedding-provenance";

export function buildKnowledgeExtractionMetadata(input: {
  warnings: string[];
  metadata: unknown;
  embedding: KnowledgeEmbeddingProvenance;
}) {
  return {
    warnings: input.warnings,
    metadata: input.metadata,
    embedding: input.embedding,
  };
}

export function buildKnowledgeIngestionFailureState(input: {
  error: unknown;
  ocrMode: "live" | "fallback";
  embeddingMode: "live" | "fallback";
  embedding: KnowledgeEmbeddingProvenance;
  finishedAt: Date;
}) {
  const message =
    input.error instanceof Error
      ? input.error.message
      : "Unknown ingestion error";

  return {
    message,
    documentUpdate: {
      status: "failed" as const,
      error: message,
    },
    runUpdate: {
      status: "failed" as const,
      error: message,
      diagnostics: {
        modes: {
          ocr: input.ocrMode,
          embedding: input.embeddingMode,
        },
        embedding: input.embedding,
      },
      finishedAt: input.finishedAt,
    },
  };
}
