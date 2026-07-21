import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "personal workspace provisioning serializes concurrent first-session writes", async () => {
  const source = await readFile(
    new URL("./personal-workspace.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /knowledgeDb\.transaction\(async \(transaction\)/u);
  assert.match(source, /pg_advisory_xact_lock\(hashtextextended/u);
  assert.match(source, /kestrel:personal-workspace:/u);
  assert.match(source, /transaction\s*\.insert\(schema\.organizations\)/u);
  assert.match(source, /transaction\s*\.insert\(schema\.members\)/u);
});
