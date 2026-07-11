import { z } from "zod";
import { searchKnowledgeDocuments } from "@/lib/knowledge/documents/retrieval";

export const searchKnowledgeDocumentsCapabilityInputSchema = z.object({
  query: z.string().trim().min(3).max(1000),
  limit: z.number().int().min(1).max(12).optional(),
});

export type SearchKnowledgeDocumentsCapabilityInput = z.infer<
  typeof searchKnowledgeDocumentsCapabilityInputSchema
>;

export async function executeSearchKnowledgeDocumentsCapability(input: {
  organizationId: string;
  payload: unknown;
}) {
  const payload = searchKnowledgeDocumentsCapabilityInputSchema.parse(
    input.payload
  );
  const results = await searchKnowledgeDocuments({
    organizationId: input.organizationId,
    query: payload.query,
    limit: payload.limit,
  });

  return {
    query: payload.query,
    count: results.length,
    excerptCount: results.reduce(
      (total, result) => total + result.excerptCount,
      0
    ),
    results,
  };
}
