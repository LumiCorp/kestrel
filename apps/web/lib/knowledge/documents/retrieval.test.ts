import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildKnowledgeVectorSearchQuery,
  searchKnowledgeDocumentsWithDependencies,
} from "./retrieval";
import { groupKnowledgeRetrievalRows } from "./retrieval-grouping";
import { contractTest } from "../../../../../tests/helpers/contract-test.js";


const EMPLOYEE_HANDBOOK_PATTERN = /Employee Handbook/;

contractTest("web.hermetic", "groupKnowledgeRetrievalRows groups excerpts per document and filters low scores", () => {
  const results = groupKnowledgeRetrievalRows(
    [
      {
        documentId: "doc-a",
        filename: "handbook.pdf",
        title: "Employee Handbook",
        mediaType: "application/pdf",
        chunkText: "Policy details on page one.",
        chunkIndex: 0,
        pageNumber: 1,
        sectionTitle: "Policies",
        score: 0.92,
      },
      {
        documentId: "doc-a",
        filename: "handbook.pdf",
        title: "Employee Handbook",
        mediaType: "application/pdf",
        chunkText: "More details from the same document.",
        chunkIndex: 1,
        pageNumber: 2,
        sectionTitle: "Benefits",
        score: 0.77,
      },
      {
        documentId: "doc-b",
        filename: "repo-guide.md",
        title: "Repository Guide",
        mediaType: "text/markdown",
        chunkText: "This should be filtered out.",
        chunkIndex: 0,
        pageNumber: null,
        sectionTitle: null,
        score: 0.05,
      },
    ],
    {
      documentLimit: 4,
      excerptLimitPerDocument: 2,
      scoreThreshold: 0.2,
    }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.documentId, "doc-a");
  assert.equal(results[0]?.excerptCount, 2);
  assert.equal(results[0]?.excerpts.length, 2);
  assert.equal(results[0]?.citations.length, 2);
  assert.match(
    results[0]?.citations[0]?.label ?? "",
    EMPLOYEE_HANDBOOK_PATTERN
  );
});

contractTest("web.hermetic", "groupKnowledgeRetrievalRows applies document limits after ranking documents", () => {
  const results = groupKnowledgeRetrievalRows(
    [
      {
        documentId: "doc-low",
        filename: "notes.md",
        title: "Team Notes",
        mediaType: "text/markdown",
        chunkText: "Lower scoring excerpt.",
        chunkIndex: 0,
        pageNumber: null,
        sectionTitle: null,
        score: 0.31,
      },
      {
        documentId: "doc-high",
        filename: "policy.pdf",
        title: "Security Policy",
        mediaType: "application/pdf",
        chunkText: "Higher scoring excerpt that appears later.",
        chunkIndex: 0,
        pageNumber: 4,
        sectionTitle: "Controls",
        score: 0.94,
      },
    ],
    {
      documentLimit: 1,
      scoreThreshold: 0.2,
    }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.documentId, "doc-high");
  assert.equal(results[0]?.maxScore, 0.94);
});

contractTest("web.hermetic", "vector search requires exact semantic embedding provenance", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(
    buildKnowledgeVectorSearchQuery({
      organizationId: "org-1",
      embedding: [1, 0],
      rawLimit: 12,
      provenance: {
        mode: "semantic",
        provider: "openrouter",
        model: "openai/text-embedding-3-small",
        dimensions: 1536,
      },
    })
  );

  assert.match(query.sql, /d\.extraction_metadata @> \$\d+::jsonb/);
  assert.ok(
    query.params.includes(
      JSON.stringify({
        embedding: {
          mode: "semantic",
          provider: "openrouter",
          model: "openai/text-embedding-3-small",
          dimensions: 1536,
        },
      })
    )
  );
});

const semanticRuntime = {
  provider: "openrouter",
  apiKey: "openrouter-key",
  baseURL: "https://openrouter.ai/api/v1",
  model: "openai/text-embedding-3-small",
  headers: {},
  mode: "live" as const,
  surface: "embedding" as const,
  usesPlaceholderKey: false,
  retrievalStrategy: "semantic-first" as const,
  provenance: {
    mode: "semantic" as const,
    provider: "openrouter",
    model: "openai/text-embedding-3-small",
    dimensions: 1536 as const,
  },
};

const lexicalFallbackResult = [
  {
    documentId: "legacy-doc",
    filename: "legacy.md",
    title: "Legacy notes",
    mediaType: "text/markdown",
    url: "/api/knowledge/documents/legacy-doc/download",
    maxScore: 0.5,
    excerptCount: 1,
    excerpts: [
      {
        chunkIndex: 0,
        text: "Legacy lexical evidence",
        pageNumber: null,
        sectionTitle: null,
        score: 0.5,
      },
    ],
    citations: [],
  },
];

contractTest("web.hermetic", "semantic retrieval returns paraphrased vector evidence before lexical fallback", async () => {
  let lexicalCalls = 0;
  const results = await searchKnowledgeDocumentsWithDependencies(
    {
      organizationId: "org-1",
      query: "When may leadership be paged?",
    },
    {
      embeddingRuntime: semanticRuntime,
      embedQuery: async () => [1, 0],
      searchVector: async () => [
        {
          documentId: "semantic-doc",
          filename: "operations.md",
          title: "Operations policy",
          mediaType: "text/markdown",
          chunkText:
            "Executive notification requires a completed severity assessment.",
          chunkIndex: 0,
          pageNumber: null,
          sectionTitle: "Escalation prerequisite",
          score: 0.91,
        },
      ],
      searchLexical: async () => {
        lexicalCalls += 1;
        return lexicalFallbackResult;
      },
    }
  );

  assert.equal(lexicalCalls, 0);
  assert.equal(results[0]?.documentId, "semantic-doc");
  assert.match(results[0]?.excerpts[0]?.text ?? "", /severity assessment/);
});

contractTest("web.hermetic", "query embedding failures fall back to lexical retrieval", async () => {
  let capturedError: unknown;
  const results = await searchKnowledgeDocumentsWithDependencies(
    {
      organizationId: "org-1",
      query: "provider outage",
    },
    {
      embeddingRuntime: semanticRuntime,
      embedQuery: async () => {
        throw new Error("OpenRouter unavailable");
      },
      searchVector: async () => {
        throw new Error("vector search should not run");
      },
      searchLexical: async () => lexicalFallbackResult,
      onQueryEmbeddingError: (error) => {
        capturedError = error;
      },
    }
  );

  assert.match(String(capturedError), /OpenRouter unavailable/);
  assert.equal(results[0]?.documentId, "legacy-doc");
});

contractTest("web.hermetic", "no semantic results fall back to the full lexical corpus", async () => {
  const results = await searchKnowledgeDocumentsWithDependencies(
    {
      organizationId: "org-1",
      query: "no semantic match",
    },
    {
      embeddingRuntime: semanticRuntime,
      embedQuery: async () => [1, 0],
      searchVector: async () => [],
      searchLexical: async () => lexicalFallbackResult,
    }
  );

  assert.equal(results[0]?.documentId, "legacy-doc");
});
