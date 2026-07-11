import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bootHtmlPath = path.join(testDir, "..", "static", "boot.html");

test("boot screen exposes Reset Runtime Store only for sqlite init failures", async () => {
  const source = await readFile(bootHtmlPath, "utf8");

  assert.match(source, /id="reset-store"/u);
  assert.match(source, /id="copy-help-packet"/u);
  assert.match(source, /class="brand-logo"/u);
  assert.match(source, /kestrel-full-horz-dark-mode\.png/u);
  assert.match(source, /Readiness checklist/u);
  assert.match(source, /id="checklist"/u);
  assert.match(source, /renderChecklist/u);
  assert.match(source, /renderTimeline/u);
  assert.match(source, /resetStore\.hidden = state\.code !== "STORE_SQLITE_INIT_FAILED";/u);
  assert.match(source, /desktopBridge\.resetRuntimeStore\(\)/u);
  assert.match(source, /desktopBridge\.getSupportBundle\(\)/u);
  assert.doesNotMatch(source, /id="check-resources"/u);
});
