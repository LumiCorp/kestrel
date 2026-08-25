import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBlankPdf } from "../../../packages/attachments/scripts/extraction-matrix.mjs";
import { extractKnowledgeDocument } from "../lib/knowledge/documents/extract.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = resolve(repositoryRoot, "packages/attachments/tests/fixtures");
const BOUNDED_FAILURE_TIMEOUT_MS = 10_000;

async function assertBoundedFailure(promise, expectedMessage) {
  let timeout;
  try {
    await assert.rejects(Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Knowledge PDF failure exceeded its bound.")), BOUNDED_FAILURE_TIMEOUT_MS);
      }),
    ]), (error) => {
      assert.notEqual(error?.message, "Knowledge PDF failure exceeded its bound.");
      if (expectedMessage) assert.match(error?.message ?? "", expectedMessage);
      return true;
    });
  } finally {
    clearTimeout(timeout);
  }
}

const ordinary = await extractKnowledgeDocument({
  buffer: await readFile(resolve(fixtureRoot, "incident-playbook.pdf")),
  filename: "ordinary.pdf",
  mediaType: "application/pdf",
});
assert.equal(ordinary.pageCount, 1);
assert.match(ordinary.blocks.map((block) => block.text).join("\n"), /fixture-pdf-anchor-signal/u);

const cmap = await extractKnowledgeDocument({
  buffer: await readFile(resolve(fixtureRoot, "issue3521.pdf")),
  filename: "cmap.pdf",
  mediaType: "application/pdf",
});
assert.equal(cmap.pageCount, 1);
assert.match(cmap.blocks.map((block) => block.text).join("\n"), /我们都是黑体字/u);
assert.doesNotMatch(cmap.blocks.map((block) => block.text).join("\n"), /-- \d+ of \d+ --/u);

const blank = await extractKnowledgeDocument({
  buffer: createBlankPdf(),
  filename: "blank.pdf",
  mediaType: "application/pdf",
});
assert.equal(blank.pageCount, 1);
assert.deepEqual(blank.blocks, []);
assert.deepEqual(blank.warnings, ["pdf_text_empty"]);

await assertBoundedFailure(extractKnowledgeDocument({
  buffer: Buffer.from("%PDF- malformed"),
  filename: "malformed.pdf",
  mediaType: "application/pdf",
}));
await assertBoundedFailure(extractKnowledgeDocument({
  buffer: await readFile(resolve(fixtureRoot, "password-123456.pdf")),
  filename: "encrypted.pdf",
  mediaType: "application/pdf",
}), /No password given/u);

process.stdout.write(`${JSON.stringify({
  ok: true,
  outcomes: [
    { label: "pdf-ordinary", outcome: "blocks" },
    { label: "pdf-cmap", outcome: "unicode_blocks" },
    { label: "pdf-blank", outcome: "partial_no_blocks" },
    { label: "pdf-malformed", outcome: "bounded_failure" },
    { label: "pdf-encrypted", outcome: "bounded_failure" },
  ],
})}\n`);
