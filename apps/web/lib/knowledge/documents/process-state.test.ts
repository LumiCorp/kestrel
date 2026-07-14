import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKnowledgeExtractionMetadata,
  buildKnowledgeIngestionFailureState,
} from "./process-state";

const semanticEmbedding = {
  mode: "semantic" as const,
  provider: "openrouter",
  model: "openai/text-embedding-3-small",
  dimensions: 1536 as const,
};

test("successful ingestion metadata records semantic provenance", () => {
  assert.deepEqual(
    buildKnowledgeExtractionMetadata({
      warnings: [],
      metadata: { title: "Incident policy" },
      embedding: semanticEmbedding,
    }),
    {
      warnings: [],
      metadata: { title: "Incident policy" },
      embedding: semanticEmbedding,
    }
  );
});

test("embedding failures produce visible failed document and run state", () => {
  const finishedAt = new Date("2026-07-14T12:00:00.000Z");
  const failure = buildKnowledgeIngestionFailureState({
    error: new Error(
      "Knowledge embedding request failed: provider unavailable"
    ),
    ocrMode: "fallback",
    embeddingMode: "live",
    embedding: semanticEmbedding,
    finishedAt,
  });

  assert.deepEqual(failure.documentUpdate, {
    status: "failed",
    error: "Knowledge embedding request failed: provider unavailable",
  });
  assert.equal(failure.runUpdate.status, "failed");
  assert.equal(
    failure.runUpdate.error,
    "Knowledge embedding request failed: provider unavailable"
  );
  assert.deepEqual(failure.runUpdate.diagnostics.embedding, semanticEmbedding);
  assert.equal(failure.runUpdate.finishedAt, finishedAt);
});
