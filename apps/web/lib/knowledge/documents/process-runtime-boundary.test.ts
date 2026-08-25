import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("missing Knowledge documents terminalize their ingestion run without retry", async () => {
  const source = await readFile(
    new URL("./process-runtime.ts", import.meta.url),
    "utf8",
  );
  const missingDocumentBranch = source.match(
    /if \(!document\) \{[\s\S]*?\n  \}/u,
  )?.[0];

  assert.ok(missingDocumentBranch);
  assert.match(missingDocumentBranch, /updateKnowledgeIngestionRun/u);
  assert.match(missingDocumentBranch, /status: "failed"/u);
  assert.match(missingDocumentBranch, /finishedAt: new Date\(\)/u);
  assert.doesNotMatch(missingDocumentBranch, /throw new Error/u);
});
