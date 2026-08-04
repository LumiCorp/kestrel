import { z } from "zod";
import type {
  MemoryReadBindingV1,
  MemoryReadContextV1,
  MemoryScopeV1,
} from "@kestrel-agents/kestrel";
import { searchKnowledgeDocuments } from "@/lib/knowledge/documents/retrieval";

export const searchKnowledgeDocumentsCapabilityInputSchema = z
  .object({
    query: z.string().trim().min(3).max(1000),
    limit: z.number().int().min(1).max(12).optional(),
  })
  .strict();

export type SearchKnowledgeDocumentsCapabilityInput = z.infer<
  typeof searchKnowledgeDocumentsCapabilityInputSchema
>;

export async function executeSearchKnowledgeDocumentsCapability(input: {
  payload: unknown;
  binding: MemoryReadBindingV1;
  context: MemoryReadContextV1;
  scope: MemoryScopeV1;
  documentIds?: string[];
}) {
  const payload = searchKnowledgeDocumentsCapabilityInputSchema.parse(
    input.payload
  );
  const results = await searchKnowledgeDocuments({
    binding: input.binding,
    context: input.context,
    scope: input.scope,
    query: payload.query,
    limit: payload.limit,
    documentIds: input.documentIds,
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
