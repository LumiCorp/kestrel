import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "apps/preview-lifecycle.ts"), "utf8");
const resolver = source.slice(
  source.indexOf("export async function resolveActiveHostedPreviewSelector"),
  source.indexOf("async function publishPreview"),
);

test("hosted preview selectors resolve only active owned Fly leases", () => {
  assert.match(source, /resolveActiveHostedPreviewSelector/u);
  assert.match(source, /equals\(table\.id, input\.previewId\)/u);
  assert.match(source, /equals\(table\.organizationId, input\.organizationId\)/u);
  assert.match(source, /equals\(table\.environmentId, input\.environmentId\)/u);
  assert.match(source, /equals\(table\.projectId, input\.projectId\)/u);
  assert.match(source, /equals\(table\.targetProvider, "fly"\)/u);
  assert.match(source, /equals\(table\.status, "active"\)/u);
  assert.match(source, /gt\(table\.expiresAt/u);
  assert.doesNotMatch(resolver, /input\.hostname|input\.port/u);
});
