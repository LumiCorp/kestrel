import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { read, utils } from "xlsx";
import { contractTest } from "../../../../../tests/helpers/contract-test.js";


const fixtureRoot = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "knowledge-rag"
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

contractTest("web.hermetic", "knowledge rag fixture corpus is present", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.corpusVersion, 1);
  assert.equal(manifest.fixtures.length, 9);
});

contractTest("web.hermetic", "fixture corpus files are parsable and contain their anchors", async () => {
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
