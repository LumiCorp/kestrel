import {
  BUDGET_ALLOCATION_VERSION,
  BUDGET_LEDGER_ENTRY_VERSION,
  BUDGET_RESERVATION_VERSION,
  BUDGET_RESOURCE_KEYS,
  BUDGET_SNAPSHOT_VERSION,
  digestBudgetCanonicalValue,
  isBudgetScopeAncestor,
  parseBudgetAllocationV1,
  parseBudgetAmountsV1,
  parseBudgetPolicyV1,
  parseBudgetReservationV1,
  parseBudgetReservationRequestV1,
  parseBudgetScopeV1,
  parseBudgetSnapshotV2,
  parseBudgetTimestampV1,
  parseBudgetUsageV1,
  type BudgetAllocationV1,
  type BudgetAmountsV1,
  type BudgetLedgerEntryV1,
  type BudgetPolicyAllocationV1,
  type BudgetPolicyV1,
  type BudgetReservationPortV1,
  type BudgetReservationRequestV1,
  type BudgetReservationResultV1,
  type BudgetReservationV1,
  type BudgetScopeV1,
  type BudgetSnapshotV2,
  type BudgetUsageV1,
} from "../kestrel/contracts/budget.js";
import type {
  BudgetAllocationStateV1,
  BudgetIdempotencyRecordV1,
  BudgetRepositoryStateV1,
  BudgetRepositoryV1,
} from "./repository.js";

export interface OpenBudgetAllocationInputV1 {
  allocationId: string;
  allocationKey: string;
  policyRevision: string;
  parentAllocationId?: string | undefined;
  parentAllocationRevision?: number | undefined;
  idempotencyKey: string;
  openedAt?: string | undefined;
}

export interface CommitBudgetReservationInputV1 {
  allocationId: string;
  allocationRevision: number;
  policyRevision: string;
  reservationId: string;
  reservationRevision: number;
  usage: BudgetUsageV1;
  idempotencyKey: string;
}

export interface ReleaseBudgetReservationInputV1 {
  allocationId: string;
  allocationRevision: number;
  policyRevision: string;
  reservationId: string;
  reservationRevision: number;
  idempotencyKey: string;
  releasedAt?: string | undefined;
}

export interface CloseBudgetAllocationInputV1 {
  allocationId: string;
  allocationRevision: number;
  policyRevision: string;
  parentAllocationId?: string | undefined;
  parentAllocationRevision?: number | undefined;
  idempotencyKey: string;
  closedAt?: string | undefined;
}

export interface SettledBudgetReservationResultV1 {
  reservation: BudgetReservationV1;
  snapshot: BudgetSnapshotV2;
}

export interface ClosedBudgetAllocationResultV1 {
  allocation: BudgetAllocationV1;
  parentSnapshot?: BudgetSnapshotV2 | undefined;
}

export class BudgetIntegrityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BudgetIntegrityError";
    this.code = code;
  }
}

export class BudgetCoordinator implements BudgetReservationPortV1 {
  private readonly policy: BudgetPolicyV1;
  private readonly allocationPolicies: ReadonlyMap<string, BudgetPolicyAllocationV1>;
  private readonly repository: BudgetRepositoryV1;
  private readonly now: () => string;

  constructor(options: {
    policy: BudgetPolicyV1;
    repository: BudgetRepositoryV1;
    now?: (() => string) | undefined;
  }) {
    this.policy = parseBudgetPolicyV1(options.policy);
    this.allocationPolicies = new Map(this.policy.allocations.map((allocation) => [allocation.allocationKey, allocation]));
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async openAllocation(input: OpenBudgetAllocationInputV1): Promise<BudgetAllocationV1> {
    rejectUnknownInput(input, [
      "allocationId", "allocationKey", "policyRevision", "parentAllocationId", "parentAllocationRevision", "idempotencyKey", "openedAt",
    ], "Open budget allocation input");
    const request = {
      allocationId: requireIdentifier(input.allocationId, "allocationId"),
      allocationKey: requireIdentifier(input.allocationKey, "allocationKey"),
      policyRevision: requirePolicyRevision(input.policyRevision, this.policy.revision),
      ...(input.parentAllocationId === undefined ? {} : { parentAllocationId: requireIdentifier(input.parentAllocationId, "parentAllocationId") }),
      ...(input.parentAllocationRevision === undefined ? {} : { parentAllocationRevision: requireRevision(input.parentAllocationRevision, "parentAllocationRevision") }),
      idempotencyKey: requireIdentifier(input.idempotencyKey, "idempotencyKey"),
      ...(input.openedAt === undefined ? {} : { openedAt: requireTimestamp(input.openedAt, "openedAt") }),
    };
    const requestDigest = operationDigest("openAllocation", request);
    return this.repository.transaction((state) => {
      const replay = replayOperation<BudgetAllocationV1>(state, request.idempotencyKey, "openAllocation", requestDigest);
      if (replay !== undefined) return { state, result: parseBudgetAllocationV1(replay) };
      if (state.allocations[request.allocationId] !== undefined) {
        throw integrity("BUDGET_ALLOCATION_DUPLICATE", `Budget allocation '${request.allocationId}' already exists.`);
      }
      const authored = this.allocationPolicies.get(request.allocationKey);
      if (authored === undefined) throw integrity("BUDGET_ALLOCATION_UNAUTHORED", `Budget allocation key '${request.allocationKey}' is not authored by the policy.`);
      const existingBinding = Object.values(state.allocations).find((candidate) =>
        candidate.allocation.allocationKey === authored.allocationKey &&
        isExactBudgetScope(candidate.allocation.scope, authored.scope));
      if (existingBinding !== undefined) {
        throw integrity(
          "BUDGET_ALLOCATION_ALREADY_BOUND",
          `Budget allocation '${authored.allocationKey}' at its exact scope is permanently bound to '${existingBinding.allocation.allocationId}'.`,
        );
      }
      const openedAt = request.openedAt ?? requireTimestamp(this.now(), "clock");
      let parent: BudgetAllocationStateV1 | undefined;
      let reservedFromParent: BudgetAmountsV1 = {};
      if (authored.parentAllocationKey === undefined) {
        if (request.parentAllocationId !== undefined || request.parentAllocationRevision !== undefined) {
          throw integrity("BUDGET_PARENT_MISMATCH", "Root budget allocations cannot name a parent.");
        }
      } else {
        if (request.parentAllocationId === undefined || request.parentAllocationRevision === undefined) {
          throw integrity("BUDGET_PARENT_REQUIRED", "Child budget allocations require an exact parent identity and revision.");
        }
        parent = requireOpenAllocation(state, request.parentAllocationId);
        requireAllocationRevision(parent, request.parentAllocationRevision);
        if (parent.allocation.allocationKey !== authored.parentAllocationKey) {
          throw integrity("BUDGET_PARENT_MISMATCH", "Child budget allocation does not match its authored parent key.");
        }
        if (!isImmediateChild(parent.allocation.scope, authored.scope)) {
          throw integrity("BUDGET_SCOPE_MISMATCH", "Child budget allocation scope does not extend its exact runtime parent.");
        }
        reservedFromParent = structuredClone(authored.limits);
        if (!fits(parent, reservedFromParent)) {
          throw integrity("BUDGET_PARENT_EXHAUSTED", "Parent budget allocation cannot reserve the authored child allocation.");
        }
        parent.reserved = addAmounts(parent.reserved, reservedFromParent);
        parent.openChildAllocationIds.push(request.allocationId);
        parent.allocation.revision += 1;
        appendLedger(state, {
          allocationId: parent.allocation.allocationId,
          relatedAllocationId: request.allocationId,
          operation: "child.reserved",
          idempotencyKey: request.idempotencyKey,
          policyRevision: this.policy.revision,
          allocationRevision: parent.allocation.revision,
          amounts: reservedFromParent,
          recordedAt: openedAt,
        });
      }
      const allocation = parseBudgetAllocationV1({
        version: BUDGET_ALLOCATION_VERSION,
        allocationId: request.allocationId,
        allocationKey: request.allocationKey,
        policyId: this.policy.policyId,
        policyRevision: this.policy.revision,
        scope: authored.scope,
        ...(request.parentAllocationId === undefined ? {} : { parentAllocationId: request.parentAllocationId }),
        limits: authored.limits,
        reservedFromParent,
        status: "open",
        revision: 0,
        openedAt,
      });
      state.allocations[allocation.allocationId] = {
        allocation,
        reserved: {},
        committed: {},
        openChildAllocationIds: [],
      };
      appendLedger(state, {
        allocationId: allocation.allocationId,
        operation: "allocation.opened",
        idempotencyKey: request.idempotencyKey,
        policyRevision: this.policy.revision,
        allocationRevision: allocation.revision,
        amounts: allocation.limits,
        recordedAt: openedAt,
      });
      recordOperation(state, request.idempotencyKey, "openAllocation", requestDigest, allocation);
      return { state, result: allocation };
    });
  }

  async reserve(input: BudgetReservationRequestV1): Promise<BudgetReservationResultV1> {
    const request = parseBudgetReservationRequestV1(input);
    requirePolicyRevision(request.policyRevision, this.policy.revision);
    const requestDigest = operationDigest("reserve", request);
    return this.repository.transaction((state) => {
      const replay = replayOperation<BudgetReservationResultV1>(state, request.idempotencyKey, "reserve", requestDigest);
      if (replay !== undefined) return { state, result: parseReservationResult(replay) };
      if (state.reservations[request.reservationId] !== undefined) {
        throw integrity("BUDGET_RESERVATION_DUPLICATE", `Budget reservation '${request.reservationId}' already exists.`);
      }
      const allocation = requireOpenAllocation(state, request.allocationId);
      requireAllocationRevision(allocation, request.allocationRevision);
      if (!isBudgetScopeAncestor(allocation.allocation.scope, request.scope)) {
        throw integrity("BUDGET_SCOPE_MISMATCH", "Budget reservation scope is outside its allocation lineage.");
      }
      if (!fits(allocation, request.amounts)) {
        const denied: BudgetReservationResultV1 = {
          status: "denied",
          reasonCode: "BUDGET_EXHAUSTED",
          snapshot: snapshot(state, allocation),
        };
        recordOperation(state, request.idempotencyKey, "reserve", requestDigest, denied);
        return { state, result: denied };
      }
      const createdAt = request.createdAt ?? requireTimestamp(this.now(), "clock");
      const reservation = parseBudgetReservationV1({
        version: BUDGET_RESERVATION_VERSION,
        reservationId: request.reservationId,
        allocationId: request.allocationId,
        policyRevision: this.policy.revision,
        scope: request.scope,
        requested: request.amounts,
        committed: {},
        remaining: request.amounts,
        status: "open",
        revision: 0,
        createdAt,
      });
      state.reservations[reservation.reservationId] = reservation;
      allocation.reserved = addAmounts(allocation.reserved, request.amounts);
      allocation.allocation.revision += 1;
      appendLedger(state, {
        allocationId: request.allocationId,
        reservationId: reservation.reservationId,
        operation: "reservation.opened",
        idempotencyKey: request.idempotencyKey,
        policyRevision: this.policy.revision,
        allocationRevision: allocation.allocation.revision,
        amounts: request.amounts,
        recordedAt: createdAt,
      });
      const result: BudgetReservationResultV1 = {
        status: "reserved",
        reservation,
        snapshot: snapshot(state, allocation),
      };
      recordOperation(state, request.idempotencyKey, "reserve", requestDigest, result);
      return { state, result };
    });
  }

  async commit(input: CommitBudgetReservationInputV1): Promise<SettledBudgetReservationResultV1> {
    rejectUnknownInput(input, [
      "allocationId", "allocationRevision", "policyRevision", "reservationId", "reservationRevision", "usage", "idempotencyKey",
    ], "Commit budget reservation input");
    const usage = parseBudgetUsageV1(input.usage);
    const request = {
      allocationId: requireIdentifier(input.allocationId, "allocationId"),
      allocationRevision: requireRevision(input.allocationRevision, "allocationRevision"),
      policyRevision: requirePolicyRevision(input.policyRevision, this.policy.revision),
      reservationId: requireIdentifier(input.reservationId, "reservationId"),
      reservationRevision: requireRevision(input.reservationRevision, "reservationRevision"),
      usage,
      idempotencyKey: requireIdentifier(input.idempotencyKey, "idempotencyKey"),
    };
    requireUsageBinding(usage, request.allocationId, request.reservationId, this.policy.revision);
    const requestDigest = operationDigest("commit", request);
    return this.repository.transaction((state) => {
      const replay = replayOperation<SettledBudgetReservationResultV1>(state, request.idempotencyKey, "commit", requestDigest);
      if (replay !== undefined) return { state, result: parseSettlementResult(replay) };
      const allocation = requireOpenAllocation(state, request.allocationId);
      requireAllocationRevision(allocation, request.allocationRevision);
      const reservation = requireOpenReservation(state, request.reservationId, request.allocationId, request.reservationRevision);
      for (const unknown of usage.unknownCosts) {
        if (allocation.allocation.limits[unknown.resource] !== undefined) {
          throw integrity("BUDGET_PRICE_EVIDENCE_REQUIRED", `Unknown ${unknown.resource} cannot satisfy an active cost ceiling.`);
        }
      }
      requireAmountsWithin(usage.amounts, reservation.remaining, "Committed usage exceeds its reservation");
      const unused = subtractAmounts(reservation.remaining, usage.amounts);
      allocation.reserved = subtractAmounts(allocation.reserved, reservation.remaining);
      allocation.committed = addAmounts(allocation.committed, usage.amounts);
      allocation.allocation.revision += 1;
      reservation.committed = structuredClone(usage.amounts);
      reservation.remaining = {};
      reservation.status = "committed";
      reservation.revision += 1;
      reservation.settledAt = usage.measuredAt;
      appendLedger(state, {
        allocationId: allocation.allocation.allocationId,
        reservationId: reservation.reservationId,
        operation: "reservation.committed",
        idempotencyKey: request.idempotencyKey,
        policyRevision: this.policy.revision,
        allocationRevision: allocation.allocation.revision,
        amounts: usage.amounts,
        recordedAt: usage.measuredAt,
      });
      if (hasPositiveAmount(unused)) {
        appendLedger(state, {
          allocationId: allocation.allocation.allocationId,
          reservationId: reservation.reservationId,
          operation: "reservation.released",
          idempotencyKey: request.idempotencyKey,
          policyRevision: this.policy.revision,
          allocationRevision: allocation.allocation.revision,
          amounts: unused,
          recordedAt: usage.measuredAt,
        });
      }
      const result = { reservation: parseBudgetReservationV1(reservation), snapshot: snapshot(state, allocation) };
      recordOperation(state, request.idempotencyKey, "commit", requestDigest, result);
      return { state, result };
    });
  }

  async release(input: ReleaseBudgetReservationInputV1): Promise<SettledBudgetReservationResultV1> {
    rejectUnknownInput(input, [
      "allocationId", "allocationRevision", "policyRevision", "reservationId", "reservationRevision", "idempotencyKey", "releasedAt",
    ], "Release budget reservation input");
    const request = {
      allocationId: requireIdentifier(input.allocationId, "allocationId"),
      allocationRevision: requireRevision(input.allocationRevision, "allocationRevision"),
      policyRevision: requirePolicyRevision(input.policyRevision, this.policy.revision),
      reservationId: requireIdentifier(input.reservationId, "reservationId"),
      reservationRevision: requireRevision(input.reservationRevision, "reservationRevision"),
      idempotencyKey: requireIdentifier(input.idempotencyKey, "idempotencyKey"),
      ...(input.releasedAt === undefined ? {} : { releasedAt: requireTimestamp(input.releasedAt, "releasedAt") }),
    };
    const requestDigest = operationDigest("release", request);
    return this.repository.transaction((state) => {
      const replay = replayOperation<SettledBudgetReservationResultV1>(state, request.idempotencyKey, "release", requestDigest);
      if (replay !== undefined) return { state, result: parseSettlementResult(replay) };
      const allocation = requireOpenAllocation(state, request.allocationId);
      requireAllocationRevision(allocation, request.allocationRevision);
      const reservation = requireOpenReservation(state, request.reservationId, request.allocationId, request.reservationRevision);
      const releasedAt = request.releasedAt ?? requireTimestamp(this.now(), "clock");
      const released = structuredClone(reservation.remaining);
      allocation.reserved = subtractAmounts(allocation.reserved, released);
      allocation.allocation.revision += 1;
      reservation.remaining = {};
      reservation.status = "released";
      reservation.revision += 1;
      reservation.settledAt = releasedAt;
      appendLedger(state, {
        allocationId: allocation.allocation.allocationId,
        reservationId: reservation.reservationId,
        operation: "reservation.released",
        idempotencyKey: request.idempotencyKey,
        policyRevision: this.policy.revision,
        allocationRevision: allocation.allocation.revision,
        amounts: released,
        recordedAt: releasedAt,
      });
      const result = { reservation: parseBudgetReservationV1(reservation), snapshot: snapshot(state, allocation) };
      recordOperation(state, request.idempotencyKey, "release", requestDigest, result);
      return { state, result };
    });
  }

  async snapshot(input: {
    allocationId: string;
    allocationRevision: number;
    policyRevision: string;
  }): Promise<BudgetSnapshotV2> {
    rejectUnknownInput(input, ["allocationId", "allocationRevision", "policyRevision"], "Budget snapshot input");
    const allocationId = requireIdentifier(input.allocationId, "allocationId");
    const allocationRevision = requireRevision(input.allocationRevision, "allocationRevision");
    requirePolicyRevision(input.policyRevision, this.policy.revision);
    const state = await this.repository.read();
    const allocation = requireAllocation(state, allocationId);
    requireAllocationRevision(allocation, allocationRevision);
    return snapshot(state, allocation);
  }

  async closeAllocation(input: CloseBudgetAllocationInputV1): Promise<ClosedBudgetAllocationResultV1> {
    rejectUnknownInput(input, [
      "allocationId", "allocationRevision", "policyRevision", "parentAllocationId", "parentAllocationRevision", "idempotencyKey", "closedAt",
    ], "Close budget allocation input");
    const request = {
      allocationId: requireIdentifier(input.allocationId, "allocationId"),
      allocationRevision: requireRevision(input.allocationRevision, "allocationRevision"),
      policyRevision: requirePolicyRevision(input.policyRevision, this.policy.revision),
      ...(input.parentAllocationId === undefined ? {} : { parentAllocationId: requireIdentifier(input.parentAllocationId, "parentAllocationId") }),
      ...(input.parentAllocationRevision === undefined ? {} : { parentAllocationRevision: requireRevision(input.parentAllocationRevision, "parentAllocationRevision") }),
      idempotencyKey: requireIdentifier(input.idempotencyKey, "idempotencyKey"),
      ...(input.closedAt === undefined ? {} : { closedAt: requireTimestamp(input.closedAt, "closedAt") }),
    };
    const requestDigest = operationDigest("closeAllocation", request);
    return this.repository.transaction((state) => {
      const replay = replayOperation<ClosedBudgetAllocationResultV1>(state, request.idempotencyKey, "closeAllocation", requestDigest);
      if (replay !== undefined) return { state, result: parseCloseResult(replay) };
      const allocation = requireOpenAllocation(state, request.allocationId);
      requireAllocationRevision(allocation, request.allocationRevision);
      if (allocation.openChildAllocationIds.length > 0 || openReservationIds(state, allocation.allocation.allocationId).length > 0) {
        throw integrity("BUDGET_ALLOCATION_ACTIVE", "Budget allocation cannot close with open children or reservations.");
      }
      const closedAt = request.closedAt ?? requireTimestamp(this.now(), "clock");
      let parentSnapshot: BudgetSnapshotV2 | undefined;
      if (allocation.allocation.parentAllocationId === undefined) {
        if (request.parentAllocationId !== undefined || request.parentAllocationRevision !== undefined) {
          throw integrity("BUDGET_PARENT_MISMATCH", "Root budget allocation close cannot name a parent.");
        }
      } else {
        if (
          request.parentAllocationId !== allocation.allocation.parentAllocationId ||
          request.parentAllocationRevision === undefined
        ) throw integrity("BUDGET_PARENT_MISMATCH", "Child budget allocation close requires its exact parent identity and revision.");
        const parent = requireOpenAllocation(state, request.parentAllocationId);
        requireAllocationRevision(parent, request.parentAllocationRevision);
        parent.reserved = subtractAmounts(parent.reserved, allocation.allocation.reservedFromParent);
        parent.committed = addAmounts(parent.committed, allocation.committed);
        parent.openChildAllocationIds = parent.openChildAllocationIds.filter((id) => id !== allocation.allocation.allocationId);
        parent.allocation.revision += 1;
        appendLedger(state, {
          allocationId: parent.allocation.allocationId,
          relatedAllocationId: allocation.allocation.allocationId,
          operation: "child.committed",
          idempotencyKey: request.idempotencyKey,
          policyRevision: this.policy.revision,
          allocationRevision: parent.allocation.revision,
          amounts: allocation.committed,
          recordedAt: closedAt,
        });
        parentSnapshot = snapshot(state, parent);
      }
      allocation.allocation.status = "closed";
      allocation.allocation.closedAt = closedAt;
      allocation.allocation.revision += 1;
      appendLedger(state, {
        allocationId: allocation.allocation.allocationId,
        operation: "allocation.closed",
        idempotencyKey: request.idempotencyKey,
        policyRevision: this.policy.revision,
        allocationRevision: allocation.allocation.revision,
        amounts: allocation.committed,
        recordedAt: closedAt,
      });
      const result: ClosedBudgetAllocationResultV1 = {
        allocation: parseBudgetAllocationV1(allocation.allocation),
        ...(parentSnapshot === undefined ? {} : { parentSnapshot }),
      };
      recordOperation(state, request.idempotencyKey, "closeAllocation", requestDigest, result);
      return { state, result };
    });
  }
}

function snapshot(state: BudgetRepositoryStateV1, allocation: BudgetAllocationStateV1): BudgetSnapshotV2 {
  const available: BudgetAmountsV1 = {};
  for (const key of BUDGET_RESOURCE_KEYS) {
    const limit = allocation.allocation.limits[key];
    if (limit !== undefined) {
      available[key] = subtractInteger(subtractInteger(limit, allocation.committed[key] ?? 0), allocation.reserved[key] ?? 0);
    }
  }
  return parseBudgetSnapshotV2({
    version: BUDGET_SNAPSHOT_VERSION,
    allocation: allocation.allocation,
    reserved: allocation.reserved,
    committed: allocation.committed,
    available,
    openReservationIds: openReservationIds(state, allocation.allocation.allocationId).sort(),
    openChildAllocationIds: [...allocation.openChildAllocationIds].sort(),
    ledgerSequence: state.nextSequence - 1,
  });
}

function openReservationIds(state: BudgetRepositoryStateV1, allocationId: string): string[] {
  return Object.values(state.reservations)
    .filter((reservation) => reservation.allocationId === allocationId && reservation.status === "open")
    .map((reservation) => reservation.reservationId);
}

function appendLedger(
  state: BudgetRepositoryStateV1,
  input: Omit<BudgetLedgerEntryV1, "version" | "entryId" | "sequence">,
): void {
  const sequence = state.nextSequence;
  const payload = { version: BUDGET_LEDGER_ENTRY_VERSION, sequence, ...input };
  state.ledger.push({ ...payload, entryId: digestBudgetCanonicalValue(payload) });
  state.nextSequence += 1;
}

function recordOperation(
  state: BudgetRepositoryStateV1,
  key: string,
  operation: BudgetIdempotencyRecordV1["operation"],
  requestDigest: string,
  result: unknown,
): void {
  state.idempotency[key] = { operation, requestDigest, result: structuredClone(result) };
}

function replayOperation<T>(
  state: BudgetRepositoryStateV1,
  key: string,
  operation: BudgetIdempotencyRecordV1["operation"],
  requestDigest: string,
): T | undefined {
  const existing = state.idempotency[key];
  if (existing === undefined) return undefined;
  if (existing.operation !== operation || existing.requestDigest !== requestDigest) {
    throw integrity("BUDGET_IDEMPOTENCY_CONFLICT", `Budget idempotency key '${key}' is already bound to a different request.`);
  }
  return structuredClone(existing.result) as T;
}

function requireAllocation(state: BudgetRepositoryStateV1, allocationId: string): BudgetAllocationStateV1 {
  const allocation = state.allocations[allocationId];
  if (allocation === undefined) throw integrity("BUDGET_ALLOCATION_NOT_FOUND", `Budget allocation '${allocationId}' does not exist.`);
  return allocation;
}

function requireOpenAllocation(state: BudgetRepositoryStateV1, allocationId: string): BudgetAllocationStateV1 {
  const allocation = requireAllocation(state, allocationId);
  if (allocation.allocation.status !== "open") throw integrity("BUDGET_ALLOCATION_CLOSED", `Budget allocation '${allocationId}' is closed.`);
  return allocation;
}

function requireOpenReservation(
  state: BudgetRepositoryStateV1,
  reservationId: string,
  allocationId: string,
  revision: number,
): BudgetReservationV1 {
  const reservation = state.reservations[reservationId];
  if (reservation === undefined) throw integrity("BUDGET_RESERVATION_NOT_FOUND", `Budget reservation '${reservationId}' does not exist.`);
  if (reservation.allocationId !== allocationId) throw integrity("BUDGET_RESERVATION_MISMATCH", "Budget reservation belongs to another allocation.");
  if (reservation.revision !== revision) throw integrity("BUDGET_RESERVATION_STALE", "Budget reservation revision is stale.");
  if (reservation.status !== "open") throw integrity("BUDGET_RESERVATION_SETTLED", "Budget reservation is already settled.");
  return reservation;
}

function requireAllocationRevision(allocation: BudgetAllocationStateV1, revision: number): void {
  if (allocation.allocation.revision !== revision) throw integrity("BUDGET_ALLOCATION_STALE", "Budget allocation revision is stale.");
}

function fits(allocation: BudgetAllocationStateV1, requested: BudgetAmountsV1): boolean {
  return BUDGET_RESOURCE_KEYS.every((key) => {
    const limit = allocation.allocation.limits[key];
    if (limit === undefined) return true;
    const total = (allocation.committed[key] ?? 0) + (allocation.reserved[key] ?? 0) + (requested[key] ?? 0);
    return Number.isSafeInteger(total) && total <= limit;
  });
}

function addAmounts(left: BudgetAmountsV1, right: BudgetAmountsV1): BudgetAmountsV1 {
  const result: BudgetAmountsV1 = structuredClone(left);
  for (const key of BUDGET_RESOURCE_KEYS) {
    if (right[key] === undefined) continue;
    const value = (result[key] ?? 0) + right[key]!;
    if (!Number.isSafeInteger(value)) throw integrity("BUDGET_INTEGER_OVERFLOW", `Budget resource '${key}' overflowed a safe integer.`);
    result[key] = value;
  }
  return result;
}

function subtractAmounts(left: BudgetAmountsV1, right: BudgetAmountsV1): BudgetAmountsV1 {
  const result: BudgetAmountsV1 = {};
  for (const key of BUDGET_RESOURCE_KEYS) {
    const leftValue = left[key] ?? 0;
    const rightValue = right[key] ?? 0;
    const value = subtractInteger(leftValue, rightValue);
    if (value > 0 || left[key] !== undefined) result[key] = value;
  }
  return result;
}

function subtractInteger(left: number, right: number): number {
  const value = left - right;
  if (!Number.isSafeInteger(value) || value < 0) throw integrity("BUDGET_CREDIT_INVALID", "Budget settlement attempted to create credit.");
  return value;
}

function requireAmountsWithin(actual: BudgetAmountsV1, reserved: BudgetAmountsV1, label: string): void {
  for (const key of BUDGET_RESOURCE_KEYS) {
    if ((actual[key] ?? 0) > (reserved[key] ?? 0)) throw integrity("BUDGET_USAGE_EXCEEDS_RESERVATION", `${label}: ${key}.`);
  }
}

function hasPositiveAmount(amounts: BudgetAmountsV1): boolean {
  return Object.values(amounts).some((value) => value !== undefined && value > 0);
}

function isImmediateChild(parent: BudgetScopeV1, child: BudgetScopeV1): boolean {
  return child.segments.length === parent.segments.length + 1 && isBudgetScopeAncestor(parent, child);
}

function isExactBudgetScope(left: BudgetScopeV1, right: BudgetScopeV1): boolean {
  return left.segments.length === right.segments.length && isBudgetScopeAncestor(left, right);
}

function requireUsageBinding(usage: BudgetUsageV1, allocationId: string, reservationId: string, policyRevision: string): void {
  if (usage.allocationId !== allocationId || usage.reservationId !== reservationId || usage.policyRevision !== policyRevision) {
    throw integrity("BUDGET_USAGE_BINDING_MISMATCH", "Budget usage does not match its allocation, reservation, and policy revision.");
  }
}

function parseReservationResult(value: unknown): BudgetReservationResultV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Persisted budget reservation result is invalid.");
  const record = value as Record<string, unknown>;
  if (record.status === "reserved") {
    return { status: "reserved", reservation: parseBudgetReservationV1(record.reservation), snapshot: parseBudgetSnapshotV2(record.snapshot) };
  }
  if (record.status === "denied" && record.reasonCode === "BUDGET_EXHAUSTED") {
    return { status: "denied", reasonCode: "BUDGET_EXHAUSTED", snapshot: parseBudgetSnapshotV2(record.snapshot) };
  }
  throw new Error("Persisted budget reservation result is invalid.");
}

function parseSettlementResult(value: unknown): SettledBudgetReservationResultV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Persisted budget settlement result is invalid.");
  const record = value as Record<string, unknown>;
  return { reservation: parseBudgetReservationV1(record.reservation), snapshot: parseBudgetSnapshotV2(record.snapshot) };
}

function parseCloseResult(value: unknown): ClosedBudgetAllocationResultV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Persisted budget close result is invalid.");
  const record = value as Record<string, unknown>;
  return {
    allocation: parseBudgetAllocationV1(record.allocation),
    ...(record.parentSnapshot === undefined ? {} : { parentSnapshot: parseBudgetSnapshotV2(record.parentSnapshot) }),
  };
}

function operationDigest(operation: string, request: unknown): string {
  return digestBudgetCanonicalValue({ operation, request });
}

function requirePolicyRevision(value: string, expected: string): string {
  if (value !== expected) throw integrity("BUDGET_POLICY_STALE", "Budget policy revision is stale.");
  return value;
}

function requireRevision(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw integrity("BUDGET_REVISION_INVALID", `${label} must be a non-negative safe integer.`);
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value)) throw integrity("BUDGET_IDENTITY_INVALID", `${label} must be a bounded exact identifier.`);
  return value;
}

function requireTimestamp(value: string, label: string): string {
  try {
    return parseBudgetTimestampV1(value, label);
  } catch {
    throw integrity("BUDGET_TIMESTAMP_INVALID", `${label} must be an ISO timestamp with an explicit timezone.`);
  }
}

function rejectUnknownInput(value: object, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw integrity("BUDGET_INPUT_UNKNOWN_FIELD", `${label} contains unknown field '${unknown}'.`);
}

function integrity(code: string, message: string): BudgetIntegrityError {
  return new BudgetIntegrityError(code, message);
}
