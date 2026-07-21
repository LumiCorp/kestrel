import assert from "node:assert/strict";
import { buildKnowledgeAnswerContext } from "./answer-context";
import { contractTest } from "../../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "buildKnowledgeAnswerContext numbers documents and preserves citation locations", () => {
  const result = buildKnowledgeAnswerContext([
    {
      documentId: "document-1",
      filename: "runbook.pdf",
      title: "Incident Runbook",
      mediaType: "application/pdf",
      url: "/api/knowledge/documents/document-1/download",
      maxScore: 0.91,
      excerptCount: 1,
      excerpts: [
        {
          chunkIndex: 2,
          text: "Escalate a severity-one incident after five minutes.",
          pageNumber: 4,
          sectionTitle: "Escalation",
          score: 0.91,
        },
      ],
      citations: [
        {
          label: "Incident Runbook (page 4 · Escalation)",
          url: "/api/knowledge/documents/document-1/download",
          pageNumber: 4,
          sectionTitle: "Escalation",
        },
      ],
    },
  ]);

  assert.equal(result.sources[0]?.citationNumber, 1);
  assert.equal(result.sources[0]?.label, "Incident Runbook");
  assert.deepEqual(result.sources[0]?.locations, [
    "Incident Runbook (page 4 · Escalation)",
  ]);
  assert.match(result.context, /SOURCE 1: Incident Runbook/);
  assert.match(result.context, /Excerpt 1 \(page 4 · Escalation\)/);
  assert.match(result.context, /severity-one incident/);
});
