import { createHash } from "node:crypto";

export const BUDGET_POLICY_VERSION = "budget_policy_v1" as const;
export const BUDGET_SCOPE_VERSION = "budget_scope_v1" as const;
export const BUDGET_ALLOCATION_VERSION = "budget_allocation_v1" as const;
export const BUDGET_RESERVATION_VERSION = "budget_reservation_v1" as const;
export const BUDGET_USAGE_VERSION = "budget_usage_v1" as const;
export const BUDGET_LEDGER_ENTRY_VERSION = "budget_ledger_entry_v1" as const;
export const BUDGET_SNAPSHOT_VERSION = "budget_snapshot_v2" as const;

export const BUDGET_RESOURCE_KEYS = Object.freeze([
  "wallClockMs",
  "steps",
  "modelCalls",
  "toolCalls",
  "evaluatorCalls",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "embeddingTokens",
  "modelCostMicroUsd",
  "toolCostMicroUsd",
  "sandboxCpuMs",
  "sandboxMemoryMbMs",
  "sandboxStorageByteMs",
  "concurrencySlots",
] as const);

export type BudgetResourceKeyV1 = typeof BUDGET_RESOURCE_KEYS[number];
export type BudgetAmountsV1 = Partial<Record<BudgetResourceKeyV1, number>>;
export type BudgetScopeKindV1 =
  | "tenant"
  | "run"
  | "agent"
  | "subagent"
  | "model"
  | "tool"
  | "sandbox"
  | "evaluator"
  | "embedding";

export interface BudgetScopeSegmentV1 {
  kind: BudgetScopeKindV1;
  id: string;
}

export interface BudgetScopeV1 {
  version: typeof BUDGET_SCOPE_VERSION;
  segments: BudgetScopeSegmentV1[];
}

export interface BudgetPolicyAllocationV1 {
  allocationKey: string;
  parentAllocationKey?: string | undefined;
  scope: BudgetScopeV1;
  limits: BudgetAmountsV1;
}

export interface BudgetPolicyV1 {
  version: typeof BUDGET_POLICY_VERSION;
  policyId: string;
  revision: string;
  allocations: BudgetPolicyAllocationV1[];
}

export interface BudgetAllocationV1 {
  version: typeof BUDGET_ALLOCATION_VERSION;
  allocationId: string;
  allocationKey: string;
  policyId: string;
  policyRevision: string;
  scope: BudgetScopeV1;
  parentAllocationId?: string | undefined;
  limits: BudgetAmountsV1;
  reservedFromParent: BudgetAmountsV1;
  status: "open" | "closed";
  revision: number;
  openedAt: string;
  closedAt?: string | undefined;
}

export interface BudgetReservationV1 {
  version: typeof BUDGET_RESERVATION_VERSION;
  reservationId: string;
  allocationId: string;
  policyRevision: string;
  scope: BudgetScopeV1;
  requested: BudgetAmountsV1;
  committed: BudgetAmountsV1;
  remaining: BudgetAmountsV1;
  status: "open" | "committed" | "released";
  revision: number;
  createdAt: string;
  settledAt?: string | undefined;
}

export type BudgetUnknownCostResourceV1 =
  | "modelCostMicroUsd"
  | "toolCostMicroUsd";

export interface BudgetUsageV1 {
  version: typeof BUDGET_USAGE_VERSION;
  usageId: string;
  allocationId: string;
  reservationId: string;
  policyRevision: string;
  amounts: BudgetAmountsV1;
  unknownCosts: Array<{
    resource: BudgetUnknownCostResourceV1;
    reason: "price_unavailable";
  }>;
  measuredAt: string;
}

export type BudgetLedgerOperationV1 =
  | "allocation.opened"
  | "allocation.closed"
  | "child.reserved"
  | "child.committed"
  | "reservation.opened"
  | "reservation.committed"
  | "reservation.released";

export interface BudgetLedgerEntryV1 {
  version: typeof BUDGET_LEDGER_ENTRY_VERSION;
  entryId: string;
  sequence: number;
  allocationId: string;
  relatedAllocationId?: string | undefined;
  reservationId?: string | undefined;
  operation: BudgetLedgerOperationV1;
  idempotencyKey: string;
  policyRevision: string;
  allocationRevision: number;
  amounts: BudgetAmountsV1;
  recordedAt: string;
}

export interface BudgetSnapshotV2 {
  version: typeof BUDGET_SNAPSHOT_VERSION;
  allocation: BudgetAllocationV1;
  reserved: BudgetAmountsV1;
  committed: BudgetAmountsV1;
  available: BudgetAmountsV1;
  openReservationIds: string[];
  openChildAllocationIds: string[];
  ledgerSequence: number;
}

export interface BudgetReservationRequestV1 {
  allocationId: string;
  allocationRevision: number;
  policyRevision: string;
  reservationId: string;
  scope: BudgetScopeV1;
  amounts: BudgetAmountsV1;
  idempotencyKey: string;
  createdAt?: string | undefined;
}

export type BudgetReservationResultV1 =
  | { status: "reserved"; reservation: BudgetReservationV1; snapshot: BudgetSnapshotV2 }
  | { status: "denied"; reasonCode: "BUDGET_EXHAUSTED"; snapshot: BudgetSnapshotV2 };

export interface BudgetReservationPortV1 {
  reserve(input: BudgetReservationRequestV1): Promise<BudgetReservationResultV1>;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const ISO_TIMESTAMP_WITH_TIMEZONE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const RESOURCE_KEY_SET = new Set<string>(BUDGET_RESOURCE_KEYS);
const LEAF_SCOPE_KINDS = new Set<BudgetScopeKindV1>([
  "model",
  "tool",
  "sandbox",
  "evaluator",
  "embedding",
]);

export function createBudgetPolicyV1(
  input: Omit<BudgetPolicyV1, "version" | "revision">,
): BudgetPolicyV1 {
  const draft: BudgetPolicyV1 = {
    version: BUDGET_POLICY_VERSION,
    policyId: input.policyId,
    revision: emptyHash(),
    allocations: structuredClone(input.allocations),
  };
  draft.revision = fingerprintBudgetPolicyV1(draft);
  return parseBudgetPolicyV1(draft);
}

export function parseBudgetPolicyV1(value: unknown): BudgetPolicyV1 {
  const record = requireRecord(value, "Budget policy");
  rejectUnknownFields(record, ["version", "policyId", "revision", "allocations"], "Budget policy");
  requireVersion(record.version, BUDGET_POLICY_VERSION, "Budget policy");
  const allocationsRaw = requireArray(record.allocations, "Budget policy allocations");
  if (allocationsRaw.length === 0) throw new Error("Budget policy allocations must not be empty.");
  const allocations = allocationsRaw.map((item, index) =>
    parsePolicyAllocation(item, `Budget policy allocations[${index}]`));
  const byKey = new Map<string, BudgetPolicyAllocationV1>();
  for (const allocation of allocations) {
    if (byKey.has(allocation.allocationKey)) {
      throw new Error(`Budget policy allocation key '${allocation.allocationKey}' is duplicated.`);
    }
    if (allocation.parentAllocationKey === undefined) {
      if (allocation.scope.segments.length !== 1) {
        throw new Error(`Root budget allocation '${allocation.allocationKey}' must have tenant scope.`);
      }
    } else {
      const parent = byKey.get(allocation.parentAllocationKey);
      if (parent === undefined) {
        throw new Error(`Budget allocation '${allocation.allocationKey}' must follow its exact parent in authored order.`);
      }
      requireImmediateChildScope(parent.scope, allocation.scope, `Budget allocation '${allocation.allocationKey}'`);
      requireNarrowedLimits(parent.limits, allocation.limits, `Budget allocation '${allocation.allocationKey}'`);
    }
    byKey.set(allocation.allocationKey, allocation);
  }
  const policy: BudgetPolicyV1 = {
    version: BUDGET_POLICY_VERSION,
    policyId: requireIdentifier(record.policyId, "Budget policy policyId"),
    revision: requireHash(record.revision, "Budget policy revision"),
    allocations,
  };
  if (fingerprintBudgetPolicyV1(policy) !== policy.revision) {
    throw new Error("Budget policy revision does not match its canonical payload.");
  }
  return policy;
}

export function fingerprintBudgetPolicyV1(policy: BudgetPolicyV1): string {
  return digestBudgetCanonicalValue({
    version: policy.version,
    policyId: policy.policyId,
    allocations: policy.allocations,
  });
}

export function digestBudgetCanonicalValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalBudgetJson(value)).digest("hex")}`;
}

export function canonicalBudgetJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

export function parseBudgetTimestampV1(value: unknown, label = "Budget timestamp"): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp with an explicit timezone.`);
  const match = ISO_TIMESTAMP_WITH_TIMEZONE_PATTERN.exec(value);
  if (match === null) throw new Error(`${label} must be an ISO timestamp with an explicit timezone.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`${label} must be an ISO timestamp with an explicit timezone.`);
  }
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, milliseconds);
  if (
    local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day || local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== milliseconds
  ) throw new Error(`${label} must be an ISO timestamp with an explicit timezone.`);
  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMs = offsetSign * ((offsetHour * 60) + offsetMinute) * 60_000;
  return new Date(local.getTime() - offsetMs).toISOString();
}

export function parseBudgetScopeV1(value: unknown): BudgetScopeV1 {
  const record = requireRecord(value, "Budget scope");
  rejectUnknownFields(record, ["version", "segments"], "Budget scope");
  requireVersion(record.version, BUDGET_SCOPE_VERSION, "Budget scope");
  const segments = requireArray(record.segments, "Budget scope segments").map((item, index) => {
    const segment = requireRecord(item, `Budget scope segments[${index}]`);
    rejectUnknownFields(segment, ["kind", "id"], `Budget scope segments[${index}]`);
    return {
      kind: requireScopeKind(segment.kind, `Budget scope segments[${index}] kind`),
      id: requireIdentifier(segment.id, `Budget scope segments[${index}] id`),
    };
  });
  if (segments.length === 0 || segments.length > 5) {
    throw new Error("Budget scope must contain between one and five exact lineage segments.");
  }
  const expectedPrefixes: BudgetScopeKindV1[] = ["tenant", "run", "agent", "subagent"];
  for (let index = 0; index < segments.length; index += 1) {
    const actual = segments[index]!.kind;
    const expected = expectedPrefixes[index];
    if (index < expectedPrefixes.length && actual !== expected) {
      throw new Error(`Budget scope segment ${index} must be '${expected}'.`);
    }
    if (index === 4 && !LEAF_SCOPE_KINDS.has(actual)) {
      throw new Error("Budget scope terminal segment must name model, tool, sandbox, evaluator, or embedding.");
    }
  }
  return { version: BUDGET_SCOPE_VERSION, segments };
}

export function parseBudgetAllocationV1(value: unknown): BudgetAllocationV1 {
  const record = requireRecord(value, "Budget allocation");
  rejectUnknownFields(record, [
    "version", "allocationId", "allocationKey", "policyId", "policyRevision", "scope",
    "parentAllocationId", "limits", "reservedFromParent", "status", "revision", "openedAt", "closedAt",
  ], "Budget allocation");
  requireVersion(record.version, BUDGET_ALLOCATION_VERSION, "Budget allocation");
  if (record.status !== "open" && record.status !== "closed") throw new Error("Budget allocation status is invalid.");
  const closedAt = record.closedAt === undefined ? undefined : requireTimestamp(record.closedAt, "Budget allocation closedAt");
  if ((record.status === "closed") !== (closedAt !== undefined)) {
    throw new Error("Closed budget allocations must carry closedAt and open allocations must not.");
  }
  return {
    version: BUDGET_ALLOCATION_VERSION,
    allocationId: requireIdentifier(record.allocationId, "Budget allocation allocationId"),
    allocationKey: requireIdentifier(record.allocationKey, "Budget allocation allocationKey"),
    policyId: requireIdentifier(record.policyId, "Budget allocation policyId"),
    policyRevision: requireHash(record.policyRevision, "Budget allocation policyRevision"),
    scope: parseBudgetScopeV1(record.scope),
    ...(record.parentAllocationId === undefined ? {} : {
      parentAllocationId: requireIdentifier(record.parentAllocationId, "Budget allocation parentAllocationId"),
    }),
    limits: parseBudgetAmountsV1(record.limits, "Budget allocation limits"),
    reservedFromParent: parseBudgetAmountsV1(record.reservedFromParent, "Budget allocation reservedFromParent"),
    status: record.status,
    revision: requireNonNegativeInteger(record.revision, "Budget allocation revision"),
    openedAt: requireTimestamp(record.openedAt, "Budget allocation openedAt"),
    ...(closedAt === undefined ? {} : { closedAt }),
  };
}

export function parseBudgetReservationV1(value: unknown): BudgetReservationV1 {
  const record = requireRecord(value, "Budget reservation");
  rejectUnknownFields(record, [
    "version", "reservationId", "allocationId", "policyRevision", "scope", "requested",
    "committed", "remaining", "status", "revision", "createdAt", "settledAt",
  ], "Budget reservation");
  requireVersion(record.version, BUDGET_RESERVATION_VERSION, "Budget reservation");
  if (record.status !== "open" && record.status !== "committed" && record.status !== "released") {
    throw new Error("Budget reservation status is invalid.");
  }
  const settledAt = record.settledAt === undefined ? undefined : requireTimestamp(record.settledAt, "Budget reservation settledAt");
  if ((record.status === "open") === (settledAt !== undefined)) {
    throw new Error("Settled budget reservations must carry settledAt and open reservations must not.");
  }
  return {
    version: BUDGET_RESERVATION_VERSION,
    reservationId: requireIdentifier(record.reservationId, "Budget reservation reservationId"),
    allocationId: requireIdentifier(record.allocationId, "Budget reservation allocationId"),
    policyRevision: requireHash(record.policyRevision, "Budget reservation policyRevision"),
    scope: parseBudgetScopeV1(record.scope),
    requested: parseBudgetAmountsV1(record.requested, "Budget reservation requested", true),
    committed: parseBudgetAmountsV1(record.committed, "Budget reservation committed"),
    remaining: parseBudgetAmountsV1(record.remaining, "Budget reservation remaining"),
    status: record.status,
    revision: requireNonNegativeInteger(record.revision, "Budget reservation revision"),
    createdAt: requireTimestamp(record.createdAt, "Budget reservation createdAt"),
    ...(settledAt === undefined ? {} : { settledAt }),
  };
}

export function parseBudgetUsageV1(value: unknown): BudgetUsageV1 {
  const record = requireRecord(value, "Budget usage");
  rejectUnknownFields(record, [
    "version", "usageId", "allocationId", "reservationId", "policyRevision", "amounts", "unknownCosts", "measuredAt",
  ], "Budget usage");
  requireVersion(record.version, BUDGET_USAGE_VERSION, "Budget usage");
  const amounts = parseBudgetAmountsV1(record.amounts, "Budget usage amounts");
  const unknownCosts = requireArray(record.unknownCosts, "Budget usage unknownCosts").map((item, index) => {
    const unknown = requireRecord(item, `Budget usage unknownCosts[${index}]`);
    rejectUnknownFields(unknown, ["resource", "reason"], `Budget usage unknownCosts[${index}]`);
    if (unknown.resource !== "modelCostMicroUsd" && unknown.resource !== "toolCostMicroUsd") {
      throw new Error("Budget usage unknown cost resource is invalid.");
    }
    const resource: BudgetUnknownCostResourceV1 = unknown.resource;
    if (unknown.reason !== "price_unavailable") throw new Error("Budget usage unknown cost reason is invalid.");
    if (amounts[resource] !== undefined) {
      throw new Error(`Budget usage cannot report both measured and unknown '${resource}'.`);
    }
    return { resource, reason: "price_unavailable" as const };
  });
  if (new Set(unknownCosts.map((item) => item.resource)).size !== unknownCosts.length) {
    throw new Error("Budget usage unknown cost resources must be unique.");
  }
  if (Object.keys(amounts).length === 0 && unknownCosts.length === 0) {
    throw new Error("Budget usage must contain measured amounts or an unknown cost.");
  }
  return {
    version: BUDGET_USAGE_VERSION,
    usageId: requireIdentifier(record.usageId, "Budget usage usageId"),
    allocationId: requireIdentifier(record.allocationId, "Budget usage allocationId"),
    reservationId: requireIdentifier(record.reservationId, "Budget usage reservationId"),
    policyRevision: requireHash(record.policyRevision, "Budget usage policyRevision"),
    amounts,
    unknownCosts,
    measuredAt: requireTimestamp(record.measuredAt, "Budget usage measuredAt"),
  };
}

export function parseBudgetLedgerEntryV1(value: unknown): BudgetLedgerEntryV1 {
  const record = requireRecord(value, "Budget ledger entry");
  rejectUnknownFields(record, [
    "version", "entryId", "sequence", "allocationId", "relatedAllocationId", "reservationId", "operation",
    "idempotencyKey", "policyRevision", "allocationRevision", "amounts", "recordedAt",
  ], "Budget ledger entry");
  requireVersion(record.version, BUDGET_LEDGER_ENTRY_VERSION, "Budget ledger entry");
  const operations = new Set<BudgetLedgerOperationV1>([
    "allocation.opened", "allocation.closed", "child.reserved", "child.committed",
    "reservation.opened", "reservation.committed", "reservation.released",
  ]);
  if (!operations.has(record.operation as BudgetLedgerOperationV1)) throw new Error("Budget ledger operation is invalid.");
  const entry: BudgetLedgerEntryV1 = {
    version: BUDGET_LEDGER_ENTRY_VERSION,
    entryId: requireHash(record.entryId, "Budget ledger entry entryId"),
    sequence: requirePositiveInteger(record.sequence, "Budget ledger entry sequence"),
    allocationId: requireIdentifier(record.allocationId, "Budget ledger entry allocationId"),
    ...(record.relatedAllocationId === undefined ? {} : {
      relatedAllocationId: requireIdentifier(record.relatedAllocationId, "Budget ledger entry relatedAllocationId"),
    }),
    ...(record.reservationId === undefined ? {} : {
      reservationId: requireIdentifier(record.reservationId, "Budget ledger entry reservationId"),
    }),
    operation: record.operation as BudgetLedgerOperationV1,
    idempotencyKey: requireIdentifier(record.idempotencyKey, "Budget ledger entry idempotencyKey"),
    policyRevision: requireHash(record.policyRevision, "Budget ledger entry policyRevision"),
    allocationRevision: requireNonNegativeInteger(record.allocationRevision, "Budget ledger entry allocationRevision"),
    amounts: parseBudgetAmountsV1(record.amounts, "Budget ledger entry amounts"),
    recordedAt: requireTimestamp(record.recordedAt, "Budget ledger entry recordedAt"),
  };
  if (fingerprintBudgetLedgerEntryV1(entry) !== entry.entryId) {
    throw new Error("Budget ledger entry entryId does not match its canonical payload.");
  }
  return entry;
}

export function fingerprintBudgetLedgerEntryV1(entry: BudgetLedgerEntryV1): string {
  return digestBudgetCanonicalValue({
    version: entry.version,
    sequence: entry.sequence,
    allocationId: entry.allocationId,
    ...(entry.relatedAllocationId === undefined ? {} : { relatedAllocationId: entry.relatedAllocationId }),
    ...(entry.reservationId === undefined ? {} : { reservationId: entry.reservationId }),
    operation: entry.operation,
    idempotencyKey: entry.idempotencyKey,
    policyRevision: entry.policyRevision,
    allocationRevision: entry.allocationRevision,
    amounts: entry.amounts,
    recordedAt: entry.recordedAt,
  });
}

export function parseBudgetReservationRequestV1(value: unknown): BudgetReservationRequestV1 {
  const record = requireRecord(value, "Budget reservation request");
  rejectUnknownFields(record, [
    "allocationId", "allocationRevision", "policyRevision", "reservationId", "scope", "amounts", "idempotencyKey", "createdAt",
  ], "Budget reservation request");
  return {
    allocationId: requireIdentifier(record.allocationId, "Budget reservation request allocationId"),
    allocationRevision: requireNonNegativeInteger(record.allocationRevision, "Budget reservation request allocationRevision"),
    policyRevision: requireHash(record.policyRevision, "Budget reservation request policyRevision"),
    reservationId: requireIdentifier(record.reservationId, "Budget reservation request reservationId"),
    scope: parseBudgetScopeV1(record.scope),
    amounts: parseBudgetAmountsV1(record.amounts, "Budget reservation request amounts", true),
    idempotencyKey: requireIdentifier(record.idempotencyKey, "Budget reservation request idempotencyKey"),
    ...(record.createdAt === undefined ? {} : { createdAt: requireTimestamp(record.createdAt, "Budget reservation request createdAt") }),
  };
}

export function parseBudgetSnapshotV2(value: unknown): BudgetSnapshotV2 {
  const record = requireRecord(value, "Budget snapshot");
  rejectUnknownFields(record, [
    "version", "allocation", "reserved", "committed", "available", "openReservationIds", "openChildAllocationIds", "ledgerSequence",
  ], "Budget snapshot");
  requireVersion(record.version, BUDGET_SNAPSHOT_VERSION, "Budget snapshot");
  return {
    version: BUDGET_SNAPSHOT_VERSION,
    allocation: parseBudgetAllocationV1(record.allocation),
    reserved: parseBudgetAmountsV1(record.reserved, "Budget snapshot reserved"),
    committed: parseBudgetAmountsV1(record.committed, "Budget snapshot committed"),
    available: parseBudgetAmountsV1(record.available, "Budget snapshot available"),
    openReservationIds: parseUniqueIdentifiers(record.openReservationIds, "Budget snapshot openReservationIds"),
    openChildAllocationIds: parseUniqueIdentifiers(record.openChildAllocationIds, "Budget snapshot openChildAllocationIds"),
    ledgerSequence: requireNonNegativeInteger(record.ledgerSequence, "Budget snapshot ledgerSequence"),
  };
}

export function parseBudgetAmountsV1(
  value: unknown,
  label = "Budget amounts",
  requireNonEmpty = false,
): BudgetAmountsV1 {
  const record = requireRecord(value, label);
  rejectUnknownFields(record, RESOURCE_KEY_SET, label);
  const parsed: BudgetAmountsV1 = {};
  for (const key of BUDGET_RESOURCE_KEYS) {
    if (record[key] !== undefined) parsed[key] = requireNonNegativeInteger(record[key], `${label} ${key}`);
  }
  if (requireNonEmpty && Object.keys(parsed).length === 0) throw new Error(`${label} must not be empty.`);
  return parsed;
}

export function isBudgetScopeAncestor(ancestor: BudgetScopeV1, descendant: BudgetScopeV1): boolean {
  return ancestor.segments.length <= descendant.segments.length && ancestor.segments.every((segment, index) => {
    const candidate = descendant.segments[index];
    return candidate?.kind === segment.kind && candidate.id === segment.id;
  });
}

function parsePolicyAllocation(value: unknown, label: string): BudgetPolicyAllocationV1 {
  const record = requireRecord(value, label);
  rejectUnknownFields(record, ["allocationKey", "parentAllocationKey", "scope", "limits"], label);
  return {
    allocationKey: requireIdentifier(record.allocationKey, `${label} allocationKey`),
    ...(record.parentAllocationKey === undefined ? {} : {
      parentAllocationKey: requireIdentifier(record.parentAllocationKey, `${label} parentAllocationKey`),
    }),
    scope: parseBudgetScopeV1(record.scope),
    limits: parseBudgetAmountsV1(record.limits, `${label} limits`),
  };
}

function requireImmediateChildScope(parent: BudgetScopeV1, child: BudgetScopeV1, label: string): void {
  if (child.segments.length !== parent.segments.length + 1 || !isBudgetScopeAncestor(parent, child)) {
    throw new Error(`${label} scope must be the exact immediate child of its authored parent.`);
  }
}

function requireNarrowedLimits(parent: BudgetAmountsV1, child: BudgetAmountsV1, label: string): void {
  for (const key of BUDGET_RESOURCE_KEYS) {
    const parentLimit = parent[key];
    const childLimit = child[key];
    if (parentLimit !== undefined && (childLimit === undefined || childLimit > parentLimit)) {
      throw new Error(`${label} '${key}' limit must be finite and no greater than its parent.`);
    }
  }
}

function requireScopeKind(value: unknown, label: string): BudgetScopeKindV1 {
  const allowed = new Set<BudgetScopeKindV1>([
    "tenant", "run", "agent", "subagent", "model", "tool", "sandbox", "evaluator", "embedding",
  ]);
  if (!allowed.has(value as BudgetScopeKindV1)) throw new Error(`${label} is invalid.`);
  return value as BudgetScopeKindV1;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: Iterable<string>, label: string): void {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  const unknown = Object.keys(record).find((key) => !set.has(key));
  if (unknown !== undefined) throw new Error(`${label} contains unknown field '${unknown}'.`);
}

function requireVersion(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} version must be '${expected}'.`);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) throw new Error(`${label} must be a bounded exact identifier.`);
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`${label} must be a sha256 digest.`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = requireNonNegativeInteger(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function requireTimestamp(value: unknown, label: string): string {
  return parseBudgetTimestampV1(value, label);
}

function parseUniqueIdentifiers(value: unknown, label: string): string[] {
  const result = requireArray(value, label).map((item, index) => requireIdentifier(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique identifiers.`);
  return result;
}

function emptyHash(): string {
  return `sha256:${"0".repeat(64)}`;
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortCanonical(item)]),
  );
}
