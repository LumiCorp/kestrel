import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test(
  "daily backup retries remain attached to one durable Environment operation",
  async () => {
    const [backupSource, queueSource, reconcileSource, processSource] =
      await Promise.all([
      readFile(new URL("./backups.ts", import.meta.url), "utf8"),
      readFile(new URL("../knowledge/queue.ts", import.meta.url), "utf8"),
      readFile(new URL("./reconcile.ts", import.meta.url), "utf8"),
      readFile(new URL("./process-runtime.ts", import.meta.url), "utf8"),
    ]);

    assert.doesNotMatch(queueSource, /id:\s*operationId/u);
    assert.match(queueSource, /data:\s*\{ operationId \}/u);
    assert.match(queueSource, /singletonKey:\s*operationId/u);
    assert.match(queueSource, /retryCount:\s*job\.retryCount/u);
    assert.match(queueSource, /retryLimit:\s*job\.retryLimit/u);
    assert.match(queueSource, /job\.state === "failed"/u);
    assert.match(queueSource, /failExhaustedWorkspaceBackup/u);
    assert.match(queueSource, /deferEnvironmentOperation/u);
    assert.match(queueSource, /startAfter/u);
    assert.doesNotMatch(
      processSource,
      /Environment operation is waiting for a prerequisite/u,
    );
    assert.match(processSource, /return provisioner\.process\(operationId\)/u);
    assert.match(backupSource, /workspace\.backup\.retrying/u);
    assert.doesNotMatch(
      backupSource,
      /workspace\.backup\.waiting_for_execution/u,
    );
    assert.doesNotMatch(backupSource, /threadTurnQueueState\.activeTurnId/u);
    assert.match(backupSource, /isDeterministicBackupFailure\(code\)/u);
    assert.match(backupSource, /input\.attempt\?\.canRetry === true/u);
    assert.match(reconcileSource, /workspaceDailyBackupIdempotencyKey/u);
    assert.match(reconcileSource, /gte\(table\.createdAt,\s*dayStart\)/u);
    assert.match(
      reconcileSource,
      /environmentRunExecutions\.findMany/u,
    );
    assert.match(
      reconcileSource,
      /eq\(table\.type, "workspace\.backup"\)[\s\S]*inArray\(table\.status, \["queued", "running"\]\)[\s\S]*if \(activeBackup\) continue/u,
    );
    assert.match(
      backupSource,
      /const exportReplacementId = crypto\.randomUUID\(\)/u,
    );
  },
);

test(
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
