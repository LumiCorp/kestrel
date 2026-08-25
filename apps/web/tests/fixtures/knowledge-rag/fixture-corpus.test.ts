import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { read, utils } from "xlsx";
import { chunkKnowledgeDocument } from "../../../lib/knowledge/documents/chunk";
import { extractKnowledgeDocument } from "../../../lib/knowledge/documents/extract";


const fixtureRoot = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "knowledge-rag"
);
const attachmentFixtureRoot = path.resolve(
  process.cwd(),
  "../../packages/attachments/tests/fixtures",
);

type FixtureManifest = {
  corpusVersion: number;
  fixtures: Array<{
    filename: string;
    mediaType: string;
    query: string;
    anchor: string;
    notes: string;
  }>;
};

async function readManifest() {
  const raw = await readFile(path.join(fixtureRoot, "manifest.json"), "utf8");
  return JSON.parse(raw) as FixtureManifest;
}

test("knowledge rag fixture corpus is present", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.corpusVersion, 1);
  assert.equal(manifest.fixtures.length, 9);
});

test("fixture corpus files are parsable and contain their anchors", async () => {
  const manifest = await readManifest();

  for (const fixture of manifest.fixtures) {
    const buffer = await readFile(path.join(fixtureRoot, fixture.filename));

    switch (fixture.mediaType) {
      case "text/markdown":
      case "application/yaml":
      case "text/html":
      case "text/csv":
      case "application/json": {
        const text = buffer.toString("utf8");
        assert.match(text, new RegExp(fixture.anchor));
        break;
      }
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
        const result = await mammoth.extractRawText({ buffer });
        assert.match(result.value, new RegExp(fixture.anchor));
        break;
      }
      case "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
        const zip = await JSZip.loadAsync(buffer);
        const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
        assert.ok(xml);
        assert.match(xml, new RegExp(fixture.anchor));
        break;
      }
      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
        const workbook = read(buffer, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0] as string];
        const rows = utils.sheet_to_json<(string | number | null)[]>(sheet, {
          header: 1,
          blankrows: false,
          raw: false,
        });
        assert.ok(
          rows.some((row) =>
            row.some((cell) => String(cell ?? "").includes(fixture.anchor))
          )
        );
        break;
      }
      case "application/pdf": {
        const parser = new PDFParse({ data: buffer });
        const parsed = await parser.getText();
        await parser.destroy().catch(() => {});
        assert.match(parsed.text ?? "", new RegExp(fixture.anchor));
        break;
      }
      default:
        throw new Error(`Unhandled fixture media type: ${fixture.mediaType}`);
    }
  }
});

test("Knowledge extraction produces searchable HTML and PPTX chunks", async () => {
  const manifest = await readManifest();
  const fixtures = manifest.fixtures.filter((fixture) =>
    [
      "text/html",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ].includes(fixture.mediaType),
  );
  assert.equal(fixtures.length, 2);

  for (const fixture of fixtures) {
    const extracted = await extractKnowledgeDocument({
      buffer: await readFile(path.join(fixtureRoot, fixture.filename)),
      filename: fixture.filename,
      mediaType: fixture.mediaType,
    });
    const chunks = chunkKnowledgeDocument(extracted.blocks);
    assert.ok(chunks.length > 0);
    assert.match(
      chunks.map((chunk) => chunk.content).join("\n"),
      new RegExp(fixture.anchor),
    );
  }
});

test("Knowledge PDF extraction supports predefined CMaps without indexing page markers", async () => {
  const extracted = await extractKnowledgeDocument({
    buffer: await readFile(path.join(attachmentFixtureRoot, "issue3521.pdf")),
    filename: "issue3521.pdf",
    mediaType: "application/pdf",
  });
  assert.equal(extracted.pageCount, 1);
  assert.deepEqual(extracted.warnings, ["pdf_text_sparse"]);
  assert.match(extracted.blocks.map((block) => block.text).join("\n"), /我们都是黑体字/u);
  assert.doesNotMatch(extracted.blocks.map((block) => block.text).join("\n"), /-- \d+ of \d+ --/u);
});

test("Knowledge PDF extraction reports an empty document without marker chunks", async () => {
  const matrix = await import("../../../../../packages/attachments/scripts/extraction-matrix.mjs") as {
    createBlankPdf(): Buffer;
  };
  const extracted = await extractKnowledgeDocument({
    buffer: matrix.createBlankPdf(),
    filename: "blank.pdf",
    mediaType: "application/pdf",
  });
  assert.equal(extracted.pageCount, 1);
  assert.deepEqual(extracted.blocks, []);
  assert.deepEqual(extracted.warnings, ["pdf_text_empty"]);
});

test("Knowledge PDF extraction fails closed for malformed and encrypted input", async () => {
  await assert.rejects(extractKnowledgeDocument({
    buffer: Buffer.from("%PDF- malformed"),
    filename: "malformed.pdf",
    mediaType: "application/pdf",
  }));
  await assert.rejects(extractKnowledgeDocument({
    buffer: await readFile(path.join(attachmentFixtureRoot, "password-123456.pdf")),
    filename: "encrypted.pdf",
    mediaType: "application/pdf",
  }), /No password given/u);
});
