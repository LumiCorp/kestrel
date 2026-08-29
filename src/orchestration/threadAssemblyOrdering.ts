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
