import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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

test("CommonJS consumers resolve the bridge and preserve the extraction contract", async () => {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@kestrel-agents/files");
  assert.match(packagePath, /dist\/index\.cjs$/u);
  const commonJs = require("@kestrel-agents/files") as typeof import("../src/index.js");
  const mediaTypes = [
    "application/pdf",
    "application/json",
    "application/yaml",
    "application/x-yaml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/zip",
    "audio/mpeg",
    "text/csv",
    "text/html",
    "text/markdown",
    "text/plain",
    "text/x-enterprise-format",
    "text/yaml",
  ];
  for (const mediaType of mediaTypes) {
    assert.equal(
      commonJs.isAttachmentTextExtractable(mediaType),
      isAttachmentTextExtractable(mediaType),
      `CommonJS media contract drifted for ${mediaType}`,
    );
  }
  const sentinel = "commonjs-attachment-bridge-sentinel";
  const extracted = await commonJs.extractAttachmentTextIsolated({
    buffer: Buffer.from(sentinel),
    filename: "sentinel.md",
    mediaType: "text/markdown",
  });
  assert.equal(extracted.text, sentinel);
});

test("isolated extraction resolves the package-owned worker entry", async () => {
  const extracted = await extractAttachmentTextIsolated({
    buffer: Buffer.from("package worker sentinel", "utf8"),
    filename: "sentinel.md",
    mediaType: "text/markdown",
  });
  assert.equal(extracted.text, "package worker sentinel");
});

test("does not initialize the PDF runtime while importing the attachment package", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import .* from ["']pdf-parse["'];$/mu);
  assert.match(source, /import\(["']pdf-parse["']\)/u);
  assert.match(source, /import\(["']pdf-parse\/worker["']\)/u);
  assert.match(source, /await import\(["']@napi-rs\/canvas["']\)/u);
});

test("pins one compatible PDF parser and PDF.js runtime", async () => {
  const [attachmentManifest, webManifest, pdfParseManifest] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../../apps/web/package.json", import.meta.url), "utf8"),
    readFile(new URL("../node_modules/pdf-parse/package.json", import.meta.url), "utf8"),
  ]).then((values) => values.map((value) => JSON.parse(value) as {
    dependencies?: Record<string, string>;
  }));
  assert.equal(attachmentManifest.dependencies?.["pdf-parse"], "2.4.5");
  assert.equal(webManifest.dependencies?.["pdf-parse"], "2.4.5");
  assert.equal(attachmentManifest.dependencies?.["pdfjs-dist"], "5.4.296");
  assert.equal(webManifest.dependencies?.["pdfjs-dist"], "5.4.296");
  assert.equal(pdfParseManifest.dependencies?.["pdfjs-dist"], "5.4.296");
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

test("extracts predefined CMap text and omits generated page markers", async () => {
  const extracted = await extractAttachmentText({
    buffer: await readFile(new URL("./fixtures/issue3521.pdf", import.meta.url)),
    filename: "issue3521.pdf",
    mediaType: "application/pdf",
  });
  assert.match(extracted.text, /我们都是黑体字/u);
  assert.doesNotMatch(extracted.text, /-- \d+ of \d+ --/u);
});

test("returns genuinely empty text for a blank PDF", async () => {
  const matrix = await import("../scripts/extraction-matrix.mjs") as {
    createBlankPdf(): Buffer;
  };
  const extracted = await extractAttachmentText({
    buffer: matrix.createBlankPdf(),
    filename: "blank.pdf",
    mediaType: "application/pdf",
  });
  assert.equal(extracted.text, "");
  assert.deepEqual(extracted.warnings, []);
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

test("password-protected PDFs fail extraction without indexing content", async () => {
  await assert.rejects(extractAttachmentText({
    buffer: await readFile(new URL("./fixtures/password-123456.pdf", import.meta.url)),
    filename: "encrypted.pdf",
    mediaType: "application/pdf",
  }), /No password given/u);
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
