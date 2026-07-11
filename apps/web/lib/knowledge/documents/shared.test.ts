import assert from "node:assert/strict";
import test from "node:test";
import {
  isInlineRenderableMediaType,
  isKnowledgeDocumentMediaTypeSupported,
  normalizeMediaType,
} from "./shared";

test("normalizeMediaType recognizes the expanded document matrix", () => {
  assert.equal(normalizeMediaType("", "notes.yaml"), "application/yaml");
  assert.equal(normalizeMediaType("", "index.html"), "text/html");
  assert.equal(
    normalizeMediaType("", "slides.pptx"),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
  assert.equal(
    normalizeMediaType("", "sheet.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
});

test("knowledge document support and inline rendering match the intended formats", () => {
  assert.equal(
    isKnowledgeDocumentMediaTypeSupported("application/yaml", "notes.yaml"),
    true
  );
  assert.equal(
    isKnowledgeDocumentMediaTypeSupported("text/html", "index.html"),
    true
  );
  assert.equal(
    isKnowledgeDocumentMediaTypeSupported(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "brief.docx"
    ),
    true
  );
  assert.equal(
    isKnowledgeDocumentMediaTypeSupported("application/zip", "archive.zip"),
    false
  );

  assert.equal(isInlineRenderableMediaType("text/html"), true);
  assert.equal(isInlineRenderableMediaType("application/yaml"), true);
  assert.equal(
    isInlineRenderableMediaType(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ),
    false
  );
});
