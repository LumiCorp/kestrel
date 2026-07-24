const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const DAILY_BACKUP_MAX_ATTEMPTS = 5;
export const DAILY_BACKUP_RETRY_LIMIT = DAILY_BACKUP_MAX_ATTEMPTS - 1;

export function workspaceDailyBackupDay(now: Date) {
  const day = now.toISOString().slice(0, 10);
  if (!UTC_DAY_PATTERN.test(day)) {
    throw new Error("Workspace daily backup day could not be resolved.");
  }
  return day;
}

export function workspaceDailyBackupDayStart(now: Date) {
  return new Date(`${workspaceDailyBackupDay(now)}T00:00:00.000Z`);
}

export function workspaceDailyBackupIdempotencyKey(
  workspaceId: string,
  now: Date,
) {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new Error("Workspace ID is required for a daily backup.");
  }
  return `workspace.backup.daily:${normalizedWorkspaceId}:${workspaceDailyBackupDay(now)}`;
}

export function isDailyWorkspaceBackupIdempotencyKey(value: string) {
  return value.startsWith("workspace.backup.daily:");
}

export function shouldPreserveTerminalDailyBackup(input: {
  reason: string;
  operationStatus: string;
}) {
  return input.reason === "daily" && input.operationStatus === "failed";
}
