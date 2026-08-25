import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const defaultFixtureRoot = resolve(scriptRoot, "../tests/fixtures");

function createPdf(objects) {
  const header = "%PDF-1.4\n";
  const chunks = [header];
  const offsets = [0];
  let offset = Buffer.byteLength(header);
  for (const [index, object] of objects.entries()) {
    offsets.push(offset);
    const rendered = `${index + 1} 0 obj\n${object}\nendobj\n`;
    chunks.push(rendered);
    offset += Buffer.byteLength(rendered);
  }
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((entry) => `${String(entry).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(xref);
  return Buffer.from(chunks.join(""), "binary");
}

export function createBlankPdf() {
  return createPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ]);
}

export function createStandardFontPdf(sentinel = "KESTREL_STANDARD_FONT_SENTINEL_92AF") {
  const content = `BT /F1 12 Tf 20 100 Td (${sentinel}) Tj ET`;
  return createPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

async function loadAttachmentModule(entryPath) {
  if (entryPath.endsWith(".cjs")) return createRequire(import.meta.url)(entryPath);
  return await import(pathToFileURL(entryPath).href);
}

export async function runExtractionMatrix(input = {}) {
  const fixtureRoot = resolve(input.fixtureRoot ?? defaultFixtureRoot);
  const entryPath = resolve(input.entryPath ?? resolve(scriptRoot, "../dist/index.js"));
  const files = await loadAttachmentModule(entryPath);
  const successCases = [
    ["plain", Buffer.from("plain sentinel"), "plain.txt", "text/plain", "plain sentinel"],
    ["markdown", Buffer.from("# markdown sentinel"), "sentinel.md", "text/markdown", "markdown sentinel"],
    ["html", Buffer.from("<p>html sentinel</p>"), "sentinel.html", "text/html", "html sentinel"],
    ["csv", Buffer.from("name,value\ncsv,sentinel"), "sentinel.csv", "text/csv", "csv,sentinel"],
    ["json", Buffer.from('{"json":"sentinel"}'), "sentinel.json", "application/json", '"json"'],
    ["yaml", Buffer.from("yaml: sentinel"), "sentinel.yaml", "application/yaml", "yaml: sentinel"],
    ["pdf", await readFile(resolve(fixtureRoot, "incident-playbook.pdf")), "incident-playbook.pdf", "application/pdf", "fixture-pdf-anchor-signal"],
    ["pdf-standard-font", createStandardFontPdf(), "standard-font.pdf", "application/pdf", "KESTREL_STANDARD_FONT_SENTINEL_92AF"],
    ["pdf-cmap", await readFile(resolve(fixtureRoot, "issue3521.pdf")), "issue3521.pdf", "application/pdf", "我们都是黑体字"],
    ["docx", await readFile(resolve(fixtureRoot, "executive-brief.docx")), "executive-brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "fixture-docx-anchor-lattice"],
    ["xlsx", await readFile(resolve(fixtureRoot, "quarterly-metrics.xlsx")), "quarterly-metrics.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "fixture-xlsx-anchor-quartz"],
    ["pptx", await readFile(resolve(fixtureRoot, "roadmap-deck.pptx")), "roadmap-deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "fixture-pptx-anchor-cosmos"],
  ];
  const outcomes = [];
  for (const [label, buffer, filename, mediaType, sentinel] of successCases) {
    const result = await files.extractAttachmentTextIsolated({ buffer, filename, mediaType });
    assert.match(result.text, new RegExp(sentinel, "u"), `${label} sentinel was not extracted`);
    outcomes.push({ label, outcome: "extracted_text" });
  }
  const blank = await files.extractAttachmentTextIsolated({
    buffer: createBlankPdf(),
    filename: "blank.pdf",
    mediaType: "application/pdf",
  });
  assert.equal(blank.text, "");
  assert.deepEqual(blank.warnings, []);
  outcomes.push({ label: "pdf-blank", outcome: "empty_extraction" });

  await assert.rejects(files.extractAttachmentTextIsolated({
    buffer: Buffer.from("%PDF- malformed"),
    filename: "malformed.pdf",
    mediaType: "application/pdf",
  }));
  outcomes.push({ label: "pdf-malformed", outcome: "extraction_failed" });

  await assert.rejects(files.extractAttachmentTextIsolated({
    buffer: await readFile(resolve(fixtureRoot, "password-123456.pdf")),
    filename: "encrypted.pdf",
    mediaType: "application/pdf",
  }), /No password given/u);
  outcomes.push({ label: "pdf-encrypted", outcome: "extraction_failed" });

  await assert.rejects(files.extractAttachmentTextIsolated({
    buffer: Buffer.from("PK malformed Office archive"),
    filename: "malformed.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
  outcomes.push({ label: "office-malformed", outcome: "extraction_failed" });

  const JSZip = createRequire(entryPath)("jszip");
  const unsafeArchive = new JSZip();
  unsafeArchive.file("word/document.xml", "A".repeat(1024 * 1024));
  await assert.rejects(files.extractAttachmentTextIsolated({
    buffer: await unsafeArchive.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    }),
    filename: "unsafe.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }), /compression ratio exceeds the extraction limit/u);
  outcomes.push({ label: "office-unsafe-archive", outcome: "archive_rejected" });

  assert.equal(files.isAttachmentTextExtractable("image/png"), false);
  await assert.rejects(files.extractAttachmentTextIsolated({
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"),
    filename: "pixel.png",
    mediaType: "image/png",
  }), /No attachment text extractor is registered/u);
  outcomes.push({ label: "native-image", outcome: "native_image_route" });

  await assert.rejects(files.extractAttachmentTextIsolated({
    buffer: Buffer.from([0, 1, 2, 3]),
    filename: "opaque.bin",
    mediaType: "application/octet-stream",
  }), /No attachment text extractor is registered/u);
  outcomes.push({ label: "opaque", outcome: "unsupported_media_type" });

  await assert.rejects(files.extractAttachmentTextIsolated({
    buffer: Buffer.from("timeout sentinel"),
    filename: "timeout.txt",
    mediaType: "text/plain",
    timeoutMs: 0,
  }), /timed out/u);
  outcomes.push({ label: "timeout", outcome: "extraction_failed" });
  return outcomes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcomes = await runExtractionMatrix({
    ...(process.argv[2] ? { entryPath: process.argv[2] } : {}),
    ...(process.argv[3] ? { fixtureRoot: process.argv[3] } : {}),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, outcomes })}\n`);
}
