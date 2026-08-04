import {
  parseBudgetAllocationV1,
  parseBudgetAmountsV1,
  parseBudgetLedgerEntryV1,
  parseBudgetReservationV1,
  type BudgetAllocationV1,
  type BudgetAmountsV1,
  type BudgetLedgerEntryV1,
  type BudgetReservationV1,
} from "../kestrel/contracts/budget.js";

export interface BudgetAllocationStateV1 {
  allocation: BudgetAllocationV1;
  reserved: BudgetAmountsV1;
  committed: BudgetAmountsV1;
  openChildAllocationIds: string[];
}

export interface BudgetIdempotencyRecordV1 {
  operation: "openAllocation" | "reserve" | "commit" | "release" | "closeAllocation";
  requestDigest: string;
  result: unknown;
}

export interface BudgetRepositoryStateV1 {
  version: 1;
  nextSequence: number;
  allocations: Record<string, BudgetAllocationStateV1>;
  reservations: Record<string, BudgetReservationV1>;
  ledger: BudgetLedgerEntryV1[];
  idempotency: Record<string, BudgetIdempotencyRecordV1>;
}

export interface BudgetRepositoryTransactionResult<T> {
  state: BudgetRepositoryStateV1;
  result: T;
}

export interface BudgetRepositoryV1 {
  transaction<T>(
    operation: (
      state: BudgetRepositoryStateV1,
    ) => Promise<BudgetRepositoryTransactionResult<T>> | BudgetRepositoryTransactionResult<T>,
  ): Promise<T>;
  read(): Promise<BudgetRepositoryStateV1>;
}

export function createEmptyBudgetRepositoryState(): BudgetRepositoryStateV1 {
  return {
    version: 1,
    nextSequence: 1,
    allocations: {},
    reservations: {},
    ledger: [],
    idempotency: {},
  };
}

export function parseBudgetRepositoryState(value: unknown): BudgetRepositoryStateV1 {
  const root = requireRecord(value, "Budget repository state");
  rejectUnknownFields(root, [
    "version", "nextSequence", "allocations", "reservations", "ledger", "idempotency",
  ], "Budget repository state");
  if (root.version !== 1) throw new Error("Budget repository state version must be 1.");
  const allocationsRaw = requireRecord(root.allocations, "Budget repository allocations");
  const allocations: Record<string, BudgetAllocationStateV1> = {};
  for (const [allocationId, value] of Object.entries(allocationsRaw)) {
    const record = requireRecord(value, `Budget repository allocation '${allocationId}'`);
    rejectUnknownFields(record, ["allocation", "reserved", "committed", "openChildAllocationIds"], `Budget repository allocation '${allocationId}'`);
    const allocation = parseBudgetAllocationV1(record.allocation);
    if (allocation.allocationId !== allocationId) throw new Error("Budget repository allocation key does not match its contract identity.");
    allocations[allocationId] = {
      allocation,
      reserved: parseBudgetAmountsV1(record.reserved, `Budget repository allocation '${allocationId}' reserved`),
      committed: parseBudgetAmountsV1(record.committed, `Budget repository allocation '${allocationId}' committed`),
      openChildAllocationIds: parseStringArray(record.openChildAllocationIds, `Budget repository allocation '${allocationId}' children`),
    };
  }
  const reservationsRaw = requireRecord(root.reservations, "Budget repository reservations");
  const reservations: Record<string, BudgetReservationV1> = {};
  for (const [reservationId, value] of Object.entries(reservationsRaw)) {
    const reservation = parseBudgetReservationV1(value);
    if (reservation.reservationId !== reservationId) throw new Error("Budget repository reservation key does not match its contract identity.");
    reservations[reservationId] = reservation;
  }
  const ledger = requireArray(root.ledger, "Budget repository ledger").map(parseBudgetLedgerEntryV1);
  for (let index = 0; index < ledger.length; index += 1) {
    if (ledger[index]!.sequence !== index + 1) throw new Error("Budget repository ledger sequence is not contiguous.");
  }
  const nextSequence = requirePositiveInteger(root.nextSequence, "Budget repository nextSequence");
  if (nextSequence !== ledger.length + 1) throw new Error("Budget repository nextSequence does not follow its ledger.");
  const idempotencyRaw = requireRecord(root.idempotency, "Budget repository idempotency records");
  const idempotency: Record<string, BudgetIdempotencyRecordV1> = {};
  for (const [key, value] of Object.entries(idempotencyRaw)) {
    const record = requireRecord(value, `Budget idempotency '${key}'`);
    rejectUnknownFields(record, ["operation", "requestDigest", "result"], `Budget idempotency '${key}'`);
    if (
      record.operation !== "openAllocation" && record.operation !== "reserve" &&
      record.operation !== "commit" && record.operation !== "release" &&
      record.operation !== "closeAllocation"
    ) throw new Error(`Budget idempotency '${key}' operation is invalid.`);
    if (typeof record.requestDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.requestDigest)) {
      throw new Error(`Budget idempotency '${key}' requestDigest is invalid.`);
    }
    idempotency[key] = { operation: record.operation, requestDigest: record.requestDigest, result: structuredClone(record.result) };
  }
  return { version: 1, nextSequence, allocations, reservations, ledger, idempotency };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`${label} contains unknown field '${unknown}'.`);
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function parseStringArray(value: unknown, label: string): string[] {
  const result = requireArray(value, label).map((item) => {
    if (typeof item !== "string" || item.length === 0) throw new Error(`${label} contains an invalid identity.`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate identities.`);
  return result;
}
