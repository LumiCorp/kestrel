import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import {
  extractAttachmentText,
  isAttachmentTextExtractable,
} from "../src/index.js";

test("extracts bounded UTF-8 text and reports truncation", async () => {
  const extracted = await extractAttachmentText({
    buffer: Buffer.from("alpha beta gamma", "utf8"),
    filename: "notes.txt",
    mediaType: "text/plain",
    maxTextBytes: 10,
  });
  assert.equal(extracted.text, "alpha beta");
  assert.equal(extracted.truncated, true);
});

test("extracts visible HTML text without returning markup", async () => {
  const extracted = await extractAttachmentText({
    buffer: Buffer.from("<h1>Hello</h1><p>world</p>", "utf8"),
    filename: "page.html",
    mediaType: "text/html",
  });
  assert.equal(extracted.text, "Hello world");
});

test("malformed UTF-8 fails extraction so callers can degrade to metadata-only", async () => {
  await assert.rejects(extractAttachmentText({
    buffer: Buffer.from([0xff, 0xfe]),
    filename: "broken.txt",
    mediaType: "text/plain",
  }));
});

test("processor registry distinguishes supported documents from opaque binaries", () => {
  assert.equal(isAttachmentTextExtractable("application/pdf"), true);
  assert.equal(isAttachmentTextExtractable("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), true);
  assert.equal(isAttachmentTextExtractable("application/zip"), false);
  assert.equal(isAttachmentTextExtractable("audio/mpeg"), false);
});

test("rejects Office archives with unsafe expansion ratios before document parsing", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "0".repeat(1024 * 1024));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  await assert.rejects(extractAttachmentText({
    buffer,
    filename: "bomb.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }), /compression ratio exceeds/u);
});
