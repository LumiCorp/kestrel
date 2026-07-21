import assert from "node:assert/strict";
import {
  getKnowledgeDocumentRetrievalMode,
  getKnowledgeEmbeddingProvenance,
  type SemanticEmbeddingProvenance,
} from "./embedding-provenance";
import { contractTest } from "../../../../../tests/helpers/contract-test.js";


const activeProvenance: SemanticEmbeddingProvenance = {
  mode: "semantic",
  provider: "openrouter",
  model: "openai/text-embedding-3-small",
  dimensions: 1536,
};

contractTest("web.hermetic", "matching validated provenance marks a document semantic", () => {
  const metadata = {
    warnings: [],
    embedding: activeProvenance,
  };

  assert.deepEqual(getKnowledgeEmbeddingProvenance(metadata), activeProvenance);
  assert.equal(
    getKnowledgeDocumentRetrievalMode(metadata, activeProvenance),
    "semantic"
  );
});

contractTest("web.hermetic", "legacy, malformed, and model-mismatched metadata remain lexical", () => {
  assert.equal(
    getKnowledgeDocumentRetrievalMode(null, activeProvenance),
    "lexical"
  );
  assert.equal(
    getKnowledgeDocumentRetrievalMode(
      { embedding: { ...activeProvenance, dimensions: 768 } },
      activeProvenance
    ),
    "lexical"
  );
  assert.equal(
    getKnowledgeDocumentRetrievalMode(
      {
        embedding: {
          ...activeProvenance,
          model: "another/embedding-model",
        },
      },
      activeProvenance
    ),
    "lexical"
  );
});
