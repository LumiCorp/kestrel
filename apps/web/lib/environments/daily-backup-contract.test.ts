import assert from "node:assert/strict";
import { contractTest } from "../../../../tests/helpers/contract-test.js";
import {
  DAILY_BACKUP_MAX_ATTEMPTS,
  DAILY_BACKUP_RETRY_LIMIT,
  isDailyWorkspaceBackupIdempotencyKey,
  shouldPreserveTerminalDailyBackup,
  workspaceDailyBackupDayStart,
  workspaceDailyBackupIdempotencyKey,
} from "./daily-backup-contract";

contractTest(
  "web.hermetic",
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

contractTest(
  "web.hermetic",
  "daily Workspace backups have five total queue attempts",
  () => {
    assert.equal(DAILY_BACKUP_MAX_ATTEMPTS, 5);
    assert.equal(DAILY_BACKUP_RETRY_LIMIT, 4);
    assert.equal(
      isDailyWorkspaceBackupIdempotencyKey(
        "workspace.backup.daily:workspace-1:2026-07-24",
      ),
      true,
    );
  },
);

contractTest(
  "web.hermetic",
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

contractTest(
  "web.hermetic",
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
