import { z } from "zod";
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "./constants";

export const semanticEmbeddingProvenanceSchema = z
  .object({
    mode: z.literal("semantic"),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    dimensions: z.literal(KNOWLEDGE_EMBEDDING_DIMENSIONS),
  })
  .strict();

const lexicalEmbeddingProvenanceSchema = z
  .object({
    mode: z.literal("lexical"),
  })
  .strict();

const extractionMetadataSchema = z
  .object({
    embedding: z
      .union([
        semanticEmbeddingProvenanceSchema,
        lexicalEmbeddingProvenanceSchema,
      ])
      .optional(),
  })
  .passthrough();

export type SemanticEmbeddingProvenance = z.infer<
  typeof semanticEmbeddingProvenanceSchema
>;
export type KnowledgeEmbeddingProvenance =
  | SemanticEmbeddingProvenance
  | z.infer<typeof lexicalEmbeddingProvenanceSchema>;
export type KnowledgeDocumentRetrievalMode = "semantic" | "lexical";

export function getKnowledgeEmbeddingProvenance(
  extractionMetadata: unknown
): KnowledgeEmbeddingProvenance | null {
  const parsed = extractionMetadataSchema.safeParse(extractionMetadata);
  return parsed.success ? (parsed.data.embedding ?? null) : null;
}

export function semanticEmbeddingProvenanceMatches(
  left: SemanticEmbeddingProvenance,
  right: SemanticEmbeddingProvenance
) {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.dimensions === right.dimensions
  );
}

export function getKnowledgeDocumentRetrievalMode(
  extractionMetadata: unknown,
  activeProvenance: SemanticEmbeddingProvenance | null
): KnowledgeDocumentRetrievalMode {
  const storedProvenance = getKnowledgeEmbeddingProvenance(extractionMetadata);
  return activeProvenance &&
    storedProvenance?.mode === "semantic" &&
    semanticEmbeddingProvenanceMatches(storedProvenance, activeProvenance)
    ? "semantic"
    : "lexical";
}
