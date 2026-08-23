import { createHash, randomUUID } from "node:crypto";

import {
  fingerprintSandboxCapabilityLeaseBindingV1,
  assertSandboxCapabilityLeaseTransitionV1,
  parseSandboxCapabilityLeaseBindingV1,
  type SandboxCapabilityLeaseBindingV1,
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

export interface SandboxCapabilityLeaseCoordinatorOptions {
  store: SandboxCapabilityLeaseStore;
  now?: (() => Date) | undefined;
  validateCurrent: (
    binding: SandboxCapabilityLeaseBindingV1,
  ) => Promise<SandboxCapabilityLeaseCurrentness>;
  persistResult: (input: {
    leaseId: string;
    binding: SandboxCapabilityLeaseBindingV1;
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
    binding: SandboxCapabilityLeaseBindingV1;
    expiresAt: string;
    requestLimit: number;
    responseByteLimit: number;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const binding = parseSandboxCapabilityLeaseBindingV1(input.binding);
    const occurredAt = this.timestamp();
    const leaseId = `sandbox-lease:${randomUUID()}`;
    const requested = await this.append({
      version: 1,
      leaseId,
      sequence: 1,
      transition: "requested",
      binding,
      bindingDigest: fingerprintSandboxCapabilityLeaseBindingV1(binding),
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
    const current = await this.options.validateCurrent(binding);
    if (!current.authorized || this.isExpired(requested)) {
      const terminal = await this.transition(requested, this.isExpired(requested) ? "expired" : "denied", {
        terminalOutcome: this.isExpired(requested) ? "expired" : "denied",
        terminalReason: current.reason ?? (this.isExpired(requested) ? "lease_expired" : "authorization_denied"),
      });
      return await this.transition(terminal, "cleaned", { cleanedAt: this.timestamp() });
    }
    if (binding.parentAuthorization !== undefined) {
      try {
        await this.reserveChildAuthorization(binding, input.requestLimit, input.responseByteLimit);
      } catch (error) {
        const denied = await this.transition(requested, "denied", {
          terminalOutcome: "denied",
          terminalReason: "parent_authorization_reservation_denied",
        });
        await this.transition(denied, "cleaned", { cleanedAt: this.timestamp() });
        throw error;
      }
    }
    return await this.transition(requested, "issued", { issuedAt: this.timestamp() });
  }

  async reserveInvocation(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBindingV1,
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const current = await this.requireExact(leaseId, expectedBinding);
    if (current.transition !== "issued") {
      throw new Error(`Sandbox capability lease cannot invoke from '${current.transition}'`);
    }
    const authorization = await this.options.validateCurrent(current.binding);
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
    return await this.transition(current, "invoking", {
      usage: { ...current.usage, requestsConsumed: current.usage.requestsConsumed + 1 },
    });
  }

  async commitResult(input: {
    leaseId: string;
    expectedBinding: SandboxCapabilityLeaseBindingV1;
    result: unknown;
    responseBytes: number;
    exactProviderUsage?: number | null | undefined;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const current = await this.requireExact(input.leaseId, input.expectedBinding);
    if (current.transition !== "invoking") {
      throw new Error(`Sandbox capability result cannot commit from '${current.transition}'`);
    }
    const authorization = await this.options.validateCurrent(current.binding);
    if (!authorization.authorized || this.isExpired(current)) {
      const transition = this.isExpired(current) ? "expired" : "revoked";
      await this.transition(current, transition, {
        terminalOutcome: transition,
        terminalReason: authorization.reason ?? "authorization_changed_before_result_delivery",
      });
      throw new Error("Sandbox capability result delivery is no longer authorized");
    }
    if (!Number.isSafeInteger(input.responseBytes) || input.responseBytes < 0 ||
        current.usage.responseBytesConsumed + input.responseBytes > current.usage.responseByteLimit) {
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
    expectedBinding: SandboxCapabilityLeaseBindingV1,
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
    expectedBinding: SandboxCapabilityLeaseBindingV1,
    reason = "authorization_revoked",
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    return await this.terminalize(leaseId, expectedBinding, "revoked", "revoked", reason);
  }

  async cancel(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBindingV1,
    reason = "execution_cancelled",
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    return await this.terminalize(leaseId, expectedBinding, "cancelled", "cancelled", reason);
  }

  async expire(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBindingV1,
    reason = "lease_expired",
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    return await this.terminalize(leaseId, expectedBinding, "expired", "expired", reason);
  }

  async cleanup(input: {
    leaseId: string;
    expectedBinding: SandboxCapabilityLeaseBindingV1;
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
    expectedBinding: SandboxCapabilityLeaseBindingV1;
    reason: "completed" | "failed" | "cancelled" | "timeout";
    disposeSensitiveMaterial: () => void | Promise<void>;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    let current = await this.requireExact(input.leaseId, input.expectedBinding);
    if (!isTerminal(current.transition)) {
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
    expectedBinding: SandboxCapabilityLeaseBindingV1,
  ): Promise<SandboxCapabilityLeaseRecovery> {
    let current = await this.requireExact(leaseId, expectedBinding);
    if (current.transition === "invoking") {
      current = await this.transition(current, "revoked", {
        terminalOutcome: "failed",
        terminalReason: "ambiguous_provider_invocation_after_crash",
      });
      return { kind: "denied", lease: current, reason: "ambiguous_provider_invocation" };
    }
    if ((current.transition === "consumed" || current.transition === "exhausted") && current.result !== undefined) {
      return { kind: "replay", lease: current, result: current.result };
    }
    if (current.transition !== "issued") {
      return { kind: "denied", lease: current, reason: `terminal_${current.transition}` };
    }
    const authorization = await this.options.validateCurrent(current.binding);
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
    expectedBinding: SandboxCapabilityLeaseBindingV1,
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const current = await this.store.getSandboxCapabilityLease(leaseId);
    if (current === null) throw new Error("Sandbox capability lease does not exist");
    const digest = fingerprintSandboxCapabilityLeaseBindingV1(expectedBinding);
    if (current.bindingDigest !== digest) throw new Error("Sandbox capability lease binding does not match the exact action");
    return current;
  }

  private async terminalize(
    leaseId: string,
    expectedBinding: SandboxCapabilityLeaseBindingV1,
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

  private async reserveChildAuthorization(
    binding: SandboxCapabilityLeaseBindingV1,
    requestLimit: number,
    responseByteLimit: number,
  ): Promise<SandboxCapabilityChildReservationV1 | undefined> {
    const parentAuthorization = binding.parentAuthorization;
    if (parentAuthorization === undefined) return;
    if (requestLimit !== parentAuthorization.requestLimit || responseByteLimit !== parentAuthorization.responseByteLimit) {
      throw new Error("Child sandbox capability ceilings do not match the independent parent authorization");
    }
    if (binding.approval === undefined) {
      throw new Error("Child sandbox capability requires independent approval authority");
    }
    const parent = await this.store.getSandboxCapabilityLease(parentAuthorization.leaseId);
    if (parent === null || parent.bindingDigest !== parentAuthorization.bindingDigest || parent.transition !== "issued") {
      throw new Error("Child sandbox capability parent authorization is missing, stale, or inactive");
    }
    return await this.store.reserveSandboxCapabilityChild({
      expectedParentSequence: parent.sequence,
      reservation: {
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
      },
    });
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
    assertSandboxCapabilityLeaseTransitionV1(current.transition, transition);
    return await this.append({
      ...current,
      ...patch,
      version: 1,
      sequence: current.sequence + 1,
      transition,
      occurredAt: this.timestamp(),
    }, current.sequence);
  }

  private async append(
    record: SandboxCapabilityLeaseTransitionRecordV1,
    expectedSequence: number,
  ): Promise<SandboxCapabilityLeaseTransitionRecordV1> {
    const committed = await this.store.appendSandboxCapabilityLeaseTransition({ expectedSequence, record });
    await this.options.appendTransitionEvent?.(committed);
    return committed;
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
