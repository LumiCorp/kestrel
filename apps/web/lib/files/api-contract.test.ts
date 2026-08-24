import assert from "node:assert/strict";
import test from "node:test";

import { fileApiRepresentationContract } from "./api-contract";
import { FILE_INLINE_REPRESENTATION_UNAVAILABLE_REASON } from "./representation";

test("file API representation fields expose truthful Knowledge eligibility", () => {
  assert.deepEqual(fileApiRepresentationContract({
    filename: "brief.pdf",
    detectedMediaType: "application/pdf",
    representationStatus: "metadata_only",
    metadataOnlyReason: "private extractor diagnostic",
  }), {
    metadataOnlyReason: FILE_INLINE_REPRESENTATION_UNAVAILABLE_REASON,
    knowledgeEligible: true,
  });
  assert.deepEqual(fileApiRepresentationContract({
    filename: "opaque.bin",
    detectedMediaType: "application/octet-stream",
    representationStatus: "metadata_only",
    metadataOnlyReason: "No interpreter.",
  }), {
    metadataOnlyReason: FILE_INLINE_REPRESENTATION_UNAVAILABLE_REASON,
    knowledgeEligible: false,
  });
});
