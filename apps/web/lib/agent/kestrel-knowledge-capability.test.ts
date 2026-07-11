import assert from "node:assert/strict";
import test from "node:test";
import { searchKnowledgeDocumentsCapabilityInputSchema } from "@/lib/agent/kestrel-knowledge-capability";

test("searchKnowledgeDocumentsCapabilityInputSchema accepts bounded query input", () => {
  const parsed = searchKnowledgeDocumentsCapabilityInputSchema.parse({
    query: "  release checklist  ",
    limit: 5,
  });

  assert.deepEqual(parsed, {
    query: "release checklist",
    limit: 5,
  });
});

test("searchKnowledgeDocumentsCapabilityInputSchema rejects short query and excessive limit", () => {
  assert.equal(
    searchKnowledgeDocumentsCapabilityInputSchema.safeParse({
      query: "no",
      limit: 13,
    }).success,
    false
  );
});
