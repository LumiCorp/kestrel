import { createHash, randomUUID } from "node:crypto";

import {
  fingerprintSandboxCapabilityLeaseBinding,
  assertSandboxCapabilityLeaseTransitionV1,
  parseSandboxCapabilityLeaseBinding,
  type SandboxCapabilityLeaseBinding,
  type SandboxCapabilityChildReservationV1,
  type SandboxCapabilityLeaseResultEvidenceV1,
  type SandboxCapabilityLeaseTransitionRecordV1,
  type SandboxCapabilityLeaseTransitionV1,
} from "../kestrel/contracts/sandbox-capability.js";
import type { SandboxCapabilityLeaseStore } from "../kestrel/contracts/store.js";

export interface SandboxCapabilityLeaseCurrentness {
  authorized: boolean;
  reason?: string | undefined;
}

export type SandboxCapabilityLeaseCurrentnessBoundary =
  | "issuance"
  | "provider_invocation"
  | "result_delivery"
  | "recovery_resume"
  | "recorded_replay";

export interface SandboxCapabilityLeaseCoordinatorOptions {
  store: SandboxCapabilityLeaseStore;
  now?: (() => Date) | undefined;
  validateCurrent: (
    binding: SandboxCapabilityLeaseBinding,
    boundary: SandboxCapabilityLeaseCurrentnessBoundary,
  ) => Promise<SandboxCapabilityLeaseCurrentness>;
  persistResult: (input: {
    leaseId: string;
    binding: SandboxCapabilityLeaseBinding;
    result: unknown;
  }) => Promise<SandboxCapabilityLeaseResultEvidenceV1>;
  appendTransitionEvent?: ((record: SandboxCapabilityLeaseTransitionRecordV1) => Promise<void>) | undefined;
}

export type SandboxCapabilityLeaseRecovery =
  | { kind: "resume"; lease: SandboxCapabilityLeaseTransitionRecordV1 }
  | { kind: "replay"; lease: SandboxCapabilityLeaseTransitionRecordV1; result: SandboxCapabilityLeaseResultEvidenceV1 }
  | { kind: "denied"; lease: SandboxCapabilityLeaseTransitionRecordV1; reason: string };

/**
 * Owns legal, durable lease transitions. The opaque broker token is
 * deliberately absent: callers retain and dispose that process-local value.
 */
export class SandboxCapabilityLeaseCoordinator {
  private readonly store: SandboxCapabilityLeaseStore;
  private readonly now: () => Date;

  constructor(private readonly options: SandboxCapabilityLeaseCoordinatorOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  async request(input: {
    binding: SandboxCapabilityLeaseBinding;
    expiresAt: string;
    requestLimit: number;
    responseByteLimit: number;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const binding = parseSandboxCapabilityLeaseBinding(input.binding);
    const occurredAt = this.timestamp();
    const leaseId = `sandbox-lease:${randomUUID()}`;
    const requested = await this.append({
      version: 1,
      leaseId,
      sequence: 1,
      transition: "requested",
      binding,
      bindingDigest: fingerprintSandboxCapabilityLeaseBinding(binding),
      usage: {
        requestLimit: input.requestLimit,
        requestsConsumed: 0,
        responseByteLimit: input.responseByteLimit,
        responseBytesConsumed: 0,
        exactProviderUsage: null,
      },
      expiresAt: normalizeTimestamp(input.expiresAt),
      occurredAt,
    }, 0);
    try {
      const current = await this.options.validateCurrent(binding, "issuance");
      if (!current.authorized || this.isExpired(requested)) {
        const terminal = await this.transition(requested, this.isExpired(requested) ? "expired" : "denied", {
          terminalOutcome: this.isExpired(requested) ? "expired" : "denied",
          terminalReason: current.reason ?? (this.isExpired(requested) ? "lease_expired" : "authorization_denied"),
        });
        return await this.transition(terminal, "cleaned", { cleanedAt: this.timestamp() });
      }
      const issued = this.nextRecord(requested, "issued", { issuedAt: this.timestamp() });
      const childReservation = this.createChildReservation(binding, input.requestLimit, input.responseByteLimit);
      const committed = await this.store.issueSandboxCapabilityLease({
        expectedSequence: requested.sequence,
        record: issued,
        ...(childReservation === undefined ? {} : { childReservation }),
      });
      await this.emitTransitionEventBestEffort(committed);
      return committed;
    } catch (error) {
      await this.settleInterruptedRequest(requested);
      throw error;
    }
  }

  async reserveInvocation(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBinding,
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1 & { invocationResponseByteLimit: number }> {
    const current = await this.requireExact(leaseId, expectedBinding);
    if (current.transition !== "issued") {
      throw new Error(`Sandbox capability lease cannot invoke from '${current.transition}'`);
    }
    const authorization = await this.options.validateCurrent(current.binding, "provider_invocation");
    if (!authorization.authorized) {
      await this.transition(current, "revoked", {
        terminalOutcome: "revoked",
        terminalReason: authorization.reason ?? "authorization_stale",
      });
      throw new Error("Sandbox capability authorization is no longer current");
    }
    if (this.isExpired(current)) {
      await this.transition(current, "expired", {
        terminalOutcome: "expired",
        terminalReason: "lease_expired_before_provider_invocation",
      });
      throw new Error("Sandbox capability lease expired before provider invocation");
    }
    if (current.usage.requestsConsumed >= current.usage.requestLimit) {
      await this.transition(current, "exhausted", {
        terminalOutcome: "exhausted",
        terminalReason: "request_ceiling_reached",
      });
      throw new Error("Sandbox capability request ceiling is exhausted");
    }
    const invoking = this.nextRecord(current, "invoking", {
      usage: { ...current.usage, requestsConsumed: current.usage.requestsConsumed + 1 },
    });
    const committed = await this.store.reserveSandboxCapabilityInvocation({
      expectedSequence: current.sequence,
      record: invoking,
    });
    await this.emitTransitionEventBestEffort(committed);
    return committed;
  }

  async commitResult(input: {
    leaseId: string;
    expectedBinding: SandboxCapabilityLeaseBinding;
    result: unknown;
    responseBytes: number;
    exactProviderUsage?: number | null | undefined;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const current = await this.requireExact(input.leaseId, input.expectedBinding);
    if (current.transition !== "invoking") {
      throw new Error(`Sandbox capability result cannot commit from '${current.transition}'`);
    }
    const authorization = await this.options.validateCurrent(current.binding, "result_delivery");
    if (!authorization.authorized || this.isExpired(current)) {
      const transition = this.isExpired(current) ? "expired" : "revoked";
      await this.transition(current, transition, {
        terminalOutcome: transition,
        terminalReason: authorization.reason ?? "authorization_changed_before_result_delivery",
      });
      throw new Error("Sandbox capability result delivery is no longer authorized");
    }
    const childResponseBytesAllocated = (await this.store.listSandboxCapabilityChildReservations(current.leaseId))
      .reduce((sum, reservation) => sum + (reservation.status === "reserved"
        ? reservation.decision.responseByteLimit
        : reservation.status === "committed" ? reservation.responseBytesCommitted : 0), 0);
    if (!Number.isSafeInteger(input.responseBytes) || input.responseBytes < 0 ||
        current.usage.responseBytesConsumed + childResponseBytesAllocated + input.responseBytes > current.usage.responseByteLimit) {
      await this.transition(current, "exhausted", {
        terminalOutcome: "exhausted",
        terminalReason: "response_byte_ceiling_reached",
      });
      throw new Error("Sandbox capability response byte ceiling is exhausted");
    }
    const result = await this.options.persistResult({
      leaseId: current.leaseId,
      binding: current.binding,
      result: input.result,
    });
    const committedUsage = {
      ...current.usage,
      responseBytesConsumed: current.usage.responseBytesConsumed + input.responseBytes,
      exactProviderUsage: input.exactProviderUsage ?? null,
    };
    // A child reservation must be committed before its result becomes
    // replayable. A crash after this point may conservatively count usage, but
    // can never replay an unaccounted provider result.
    await this.settleChildAuthorization({ ...current, usage: committedUsage }, "committed");
    const consumed = await this.transition(current, "consumed", {
      usage: committedUsage,
      result,
      terminalOutcome: "completed",
    });
    if (consumed.usage.requestsConsumed >= consumed.usage.requestLimit) {
      const exhausted = await this.transition(consumed, "exhausted", {
        terminalOutcome: "completed",
        terminalReason: "request_ceiling_reached_after_success",
      });
      return exhausted;
    }
    return consumed;
  }

  async recordProviderFailure(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBinding,
    reason = "provider_invocation_failed",
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const current = await this.requireExact(leaseId, expectedBinding);
    if (isTerminal(current.transition)) return current;
    return await this.transition(current, "revoked", {
      terminalOutcome: "failed",
      terminalReason: reason,
    });
  }

  async revoke(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBinding,
    reason = "authorization_revoked",
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    return await this.terminalize(leaseId, expectedBinding, "revoked", "revoked", reason);
  }

  async cancel(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBinding,
    reason = "execution_cancelled",
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    return await this.terminalize(leaseId, expectedBinding, "cancelled", "cancelled", reason);
  }

  async expire(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBinding,
    reason = "lease_expired",
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    return await this.terminalize(leaseId, expectedBinding, "expired", "expired", reason);
  }

  async cleanup(input: {
    leaseId: string;
    expectedBinding: SandboxCapabilityLeaseBinding;
    disposeSensitiveMaterial: () => void | Promise<void>;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const current = await this.requireExact(input.leaseId, input.expectedBinding);
    if (!isTerminal(current.transition)) throw new Error("Active sandbox capability lease must be terminal before cleanup");
    if (current.transition === "cleaned") return current;
    await input.disposeSensitiveMaterial();
    return await this.transition(current, "cleaned", { cleanedAt: this.timestamp() });
  }

  async settleBeforeTeardown(input: {
    leaseId: string;
    expectedBinding: SandboxCapabilityLeaseBinding;
    reason: "completed" | "failed" | "cancelled" | "timeout";
    disposeSensitiveMaterial: () => void | Promise<void>;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    let current = await this.requireExact(input.leaseId, input.expectedBinding);
    const lateCancellation = input.reason === "cancelled"
      && (current.transition === "consumed" || current.transition === "exhausted");
    if (!isTerminal(current.transition) || lateCancellation) {
      const transition = input.reason === "cancelled" ? "cancelled" : "revoked";
      current = await this.transition(current, transition, {
        terminalOutcome: input.reason === "cancelled" ? "cancelled" : "failed",
        terminalReason: `container_teardown_${input.reason}`,
      });
    }
    if (current.terminalOutcome !== "completed") {
      await this.settleChildAuthorization(current, "released");
    }
    return await this.cleanup({
      leaseId: current.leaseId,
      expectedBinding: current.binding,
      disposeSensitiveMaterial: input.disposeSensitiveMaterial,
    });
  }

  async recover(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBinding,
  ): Promise<SandboxCapabilityLeaseRecovery> {
    let current = await this.requireExact(leaseId, expectedBinding);
    if (current.transition === "requested") {
      const denied = await this.transition(current, "denied", {
        terminalOutcome: "denied",
        terminalReason: "requested_issuance_interrupted",
      });
      current = await this.transition(denied, "cleaned", { cleanedAt: this.timestamp() });
      return { kind: "denied", lease: current, reason: "requested_issuance_interrupted" };
    }
    if (current.transition === "invoking") {
      current = await this.transition(current, "revoked", {
        terminalOutcome: "failed",
        terminalReason: "ambiguous_provider_invocation_after_crash",
      });
      return { kind: "denied", lease: current, reason: "ambiguous_provider_invocation" };
    }
    if ((current.transition === "consumed" || current.transition === "exhausted") && current.result !== undefined) {
      const authorization = await this.options.validateCurrent(current.binding, "recorded_replay");
      if (!authorization.authorized || this.isExpired(current)) {
        current = await this.transition(current, this.isExpired(current) ? "expired" : "revoked", {
          terminalOutcome: this.isExpired(current) ? "expired" : "revoked",
          terminalReason: authorization.reason ?? "replay_authorization_stale",
        });
        return {
          kind: "denied",
          lease: current,
          reason: authorization.reason ?? (this.isExpired(current) ? "lease_expired" : "replay_authorization_stale"),
        };
      }
      return { kind: "replay", lease: current, result: current.result };
    }
    if (current.transition !== "issued") {
      return { kind: "denied", lease: current, reason: `terminal_${current.transition}` };
    }
    const authorization = await this.options.validateCurrent(current.binding, "recovery_resume");
    if (!authorization.authorized || this.isExpired(current)) {
      const transition = this.isExpired(current) ? "expired" : "revoked";
      current = await this.transition(current, transition, {
        terminalOutcome: transition,
        terminalReason: authorization.reason ?? "recovery_authorization_stale",
      });
      return { kind: "denied", lease: current, reason: current.terminalReason ?? transition };
    }
    return { kind: "resume", lease: current };
  }

  private async requireExact(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBinding,
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const current = await this.store.getSandboxCapabilityLease(leaseId);
    if (current === null) throw new Error("Sandbox capability lease does not exist");
    const digest = fingerprintSandboxCapabilityLeaseBinding(expectedBinding);
    if (current.bindingDigest !== digest) throw new Error("Sandbox capability lease binding does not match the exact action");
    return current;
  }

  private async terminalize(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBinding,
    transition: "revoked" | "cancelled" | "expired",
    terminalOutcome: "revoked" | "cancelled" | "expired",
    terminalReason: string,
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const current = await this.requireExact(leaseId, expectedBinding);
    if (isTerminal(current.transition)) return current;
    const terminal = await this.transition(current, transition, { terminalOutcome, terminalReason });
    await this.settleChildAuthorization(terminal, "released");
    return terminal;
  }

  private createChildReservation(
    binding: SandboxCapabilityLeaseBinding,
    requestLimit: number,
    responseByteLimit: number,
  ): SandboxCapabilityChildReservationV1 | undefined {
    const parentAuthorization = binding.parentAuthorization;
    if (parentAuthorization === undefined) return;
    if (requestLimit !== parentAuthorization.requestLimit || responseByteLimit !== parentAuthorization.responseByteLimit) {
      throw new Error("Child sandbox capability ceilings do not match the independent parent authorization");
    }
    if (binding.approval === undefined) {
      throw new Error("Child sandbox capability requires independent approval authority");
    }
    return {
        version: 1,
        reservationId: parentAuthorization.reservationId,
        sequence: 1,
        status: "reserved",
        decision: {
          version: 1,
          decisionId: parentAuthorization.authorizationDecisionId,
          parentLeaseId: parentAuthorization.leaseId,
          parentBindingDigest: parentAuthorization.bindingDigest,
          childSessionId: binding.sessionId,
          childRunId: binding.runId,
          childToolCallId: binding.toolCallId,
          policyRevision: binding.policyRevision,
          approval: binding.approval,
          requestLimit,
          responseByteLimit,
          decidedAt: this.timestamp(),
        },
        requestsCommitted: 0,
        responseBytesCommitted: 0,
        occurredAt: this.timestamp(),
    };
  }

  private async settleInterruptedRequest(requested: SandboxCapabilityLeaseTransitionRecordV1): Promise<void> {
    try {
      const current = await this.store.getSandboxCapabilityLease(requested.leaseId);
      if (current === null || current.transition !== "requested") return;
      const denied = await this.transition(current, "denied", {
        terminalOutcome: "denied",
        terminalReason: "issuance_interrupted",
      });
      await this.transition(denied, "cleaned", { cleanedAt: this.timestamp() });
    } catch {
      // If the store cannot settle now, requested remains recoverable and can
      // only be denied by recovery; it is never treated as issued authority.
    }
  }

  private async settleChildAuthorization(
    lease: SandboxCapabilityLeaseTransitionRecordV1,
    status: "committed" | "released",
  ): Promise<void> {
    const reservationId = lease.binding.parentAuthorization?.reservationId;
    if (reservationId === undefined) return;
    const reservation = await this.store.getSandboxCapabilityChildReservation(reservationId);
    if (reservation === null || reservation.status !== "reserved") return;
    await this.store.settleSandboxCapabilityChild({
      reservationId,
      expectedSequence: reservation.sequence,
      status,
      requestsCommitted: status === "committed" ? lease.usage.requestsConsumed : 0,
      responseBytesCommitted: status === "committed" ? lease.usage.responseBytesConsumed : 0,
      reason: status === "committed" ? "child_capability_consumed" : (lease.terminalReason ?? "child_capability_released"),
      occurredAt: this.timestamp(),
    });
  }

  private isExpired(record: SandboxCapabilityLeaseTransitionRecordV1): boolean {
    return this.now().getTime() >= Date.parse(record.expiresAt);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async transition(
    current: SandboxCapabilityLeaseTransitionRecordV1,
    transition: SandboxCapabilityLeaseTransitionV1,
    patch: Partial<SandboxCapabilityLeaseTransitionRecordV1>,
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    return await this.append(this.nextRecord(current, transition, patch), current.sequence);
  }

  private nextRecord(
    current: SandboxCapabilityLeaseTransitionRecordV1,
    transition: SandboxCapabilityLeaseTransitionV1,
    patch: Partial<SandboxCapabilityLeaseTransitionRecordV1>,
  ): SandboxCapabilityLeaseTransitionRecordV1 {
    assertSandboxCapabilityLeaseTransitionV1(current.transition, transition);
    return {
      ...current,
      ...patch,
      version: 1,
      sequence: current.sequence + 1,
      transition,
      occurredAt: this.timestamp(),
    };
  }

  private async append(
    record: SandboxCapabilityLeaseTransitionRecordV1,
    expectedSequence: number,
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const committed = await this.store.appendSandboxCapabilityLeaseTransition({ expectedSequence, record });
    await this.options.appendTransitionEvent?.(committed);
    return committed;
  }

  private async emitTransitionEventBestEffort(record: SandboxCapabilityLeaseTransitionRecordV1): Promise<void> {
    try {
      await this.options.appendTransitionEvent?.(record);
    } catch {
      // Durable stores append the authoritative event in the same transaction.
      // This optional observer must not turn a committed authority transition
      // into an apparent issuance or invocation failure.
    }
  }
}

function isTerminal(transition: SandboxCapabilityLeaseTransitionV1): boolean {
  return ["denied", "consumed", "exhausted", "revoked", "expired", "cancelled", "cleaned"].includes(transition);
}

function normalizeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Sandbox capability lease expiry must be a timestamp");
  return new Date(timestamp).toISOString();
}

export function digestSandboxCapabilityResult(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
