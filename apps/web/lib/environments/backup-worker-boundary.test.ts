import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest(
  "web.hermetic",
  "daily backup retries remain attached to one durable Environment operation",
  async () => {
    const [backupSource, queueSource, reconcileSource] = await Promise.all([
      readFile(new URL("./backups.ts", import.meta.url), "utf8"),
      readFile(new URL("../knowledge/queue.ts", import.meta.url), "utf8"),
      readFile(new URL("./reconcile.ts", import.meta.url), "utf8"),
    ]);

    assert.match(queueSource, /id:\s*operationId/u);
    assert.match(queueSource, /singletonKey:\s*operationId/u);
    assert.match(queueSource, /retryCount:\s*job\.retryCount/u);
    assert.match(queueSource, /retryLimit:\s*job\.retryLimit/u);
    assert.match(queueSource, /job\.state === "failed"/u);
    assert.match(queueSource, /failExhaustedWorkspaceBackup/u);
    assert.match(backupSource, /workspace\.backup\.retrying/u);
    assert.match(backupSource, /input\.attempt\?\.canRetry === true/u);
    assert.match(reconcileSource, /workspaceDailyBackupIdempotencyKey/u);
    assert.match(reconcileSource, /gte\(table\.createdAt,\s*dayStart\)/u);
  },
);

contractTest(
  "web.hermetic",
  "backup worker invariant failures cross a terminal platform-visible boundary",
  async () => {
    const backupSource = await readFile(
      new URL("./backups.ts", import.meta.url),
      "utf8",
    );

    assert.match(backupSource, /WORKSPACE_BACKUP_RECORD_MISSING/u);
    assert.match(backupSource, /WORKSPACE_BACKUP_ACTOR_MISSING/u);
    assert.match(backupSource, /WORKSPACE_BACKUP_RETRIES_EXHAUSTED/u);
    assert.match(backupSource, /failWorkspaceBackupWorkerBoundary/u);
  },
);
