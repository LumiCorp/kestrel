import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function readAppSource(relativePath: string) {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

test("Project uploads compensate new documents when context attachment fails", () => {
  const source = readAppSource("app/api/projects/[id]/files/route.ts");

  assert.match(source, /catch \(attachmentError\)/);
  assert.match(
    source,
    /if \(!uploaded\.deduped\)[\s\S]*removeKnowledgeDocument\([\s\S]*throw attachmentError/
  );
});

test("Project deletion commits metadata before best-effort blob cleanup", () => {
  const source = readAppSource("lib/projects/store.ts");
  const transactionIndex = source.indexOf(
    "const deleted = await knowledgeDb.transaction"
  );
  const cleanupIndex = source.indexOf("cleanupProjectBlobKeys(");

  assert.ok(transactionIndex >= 0);
  assert.ok(cleanupIndex > transactionIndex);
  assert.match(
    source.slice(transactionIndex, cleanupIndex),
    /if \(!deleted\.project\)[\s\S]*try \{[\s\S]*getStorageAdapter\(\)/
  );
});

test("Project collaborators use canonical Thread access for message actions", () => {
  for (const relativePath of [
    "app/api/messages/[id]/feedback/route.ts",
    "lib/messages/speech.ts",
  ]) {
    const source = readAppSource(relativePath);
    assert.match(source, /getThreadAccessForUser\(/);
    assert.doesNotMatch(source, /createdByUserId/);
  }
});

test("Thread response setup is awaited inside the Project grant cleanup scope", () => {
  const source = readAppSource("app/api/threads/[id]/route.ts");
  assert.match(source, /return await createKestrelOneAgentResponse\(/);
});
