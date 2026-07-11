import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import nextConfig from "../../next.config";

test("knowledge queue status does not eagerly load worker runtimes", async () => {
  const [
    queueSource,
    documentRuntimeSource,
    processRuntimeSource,
    pageDataSource,
    documentsRouteSource,
  ] = await Promise.all([
    readFile(new URL("./queue.ts", import.meta.url), "utf8"),
    readFile(new URL("./documents/runtime.ts", import.meta.url), "utf8"),
    readFile(
      new URL("./documents/process-runtime.ts", import.meta.url),
      "utf8"
    ),
    readFile(new URL("./page-data.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../app/api/knowledge/documents/route.ts", import.meta.url),
      "utf8"
    ),
  ]);

  assert.doesNotMatch(
    queueSource,
    /^import .*knowledge\/(?:documents\/runtime|sync-runtime)/mu
  );
  assert.match(queueSource, /await import\([\s\S]*documents\/process-runtime/u);
  assert.doesNotMatch(queueSource, /documents\/runtime["']/u);
  assert.match(queueSource, /await import\([\s\S]*sync-runtime/u);
  assert.doesNotMatch(documentRuntimeSource, /documents\/process-runtime/u);
  assert.doesNotMatch(documentRuntimeSource, /from ["']\.\/extract["']/u);
  assert.match(processRuntimeSource, /from ["']\.\/extract["']/u);
  assert.match(pageDataSource, /knowledge\/queue-state/u);
  assert.doesNotMatch(pageDataSource, /knowledge\/queue["']/u);
  assert.match(documentsRouteSource, /knowledge\/queue-state/u);
  assert.doesNotMatch(documentsRouteSource, /knowledge\/queue["']/u);
});

test("document ingestion traces the canvas JavaScript and native runtime", () => {
  const apiIncludes =
    nextConfig.outputFileTracingIncludes?.["/api/knowledge/documents/**"];
  const pageIncludes = nextConfig.outputFileTracingIncludes?.["/knowledge"];

  assert.ok(apiIncludes);
  assert.deepEqual(pageIncludes, apiIncludes);
  assert.equal(
    apiIncludes.some((pattern) => pattern.includes("@napi-rs/canvas/**/*")),
    true
  );
  assert.equal(
    apiIncludes.some((pattern) => pattern.includes("@napi-rs/canvas-*/**/*")),
    true
  );
});
