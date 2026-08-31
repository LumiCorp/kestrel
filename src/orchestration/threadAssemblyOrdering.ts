import type { ThreadAssemblyRecord } from "../kestrel/contracts/orchestration.js";

/**
 * Durable total order for thread assembly history. The unique persisted record
 * id breaks equal-timestamp ties without relying on database return order.
 */
export function compareThreadAssemblyRecordsNewestFirst(
  left: ThreadAssemblyRecord,
  right: ThreadAssemblyRecord,
): number {
  const timestampOrder = right.createdAt.localeCompare(left.createdAt);
  return timestampOrder !== 0
    ? timestampOrder
    : right.recordId.localeCompare(left.recordId);
}

export function selectLatestThreadAssemblyRecord(
  records: ThreadAssemblyRecord[],
): ThreadAssemblyRecord | undefined {
  return [...records].sort(compareThreadAssemblyRecordsNewestFirst)[0];
}

export function orderThreadAssemblyRecordAfter(
  record: ThreadAssemblyRecord,
  previous: ThreadAssemblyRecord | undefined,
): ThreadAssemblyRecord {
  if (previous === undefined) {
    return record;
  }
  const proposedMillis = Date.parse(record.createdAt);
  const previousMillis = Date.parse(previous.createdAt);
  if (Number.isFinite(proposedMillis) === false || Number.isFinite(previousMillis) === false) {
    throw new Error("Thread assembly timestamps must be valid ISO-8601 timestamps.");
  }
  return {
    ...record,
    createdAt: new Date(Math.max(proposedMillis, previousMillis + 1)).toISOString(),
  };
}
