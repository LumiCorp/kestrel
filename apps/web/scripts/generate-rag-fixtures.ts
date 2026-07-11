import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { utils, write } from "xlsx";

type FixtureDefinition = {
  filename: string;
  mediaType: string;
  query: string;
  anchor: string;
  notes: string;
  buffer: Buffer;
};

const FIXTURE_ROOT = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "knowledge-rag"
);

function escapePdfText(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdfBuffer(text: string) {
  const content = `BT\n/F1 18 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += object;
  }

  const startXref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n`;
  pdf += `startxref\n${startXref}\n%%EOF`;

  return Buffer.from(pdf, "utf8");
}

async function buildDocxBuffer(text: string) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.folder("_rels")?.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.folder("word")?.file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

async function buildPptxBuffer(text: string) {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>${text}</a:t></p:sld>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function buildXlsxBuffer(rows: string[][]) {
  const workbook = utils.book_new();
  const sheet = utils.aoa_to_sheet(rows);
  utils.book_append_sheet(workbook, sheet, "Metrics");
  return Buffer.from(
    write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer
  );
}

async function buildFixtures() {
  const fixtures: FixtureDefinition[] = [
    {
      filename: "knowledge-runbook.md",
      mediaType: "text/markdown",
      query: "What is the markdown anchor for the knowledge runbook?",
      anchor: "fixture-markdown-anchor-helix",
      notes: "Markdown runbook for deterministic text retrieval.",
      buffer: Buffer.from(
        "# Knowledge Runbook\n\nAnchor: fixture-markdown-anchor-helix\nEscalation window: Tuesdays at 14:00 UTC.\n",
        "utf8"
      ),
    },
    {
      filename: "operations-config.yaml",
      mediaType: "application/yaml",
      query: "Which YAML anchor appears in the operations config?",
      anchor: "fixture-yaml-anchor-aurora",
      notes: "YAML config to cover plain-text structured extraction.",
      buffer: Buffer.from(
        "service: knowledge-rag\nanchor: fixture-yaml-anchor-aurora\nsla_minutes: 45\n",
        "utf8"
      ),
    },
    {
      filename: "release-checklist.html",
      mediaType: "text/html",
      query: "What HTML anchor appears in the release checklist?",
      anchor: "fixture-html-anchor-orbit",
      notes: "HTML content to verify markup stripping.",
      buffer: Buffer.from(
        [
          "<html>",
          "  <body>",
          "    <h1>Release Checklist</h1>",
          "    <p>",
          "      Anchor: <strong>fixture-html-anchor-orbit</strong>",
          "    </p>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
        "utf8"
      ),
    },
    {
      filename: "service-metrics.csv",
      mediaType: "text/csv",
      query: "What CSV anchor appears in the service metrics file?",
      anchor: "fixture-csv-anchor-vector",
      notes: "CSV fixture for tabular text extraction.",
      buffer: Buffer.from(
        "metric,value,anchor\nlatency_ms,182,fixture-csv-anchor-vector\n",
        "utf8"
      ),
    },
    {
      filename: "routing-config.json",
      mediaType: "application/json",
      query: "What JSON anchor appears in the routing config?",
      anchor: "fixture-json-anchor-hybrid",
      notes: "JSON fixture for structured retrieval.",
      buffer: Buffer.from(
        JSON.stringify(
          {
            feature: "hybrid-rag",
            anchor: "fixture-json-anchor-hybrid",
            defaultRoute: "documents-first",
          },
          null,
          2
        ) + "\n",
        "utf8"
      ),
    },
    {
      filename: "quarterly-metrics.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      query: "What XLSX anchor appears in the quarterly metrics workbook?",
      anchor: "fixture-xlsx-anchor-quartz",
      notes: "Real XLSX workbook fixture.",
      buffer: buildXlsxBuffer([
        ["quarter", "anchor", "value"],
        ["Q1", "fixture-xlsx-anchor-quartz", "91"],
      ]),
    },
    {
      filename: "executive-brief.docx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      query: "What DOCX anchor appears in the executive brief?",
      anchor: "fixture-docx-anchor-lattice",
      notes: "Minimal valid DOCX file generated with JSZip.",
      buffer: await buildDocxBuffer(
        "Executive brief anchor: fixture-docx-anchor-lattice"
      ),
    },
    {
      filename: "roadmap-deck.pptx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      query: "What PPTX anchor appears in the roadmap deck?",
      anchor: "fixture-pptx-anchor-cosmos",
      notes: "Minimal PPTX archive that matches the current parser.",
      buffer: await buildPptxBuffer("fixture-pptx-anchor-cosmos"),
    },
    {
      filename: "incident-playbook.pdf",
      mediaType: "application/pdf",
      query: "What PDF anchor appears in the incident playbook?",
      anchor: "fixture-pdf-anchor-signal",
      notes: "Simple single-page PDF fixture with embedded text.",
      buffer: buildPdfBuffer("Incident playbook anchor fixture-pdf-anchor-signal"),
    },
  ];

  return fixtures;
}

async function main() {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const fixtures = await buildFixtures();

  for (const fixture of fixtures) {
    await writeFile(path.join(FIXTURE_ROOT, fixture.filename), fixture.buffer);
  }

  await writeFile(
    path.join(FIXTURE_ROOT, "manifest.json"),
    JSON.stringify(
      {
        corpusVersion: 1,
        fixtures: fixtures.map(({ buffer: _buffer, ...fixture }) => fixture),
      },
      null,
      2
    ) + "\n"
  );

  await writeFile(
    path.join(FIXTURE_ROOT, "README.md"),
    [
      "# Knowledge RAG Fixtures",
      "",
      "Generated by `pnpm exec tsx scripts/generate-rag-fixtures.ts`.",
      "",
      "These files are checked into the repo so the RAG test suite can run without downloading documents at runtime.",
      "",
      "- `manifest.json` describes the fixture anchors and query expectations.",
      "",
    ].join("\n")
  );

  console.log(`Generated ${fixtures.length} fixtures in ${FIXTURE_ROOT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
