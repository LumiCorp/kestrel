import assert from "node:assert/strict";
import test from "node:test";

import {
  FILE_INLINE_REPRESENTATION_UNAVAILABLE_REASON,
  isNativeImageRepresentationMediaType,
  isReusableFileRepresentation,
  modelVisibleMetadataOnlyReason,
  recordFileRepresentationOutcome,
} from "./representation";

test("native-image routing is limited to supported image formats", () => {
  for (const mediaType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    assert.equal(isNativeImageRepresentationMediaType(mediaType), true);
  }
  assert.equal(isNativeImageRepresentationMediaType("image/svg+xml"), false);
  assert.equal(isNativeImageRepresentationMediaType("application/octet-stream"), false);
});

test("metadata-only model context describes the original as available", () => {
  assert.equal(
    modelVisibleMetadataOnlyReason("metadata_only", "private extractor diagnostic"),
    FILE_INLINE_REPRESENTATION_UNAVAILABLE_REASON,
  );
  assert.equal(
    modelVisibleMetadataOnlyReason("metadata_only", null),
    FILE_INLINE_REPRESENTATION_UNAVAILABLE_REASON,
  );
  assert.equal(modelVisibleMetadataOnlyReason("extracted_text", "diagnostic"), undefined);
});

test("only terminal representations and genuinely unsupported metadata are reusable", () => {
  assert.equal(isReusableFileRepresentation({
    kind: "extracted_text",
    status: "ready",
    mediaType: "text/markdown",
  }), true);
  assert.equal(isReusableFileRepresentation({
    kind: "metadata_only",
    status: "ready",
    mediaType: "application/octet-stream",
  }), true);
  assert.equal(isReusableFileRepresentation({
    kind: "metadata_only",
    status: "ready",
    mediaType: "application/pdf",
  }), false);
  assert.equal(isReusableFileRepresentation({
    kind: "metadata_only",
    status: "ready",
    mediaType: "image/png",
  }), false);
  assert.equal(isReusableFileRepresentation({
    kind: "metadata_only",
    status: "failed",
    mediaType: "application/pdf",
  }), false);
});

test("representation telemetry is structured and content-free", () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  recordFileRepresentationOutcome({
    outcome: "metadata_only",
    mediaType: "application/pdf",
    durationMs: 18.9,
    failureCategory: "extraction_failed",
  }, (message, facts) => calls.push([message, facts]));

  assert.deepEqual(calls, [[
    "File representation processing outcome.",
    {
      event: "file_representation_processed",
      outcome: "metadata_only",
      mediaType: "application/pdf",
      durationMs: 18,
      failureCategory: "extraction_failed",
    },
  ]]);
  const rendered = JSON.stringify(calls);
  assert.doesNotMatch(rendered, /filename|content|diagnostic/u);
});
