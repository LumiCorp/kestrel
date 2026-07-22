import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "message.tsx"),
  "utf8",
);

contractTest("web.hermetic", "console artifacts render as closed disclosures with retained output", () => {
  assert.match(source, /function ConsoleArtifactDisclosure/u);
  assert.match(source, /<details className="group">/u);
  assert.doesNotMatch(source, /<details[^>]+open/u);
  assert.match(source, /metadata\.stdout/u);
  assert.match(source, /metadata\.stderr/u);
  assert.match(source, /exit \$\{exitCode/u);
  assert.match(source, /part\.data\.kind === "console"/u);
  assert.match(source, /metadata=\{part\.data\.metadata\}/u);
});
