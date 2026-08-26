import assert from "node:assert/strict";
import test from "node:test";
import { buildWordDocumentBytes } from "../../tools/kestrelOne/wordDocument.js";

test("Word document export produces a valid stored DOCX package", async () => {
  const bytes = await buildWordDocumentBytes("Summary", "First paragraph\nSecond paragraph");
  assert.equal(bytes.subarray(0, 4).toString("hex"), "504b0304");
  assert.ok(bytes.includes(Buffer.from("word/document.xml", "utf8")));
  assert.ok(bytes.includes(Buffer.from("First paragraph", "utf8")));
  assert.ok(bytes.includes(Buffer.from("Second paragraph", "utf8")));
});
