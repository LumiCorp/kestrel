import type { ThreadRecord } from "../kestrel/contracts/orchestration.js";

import type { PendingSteerRecord } from "./contracts.js";

const OPERATOR_CONTROL_KEY = "operatorControl";
const PENDING_STEERS_KEY = "pendingSteers";

export function listPendingSteers(thread: ThreadRecord): PendingSteerRecord[] {
  const operatorControl = asRecord(thread.metadata?.[OPERATOR_CONTROL_KEY]);
  const pending = operatorControl?.[PENDING_STEERS_KEY];
  if (Array.isArray(pending) === false) {
    return [];
  }
  return pending.flatMap((entry) => normalizePendingSteer(entry));
}

export function enqueuePendingSteer(
  thread: ThreadRecord,
  pendingSteer: PendingSteerRecord,
): ThreadRecord {
  const existing = listPendingSteers(thread);
  return withPendingSteers(thread, [...existing, pendingSteer]);
}

export function removePendingSteer(
  thread: ThreadRecord,
  steerId: string,
): ThreadRecord {
  return withPendingSteers(
    thread,
    listPendingSteers(thread).filter((entry) => entry.steerId !== steerId),
  );
}

function withPendingSteers(
  thread: ThreadRecord,
  pendingSteers: PendingSteerRecord[],
): ThreadRecord {
  const metadata = { ...(thread.metadata ?? {}) };
  const operatorControl = { ...(asRecord(metadata[OPERATOR_CONTROL_KEY]) ?? {}) };
  if (pendingSteers.length === 0) {
    delete operatorControl[PENDING_STEERS_KEY];
  } else {
    operatorControl[PENDING_STEERS_KEY] = pendingSteers.map((entry) => ({
      steerId: entry.steerId,
      message: entry.message,
      ...(entry.attachments !== undefined ? { attachments: entry.attachments } : {}),
      ...(entry.issuedBy !== undefined ? { issuedBy: entry.issuedBy } : {}),
      createdAt: entry.createdAt,
    }));
  }
  if (Object.keys(operatorControl).length === 0) {
    delete metadata[OPERATOR_CONTROL_KEY];
  } else {
    metadata[OPERATOR_CONTROL_KEY] = operatorControl;
  }
  return {
    ...thread,
    metadata: metadata,
    updatedAt: new Date().toISOString(),
  };
}

function normalizePendingSteer(value: unknown): PendingSteerRecord[] {
  const record = asRecord(value);
  const steerId = typeof record?.steerId === "string" ? record.steerId.trim() : "";
  const message = typeof record?.message === "string" ? record.message.trim() : "";
  const createdAt = typeof record?.createdAt === "string" ? record.createdAt : "";
  const attachments = Array.isArray(record?.attachments)
    ? record.attachments as PendingSteerRecord["attachments"]
    : undefined;
  if (steerId.length === 0 || message.length === 0 || createdAt.length === 0) {
    return [];
  }
  return [
    {
      steerId,
      message,
      ...(attachments !== undefined ? { attachments } : {}),
      ...(typeof record?.issuedBy === "string" && record.issuedBy.length > 0
        ? { issuedBy: record.issuedBy }
        : {}),
      createdAt,
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
