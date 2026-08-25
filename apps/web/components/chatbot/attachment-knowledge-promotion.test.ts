import assert from "node:assert/strict";
import test from "node:test";
import type { Attachment } from "@/lib/types";
import {
  beginKnowledgePromotion,
  finishKnowledgePromotion,
  selectKnowledgePromotionCandidates,
} from "./attachment-knowledge-promotion";

const base: Attachment = {
  attachmentId: "file-1",
  name: "brief.pdf",
  contentType: "application/pdf",
  sizeBytes: 12,
  sha256: "a".repeat(64),
  status: "ready",
  representationStatus: "extracted_text",
  url: "/api/files/file-1/content",
};

test("Knowledge promotion is offered only for eligible uploads", () => {
  const eligible = { ...base, knowledgeEligible: true };
  const unsupported = {
    ...base,
    attachmentId: "file-2",
    name: "archive.bin",
    contentType: "application/octet-stream",
    representationStatus: "metadata_only" as const,
    knowledgeEligible: false,
  };
  assert.deepEqual(selectKnowledgePromotionCandidates([eligible, unsupported]), [eligible]);
});

test("Knowledge promotion synchronously admits only one request", () => {
  const singleFlight = { current: false };
  assert.equal(beginKnowledgePromotion(singleFlight), true);
  assert.equal(beginKnowledgePromotion(singleFlight), false);
  finishKnowledgePromotion(singleFlight);
  assert.equal(beginKnowledgePromotion(singleFlight), true);
});
