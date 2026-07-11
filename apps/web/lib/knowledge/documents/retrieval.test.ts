import assert from "node:assert/strict";
import test from "node:test";
import { groupKnowledgeRetrievalRows } from "./retrieval-grouping";

const EMPLOYEE_HANDBOOK_PATTERN = /Employee Handbook/;

test("groupKnowledgeRetrievalRows groups excerpts per document and filters low scores", () => {
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

test("groupKnowledgeRetrievalRows applies document limits after ranking documents", () => {
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
