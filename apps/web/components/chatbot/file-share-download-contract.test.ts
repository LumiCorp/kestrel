import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "message.tsx"),
  "utf8",
);

test("file-share artifacts render a dedicated Download card", () => {
  assert.match(source, /function FileShareDownloadCard/u);
  assert.match(source, /part\.data\.kind === "file-share"/u);
  assert.match(source, /data-testid="file-share-download-card"/u);
  assert.match(source, /download=\{title\}/u);
  assert.match(source, /metadata\.sizeBytes/u);
  assert.match(source, /metadata\.fileCount/u);
  assert.match(source, /metadata\.expiresAt/u);
  assert.match(source, /Anyone with this link can download/u);
});
