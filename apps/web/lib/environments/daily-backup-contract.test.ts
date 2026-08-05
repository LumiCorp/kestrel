import test from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_BACKUP_MAX_ATTEMPTS,
  DAILY_BACKUP_RETRY_LIMIT,
  isDailyWorkspaceBackupIdempotencyKey,
  shouldPreserveTerminalDailyBackup,
  workspaceDailyBackupDayStart,
  workspaceDailyBackupIdempotencyKey,
  workspaceBackupRetryDelaySeconds,
} from "./daily-backup-contract";

test(
  "daily Workspace backups have one deterministic operation identity per UTC day",
  () => {
    const morning = new Date("2026-07-24T00:00:01.000Z");
    const evening = new Date("2026-07-24T23:59:59.999Z");

    assert.equal(
      workspaceDailyBackupIdempotencyKey("workspace-1", morning),
      "workspace.backup.daily:workspace-1:2026-07-24",
    );
    assert.equal(
      workspaceDailyBackupIdempotencyKey("workspace-1", evening),
      workspaceDailyBackupIdempotencyKey("workspace-1", morning),
    );
    assert.equal(
      workspaceDailyBackupDayStart(evening).toISOString(),
      "2026-07-24T00:00:00.000Z",
    );
  },
);

test("Workspace backup transient retries use the bounded fixed schedule", () => {
  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) =>
      workspaceBackupRetryDelaySeconds(index + 1),
    ),
    [30, 120, 300, 300, 300],
  );
});

test(
  "daily Workspace backups retry transient failures three times",
  () => {
    assert.equal(DAILY_BACKUP_MAX_ATTEMPTS, 4);
    assert.equal(DAILY_BACKUP_RETRY_LIMIT, 3);
    assert.equal(
      isDailyWorkspaceBackupIdempotencyKey(
        "workspace.backup.daily:workspace-1:2026-07-24",
      ),
      true,
    );
  },
);

test(
  "a failed daily backup remains the one terminal operation for its Workspace day",
  () => {
    assert.equal(
      shouldPreserveTerminalDailyBackup({
        reason: "daily",
        operationStatus: "failed",
      }),
      true,
    );
    assert.equal(
      shouldPreserveTerminalDailyBackup({
        reason: "checkpoint",
        operationStatus: "failed",
      }),
      false,
    );
  },
);

test(
  "daily Workspace backup identity changes at the UTC day boundary",
  () => {
    assert.notEqual(
      workspaceDailyBackupIdempotencyKey(
        "workspace-1",
        new Date("2026-07-24T23:59:59.999Z"),
      ),
      workspaceDailyBackupIdempotencyKey(
        "workspace-1",
        new Date("2026-07-25T00:00:00.000Z"),
      ),
    );
  },
);
