import assert from "node:assert/strict";
import test from "node:test";
import {
  selectWorkspaceBackupRetention,
  type WorkspaceBackupProtection,
} from "./backup-retention";

const now = new Date("2026-08-05T12:00:00.000Z");
const later = new Date("2026-09-04T12:00:00.000Z");

function protections(
  count: number,
  kind: WorkspaceBackupProtection["kind"],
): WorkspaceBackupProtection[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${kind}-${index}`,
    backupId: `backup-${index}`,
    kind,
    expiresAt: later,
  }));
}

test("retention keeps the seven newest unique automatic revisions", () => {
  const selected = selectWorkspaceBackupRetention({
    protectionsNewestFirst: protections(9, "daily"),
    currentBackupId: "backup-0",
    now,
    supersedeAutomatic: true,
  });

  assert.deepEqual(selected.expiredProtectionIds, ["daily-7", "daily-8"]);
  assert.deepEqual(
    selected.supersededAutomaticProtectionIds,
    protections(6, "daily")
      .slice(1)
      .map((protection) => protection.id)
      .concat("daily-6"),
  );
});

test("retention keeps the ten newest unique manual checkpoints", () => {
  const selected = selectWorkspaceBackupRetention({
    protectionsNewestFirst: protections(12, "checkpoint"),
    currentBackupId: "backup-0",
    now,
    supersedeAutomatic: true,
  });

  assert.deepEqual(selected.expiredProtectionIds, [
    "checkpoint-10",
    "checkpoint-11",
  ]);
  assert.deepEqual(selected.supersededAutomaticProtectionIds, []);
});

test("shared artifacts retain the longest active protection", () => {
  const selected = selectWorkspaceBackupRetention({
    protectionsNewestFirst: [
      {
        id: "checkpoint",
        backupId: "shared",
        kind: "checkpoint",
        expiresAt: later,
      },
      {
        id: "daily",
        backupId: "shared",
        kind: "daily",
        expiresAt: new Date("2026-08-19T12:00:00.000Z"),
      },
    ],
    currentBackupId: "shared",
    now,
    supersedeAutomatic: true,
  });

  assert.equal(selected.retainedUntil.toISOString(), later.toISOString());
  assert.deepEqual(selected.expiredProtectionIds, []);
});

test("renewing an old checkpoint makes its revision newest", () => {
  const newestFirst = protections(11, "checkpoint");
  newestFirst.unshift({
    id: "renewed",
    backupId: "backup-10",
    kind: "checkpoint",
    expiresAt: later,
  });
  const selected = selectWorkspaceBackupRetention({
    protectionsNewestFirst: newestFirst,
    currentBackupId: "backup-10",
    now,
    supersedeAutomatic: true,
  });

  assert.deepEqual(selected.expiredProtectionIds, ["checkpoint-9"]);
  assert.equal(selected.retainedUntil.toISOString(), later.toISOString());
});

test("an unchanged renewal does not extend superseded automatic revisions", () => {
  const selected = selectWorkspaceBackupRetention({
    protectionsNewestFirst: protections(3, "daily"),
    currentBackupId: "backup-0",
    now,
    supersedeAutomatic: false,
  });

  assert.deepEqual(selected.supersededAutomaticProtectionIds, []);
});
