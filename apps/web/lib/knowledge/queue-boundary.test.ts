import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import nextConfig from "../../next.config";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "knowledge queue status does not eagerly load worker runtimes", async () => {
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
    /^import .*knowledge\/documents\/runtime/mu
  );
  assert.match(queueSource, /await import\([\s\S]*documents\/process-runtime/u);
  assert.doesNotMatch(queueSource, /documents\/runtime["']/u);
  assert.doesNotMatch(queueSource, /sync-runtime/u);
  assert.match(queueSource, /ENVIRONMENT_OPERATION_EXPIRE_SECONDS = 12 \* 60 \* 60/u);
  assert.match(queueSource, /ENVIRONMENT_OPERATION_HEARTBEAT_SECONDS = 60/u);
  assert.match(queueSource, /heartbeatRefreshSeconds:\s*ENVIRONMENT_OPERATION_HEARTBEAT_REFRESH_SECONDS/u);
  assert.match(queueSource, /export async function startEnvironmentLifecycleWorker/u);
  assert.match(queueSource, /export async function reconcileEnvironmentOperationQueue/u);
  assert.match(queueSource, /await reconcileTerminalWorkspaceBackupRecords\(\)/u);
  assert.match(queueSource, /isParentOwnedWorkspaceBackup\(operation\.input\)/u);
  assert.match(
    queueSource,
    /export async function enqueueEnvironmentOperation[\s\S]*getKnowledgeBossProducer\(\)/u,
  );
  assert.doesNotMatch(documentRuntimeSource, /documents\/process-runtime/u);
  assert.doesNotMatch(documentRuntimeSource, /from ["']\.\/extract["']/u);
  assert.match(processRuntimeSource, /from ["']\.\/extract["']/u);
  assert.doesNotMatch(pageDataSource, /knowledge\/queue-state/u);
  assert.doesNotMatch(pageDataSource, /knowledge\/queue["']/u);
  assert.doesNotMatch(documentsRouteSource, /knowledge\/queue-state/u);
  assert.doesNotMatch(documentsRouteSource, /knowledge\/queue["']/u);
});

contractTest("web.hermetic", "document ingestion traces the canvas JavaScript and native runtime", () => {
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
