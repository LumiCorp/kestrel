import assert from "node:assert/strict";
import { searchKnowledgeDocumentsCapabilityInputSchema } from "@/lib/agent/kestrel-knowledge-capability";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "searchKnowledgeDocumentsCapabilityInputSchema accepts bounded query input", () => {
  const parsed = searchKnowledgeDocumentsCapabilityInputSchema.parse({
    query: "  release checklist  ",
    limit: 5,
  });

  assert.deepEqual(parsed, {
    query: "release checklist",
    limit: 5,
  });
});

contractTest("web.hermetic", "searchKnowledgeDocumentsCapabilityInputSchema rejects short query and excessive limit", () => {
  assert.equal(
    searchKnowledgeDocumentsCapabilityInputSchema.safeParse({
      query: "no",
      limit: 13,
    }).success,
    false
  );
});
