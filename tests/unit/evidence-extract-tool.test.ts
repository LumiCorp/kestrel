import test from "node:test";
import assert from "node:assert/strict";

import { evidenceExtractTool } from "../../tools/research/evidenceExtract.js";

test("evidence.extract returns ranked snippets for claim overlap", async () => {
  const handler = evidenceExtractTool.createHandler({});

  const result = (await handler({
    claim: "Seattle mornings are often cool and wet",
    sourceId: "src-1",
    text:
      "Seattle mornings are often cool and can be damp during much of the year. " +
      "Afternoons may warm up and dry out depending on the season. " +
      "Always check local weather alerts before running.",
    maxItems: 2,
  })) as {
    items: Array<{ id: string; text: string; evidenceStrength: number }>;
  };

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.id.startsWith("src-1:evidence:"), true);
  assert.equal((result.items[0]?.evidenceStrength ?? 0) >= (result.items[1]?.evidenceStrength ?? 0), true);
});

