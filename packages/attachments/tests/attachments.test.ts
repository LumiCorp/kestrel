import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";

import {
  extractAttachmentText,
  extractAttachmentTextIsolated,
  isAttachmentTextExtractable,
} from "../src/index.js";

test("isolated extraction does not inherit Vercel runtime execArgv", () => {
  const packageUrl = new URL("../dist/index.js", import.meta.url).href;
  const script = [
    `import { extractAttachmentTextIsolated } from ${JSON.stringify(packageUrl)};`,
    "const result = await extractAttachmentTextIsolated({",
    "  buffer: Buffer.from('worker flag sentinel', 'utf8'),",
    "  filename: 'sentinel.txt',",
    "  mediaType: 'text/plain',",
    "});",
    "if (result.text !== 'worker flag sentinel') throw new Error('Unexpected extraction result.');",
  ].join("\n");
  const child = spawnSync(process.execPath, [
    "--expose-gc",
    "--max-semi-space-size=34",
    "--max-old-space-size=1844",
    "--input-type=module",
    "--eval",
    script,
  ], { encoding: "utf8", timeout: 15_000 });

  assert.equal(child.status, 0, [child.stdout, child.stderr].filter(Boolean).join("\n"));
});

test("does not initialize the PDF runtime while importing the attachment package", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import .* from ["']pdf-parse["'];$/mu);
  assert.match(source, /await import\(["']pdf-parse["']\)/u);
  assert.match(source, /await import\(["']@napi-rs\/canvas["']\)/u);
});

test("isolated extraction enforces its timeout", async () => {
  await assert.rejects(extractAttachmentTextIsolated({
    buffer: Buffer.from("timeout sentinel", "utf8"),
    filename: "sentinel.txt",
    mediaType: "text/plain",
    timeoutMs: 0,
  }), /timed out/u);
});

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

test("extracts common UTF-8 enterprise text formats", async () => {
  const fixtures = [
    ["brief.md", "text/markdown", "# Markdown sentinel"],
    ["metrics.csv", "text/csv", "metric,value\nlatency,42"],
    ["config.json", "application/json", '{"sentinel":"quartz"}'],
    ["config.yaml", "application/yaml", "sentinel: quartz"],
  ] as const;
  for (const [filename, mediaType, content] of fixtures) {
    const extracted = await extractAttachmentText({
      buffer: Buffer.from(content, "utf8"),
      filename,
      mediaType,
    });
    assert.equal(extracted.text, content);
    assert.equal(extracted.truncated, false);
  }
});

test("loads the native PDF runtime only for PDF extraction", async () => {
  const extracted = await extractAttachmentText({
    buffer: await readFile(new URL("../../../apps/web/tests/fixtures/knowledge-rag/incident-playbook.pdf", import.meta.url)),
    filename: "incident-playbook.pdf",
    mediaType: "application/pdf",
  });
  assert.match(extracted.text, /fixture-pdf-anchor-signal/u);
  assert.equal(extracted.truncated, false);
});

test("extracts common Office document formats", async () => {
  const fixtures = [
    {
      filename: "executive-brief.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      expected: /fixture-docx-anchor-lattice/u,
    },
    {
      filename: "quarterly-metrics.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      expected: /fixture-xlsx-anchor-quartz/u,
    },
    {
      filename: "roadmap-deck.pptx",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      expected: /fixture-pptx-anchor-cosmos/u,
    },
  ];
  for (const fixture of fixtures) {
    const extracted = await extractAttachmentText({
      buffer: await readFile(new URL(`../../../apps/web/tests/fixtures/knowledge-rag/${fixture.filename}`, import.meta.url)),
      filename: fixture.filename,
      mediaType: fixture.mediaType,
    });
    assert.match(extracted.text, fixture.expected);
  }
});

test("malformed UTF-8 fails extraction so callers can degrade to metadata-only", async () => {
  await assert.rejects(extractAttachmentText({
    buffer: Buffer.from([0xff, 0xfe]),
    filename: "broken.txt",
    mediaType: "text/plain",
  }));
});

test("malformed documents and unsupported binaries fail closed", async () => {
  await assert.rejects(extractAttachmentText({
    buffer: Buffer.from("%PDF- malformed", "utf8"),
    filename: "malformed.pdf",
    mediaType: "application/pdf",
  }));
  await assert.rejects(extractAttachmentText({
    buffer: Buffer.from([0, 1, 2, 3]),
    filename: "opaque.bin",
    mediaType: "application/octet-stream",
  }), /No attachment text extractor is registered/u);
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
