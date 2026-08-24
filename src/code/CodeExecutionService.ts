import { createHash, randomUUID } from "node:crypto";
import { serializeCanonicalApprovalPayload, type RunnerExternalApprovalBindingV1 } from "@kestrel-agents/protocol";
import type {
  CodeExecutionRequest,
  CodeExecutionResult,
  CodeModeProfileConfig,
  SandboxCapabilityGrant,
  SandboxCapabilityRuntimeContext,
  SandboxExecutionOutput,
  SandboxExecutor,
} from "./contracts.js";
import { DockerSandboxCancellationError, DockerSandboxExecutor, DockerUnavailableError } from "./DockerSandboxExecutor.js";
import { evaluateExecutionPolicy } from "./PolicyEngine.js";
import {
  fingerprintSandboxCapabilityCatalogV2,
  normalizeSandboxCapabilityProfilesV2,
  normalizeSandboxCapabilitySelectionV2,
  type SandboxCapabilityLeaseBindingV2,
  type SandboxCapabilityProfileV2,
  type SandboxCapabilitySelectionV2,
} from "../kestrel/contracts/sandbox-capability.js";
import { KESTREL_EXECUTION_BOUNDARY_POLICY } from "../security/ExecutionBoundaryPolicy.js";
import { SandboxCapabilityExactResultConflictError } from "../kestrel/contracts/store.js";
import { SandboxCapabilityAdapterFailure, SandboxCapabilityAdapterRegistry } from "./SandboxCapabilityAdapterRegistry.js";
import { tavilySearchReadAdapter } from "./adapters/TavilySearchReadAdapter.js";

export const DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY = new SandboxCapabilityAdapterRegistry([
  tavilySearchReadAdapter,
]);

export function sandboxCapabilityExternalActionKey(input: { toolCallId: string; capabilityId: string; operation: string }): string {
  return `code.execute:${input.toolCallId}:${input.capabilityId}:${input.operation}`;
}

export function digestSandboxCapabilityExternalPayload(input: { capabilityId: string; operation: string; input: Record<string, unknown> }): string {
  return `sha256:${createHash("sha256").update(serializeCanonicalApprovalPayload(input)).digest("hex")}`;
}

export interface CodeExecutionServiceOptions {
  executor?: SandboxExecutor | undefined;
  capabilityAdapters?: SandboxCapabilityAdapterRegistry | undefined;
}

export class CodeExecutionService {
  private readonly executor: SandboxExecutor;
  private readonly capabilityAdapters: SandboxCapabilityAdapterRegistry;

  constructor(options: CodeExecutionServiceOptions = {}) {
    this.executor = options.executor ?? new DockerSandboxExecutor();
    this.capabilityAdapters = options.capabilityAdapters ?? DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY;
  }

  async execute(
    config: CodeModeProfileConfig | undefined,
    request: CodeExecutionRequest,
    options: {
      signal?: AbortSignal | undefined;
      capability?: SandboxCapabilityGrant | undefined;
      capabilityRuntime?: SandboxCapabilityRuntimeContext | undefined;
      persistCompletedCapabilityResult?: ((result: CodeExecutionResult) => Promise<void>) | undefined;
    } = {},
  ): Promise<CodeExecutionResult> {
    const policyDecision = evaluateExecutionPolicy(config, request);
    if (policyDecision.ok === false) {
      return policyDecision.result;
    }
    let capability = options.capability;
    let releaseCapabilitySensitiveValue: (() => void) | undefined;
    let redactCapabilityResult: (<T>(value: T) => T) | undefined;
    let capabilityReplayEvidence: CodeExecutionResult["capabilityReplayEvidence"];
    let exactCapabilityResultCommitted = false;
    if (request.capability !== undefined) {
      const resolved = await resolveSandboxCapability(
        this.capabilityAdapters,
        config,
        request.capability,
        options.capabilityRuntime,
        options.persistCompletedCapabilityResult === undefined
          ? undefined
          : async (result) => {
              await options.persistCompletedCapabilityResult!(result);
              exactCapabilityResultCommitted = true;
            },
        options.signal,
        policyDecision.policy,
        config?.retention ?? { persistSummary: true, persistArtifacts: true },
      );
      capability = resolved.grant;
      releaseCapabilitySensitiveValue = resolved.releaseSensitiveValue;
      redactCapabilityResult = resolved.redactSensitiveValues;
      capabilityReplayEvidence = resolved.replayEvidence;
    } else if (options.capability !== undefined) {
      throw new Error("Caller-authored sandbox capability grants are not accepted");
    }
    try {
      const output = await this.executor.execute({
        request: policyDecision.request,
        policy: policyDecision.policy,
        capability,
        signal: options.signal,
      });
      if (options.signal?.aborted === true && !exactCapabilityResultCommitted) {
        throw new DockerSandboxCancellationError("Docker sandbox execution was cancelled");
      }

      return buildCompletedCodeExecutionResult({
        output,
        policy: policyDecision.policy,
        retention: config?.retention ?? { persistSummary: true, persistArtifacts: true },
        capabilityReplayEvidence: exactCapabilityResultCommitted ? capabilityReplayEvidence : undefined,
        redact: redactCapabilityResult,
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw redactCapabilityError(error, redactCapabilityResult);
      }
      if (error instanceof DockerUnavailableError) {
        const result: CodeExecutionResult = {
          status: "runtime_unavailable",
          exitCode: null,
          stdout: "",
          stderr: error.message,
          durationMs: 0,
          artifacts: [],
          summary: "Code runtime unavailable: Docker is not installed or not reachable.",
          policy: policyDecision.policy,
          retention: config?.retention ?? { persistSummary: true, persistArtifacts: true },
        };
        return redactCapabilityResult?.(result) ?? result;
      }

      const result: CodeExecutionResult = {
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        artifacts: [],
        summary: "Code execution failed before completion due to an internal runtime error.",
        policy: policyDecision.policy,
        retention: config?.retention ?? { persistSummary: true, persistArtifacts: true },
      };
      return redactCapabilityResult?.(result) ?? result;
    } finally {
      try {
        releaseCapabilitySensitiveValue?.();
      } catch {
        // Sensitive-value cleanup is best effort and must never replace the
        // already-produced result or sanitized cancellation diagnostic.
      }
    }
  }
}

function buildCompletedCodeExecutionResult(input: {
  output: SandboxExecutionOutput;
  policy: CodeExecutionResult["policy"];
  retention: CodeExecutionResult["retention"];
  capabilityReplayEvidence?: CodeExecutionResult["capabilityReplayEvidence"] | undefined;
  redact?: (<T>(value: T) => T) | undefined;
}): CodeExecutionResult {
  const result: CodeExecutionResult = {
    status: input.output.status,
    exitCode: input.output.exitCode,
    stdout: input.output.stdout,
    stderr: input.output.stderr,
    durationMs: input.output.durationMs,
    artifacts: input.output.artifacts,
    summary: summarizeExecutionResult(input.output),
    policy: input.policy,
    retention: input.retention,
    ...(input.capabilityReplayEvidence === undefined
      ? {}
      : { capabilityReplayEvidence: input.capabilityReplayEvidence }),
  };
  return input.redact?.(result) ?? result;
}

function redactCapabilityError(
  error: unknown,
  redact: (<T>(value: T) => T) | undefined,
): unknown {
  if (redact === undefined) return error;
  try {
    return sanitizeCapabilityError(error, redact, new WeakMap<object, unknown>());
  } catch {
    return createFallbackCancellationError(error, redact);
  }
}

function sanitizeCapabilityError(
  value: unknown,
  redact: <T>(value: T) => T,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value !== "object" || value === null) return safelyRedact(value, redact);
  const prior = seen.get(value);
  if (prior !== undefined) return "[Circular]";
  const errorClassification = classifyErrorSafely(value);
  if (errorClassification === undefined) throw new Error("Unsafe cancellation diagnostic");
  if (errorClassification === false) {
    const sanitizedValue: Record<PropertyKey, unknown> | unknown[] = isArraySafely(value) ? [] : {};
    seen.set(value, sanitizedValue);
    for (const key of ownKeysSafely(value)) {
      const sanitizedKey = sanitizePropertyKey(key, redact);
      if (sanitizedKey === undefined) continue;
      const descriptor = getOwnPropertyDescriptorSafely(value, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const sanitizedItem = sanitizeCapabilityError(descriptor.value, redact, seen);
      if (Array.isArray(sanitizedValue) && /^\d+$/u.test(sanitizedKey)) {
        sanitizedValue[Number(sanitizedKey)] = sanitizedItem;
      } else {
        try {
          Object.defineProperty(sanitizedValue, sanitizedKey, {
            value: sanitizedItem,
            enumerable: descriptor.enumerable ?? false,
            configurable: true,
            writable: true,
          });
        } catch {
          // Hostile metadata is omitted rather than escaping unredacted.
        }
      }
    }
    return sanitizedValue;
  }
  const errorValue = value as Error;

  // Cancellation errors may be DOMExceptions, frozen Errors, or carry
  // read-only runtime metadata. Never mutate or invoke arbitrary accessors on
  // the original error while sensitive values are registered.
  const sanitized = new Error(safelyRedact(readErrorString(errorValue, "message", "Execution cancelled") ?? "Execution cancelled", redact));
  seen.set(value, sanitized);
  sanitized.name = safelyRedact(readErrorString(errorValue, "name", "Error") ?? "Error", redact);

  const stack = readErrorString(errorValue, "stack");
  if (stack !== undefined) sanitized.stack = safelyRedact(stack, redact);

  const causeDescriptor = getOwnPropertyDescriptorSafely(value, "cause");
  if (causeDescriptor !== undefined && "value" in causeDescriptor) {
    sanitized.cause = sanitizeCapabilityError(causeDescriptor.value, redact, seen);
  }

  for (const key of ownKeysSafely(value)) {
    if (key === "message" || key === "name" || key === "stack" || key === "cause") continue;
    const sanitizedKey = sanitizePropertyKey(key, redact);
    if (sanitizedKey === undefined) continue;
    const descriptor = getOwnPropertyDescriptorSafely(value, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    defineSanitizedErrorProperty(
      sanitized,
      sanitizedKey,
      sanitizeCapabilityError(descriptor.value, redact, seen),
      descriptor.enumerable ?? false,
    );
  }

  // DOMException exposes its actionable numeric code through an inherited
  // getter rather than an own property.
  if (!("code" in sanitized)) {
    try {
      const code = (value as Error & { code?: unknown }).code;
      if (code !== undefined) defineSanitizedErrorProperty(sanitized, "code", safelyRedact(code, redact), true);
    } catch {
      // Hostile accessors are intentionally omitted from the sanitized copy.
    }
  }
  return sanitized;
}

function createFallbackCancellationError(
  value: unknown,
  redact: <T>(value: T) => T,
): Error {
  const error = new Error("Execution cancelled");
  error.name = typeof value === "object" && value !== null && classifyErrorSafely(value) === true
    ? safelyRedact(readErrorString(value as Error, "name", "RunCancelledError") ?? "RunCancelledError", redact)
    : "RunCancelledError";
  const code = readPropertySafely(value, "code");
  defineSanitizedErrorProperty(
    error,
    "code",
    typeof code === "string" || typeof code === "number"
      ? safelyRedact(code, redact)
      : "RUN_CANCELLED",
    true,
  );
  return error;
}

function classifyErrorSafely(value: object): boolean | undefined {
  try {
    return value instanceof Error;
  } catch {
    return undefined;
  }
}

function isArraySafely(value: object): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function ownKeysSafely(value: object): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw new Error("Unsafe cancellation diagnostic");
  }
}

function getOwnPropertyDescriptorSafely(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error("Unsafe cancellation diagnostic");
  }
}

function readPropertySafely(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function sanitizePropertyKey(
  key: PropertyKey,
  redact: <T>(value: T) => T,
): string | undefined {
  if (typeof key !== "string") return undefined;
  const sanitized = safelyRedact(key, redact);
  return typeof sanitized === "string" ? sanitized : undefined;
}

function safelyRedact<T>(value: T, redact: <U>(value: U) => U): T {
  try {
    return redact(value);
  } catch {
    return "[REDACTED]" as T;
  }
}

function readErrorString(error: Error, key: "message" | "name" | "stack", fallback?: string): string | undefined {
  try {
    const value = error[key];
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

function defineSanitizedErrorProperty(
  error: Error,
  key: PropertyKey,
  value: unknown,
  enumerable: boolean,
): void {
  try {
    Object.defineProperty(error, key, { value, enumerable, configurable: true, writable: true });
  } catch {
    // A sanitized diagnostic must never replace cancellation with a copy error.
  }
}

async function resolveSandboxCapability(
  adapters: SandboxCapabilityAdapterRegistry,
  config: CodeModeProfileConfig | undefined,
  selectedValue: unknown,
  runtime: SandboxCapabilityRuntimeContext | undefined,
  persistCompletedCapabilityResult: ((result: CodeExecutionResult) => Promise<void>) | undefined,
  signal: AbortSignal | undefined,
  appliedPolicy: CodeExecutionResult["policy"],
  retention: CodeExecutionResult["retention"],
): Promise<{
  grant: SandboxCapabilityGrant;
  replayEvidence: NonNullable<CodeExecutionResult["capabilityReplayEvidence"]>;
  releaseSensitiveValue?: (() => void) | undefined;
  redactSensitiveValues?: (<T>(value: T) => T) | undefined;
}> {
  const selected = normalizeSandboxCapabilitySelectionV2(selectedValue);
  const authoredProfiles = normalizeSandboxCapabilityProfilesV2(config?.capabilities ?? []);
  if (runtime !== undefined && runtime.capabilityCatalogFingerprint !== fingerprintSandboxCapabilityCatalogV2(authoredProfiles)) throw new Error("Sandbox capability catalog fingerprint is stale");
  const authored = authoredProfiles.find((item) => item.capabilityId === selected.capabilityId);
  if (authored === undefined) throw new Error("Selected sandbox capability is not authored by the resolved profile");
  const adapter = adapters.requireExact({ capabilityId: selected.capabilityId, operation: selected.operation, resource: authored.resource });
  const profile: SandboxCapabilityProfileV2 = adapter.parseProfile(authored) as SandboxCapabilityProfileV2;
  const adapterSelection: SandboxCapabilitySelectionV2 = adapter.parseSelection(selected) as SandboxCapabilitySelectionV2;
  if (runtime === undefined) throw new Error("Trusted sandbox capability runtime context is missing");
  if (runtime.registerSensitiveValue === undefined || runtime.redactSensitiveValues === undefined) {
    throw new Error("Sandbox capability sensitive-value registration and redaction are required together");
  }
  if (runtime.leaseCoordinator === undefined) {
    throw new Error("Durable sandbox capability lease coordination is unavailable");
  }
  if (runtime.tenantId !== profile.audience.tenantId || runtime.environmentId !== profile.audience.environmentId) throw new Error("Sandbox capability audience does not match the trusted runtime identity");
  if (runtime.brokerAuthority.authorityId !== profile.brokerAuthority.authorityId || runtime.brokerAuthority.revision !== profile.brokerAuthority.revision) throw new Error("Sandbox broker authority is stale or mismatched");
  if (/^[a-f0-9]{64}$/u.test(runtime.profileFingerprint) === false) throw new Error("Sandbox capability resolved-profile fingerprint is invalid");
  if (runtime.executionBoundaryRevision !== KESTREL_EXECUTION_BOUNDARY_POLICY.revision) throw new Error("Sandbox capability execution-boundary revision is stale");
  const canonicalInput = adapter.canonicalInput(profile, adapterSelection);
  if (typeof canonicalInput !== "object" || canonicalInput === null || Array.isArray(canonicalInput)) throw new Error("Sandbox capability adapter canonical input must be a JSON object");
  const canonicalInputRecord = canonicalInput as Record<string, unknown>;
  const externalApprovalBinding = adapter.effectClass === "external_effect"
    ? requireExactExternalApprovalBinding({ runtime, adapter, canonicalInput: canonicalInputRecord })
    : undefined;
  const credentialSnapshot = runtime.resolveCredentialSnapshot === undefined ? runtime.credentialSnapshot : await runtime.resolveCredentialSnapshot();
  if (credentialSnapshot === undefined) throw new Error("Authoritative sandbox capability credential snapshot is unavailable");
  for (const [label, value] of Object.entries({ sessionId: runtime.sessionId, runId: runtime.runId, toolCallId: runtime.toolCallId, executionBoundaryRevision: runtime.executionBoundaryRevision, credentialRevision: credentialSnapshot.revision })) {
    if (value.trim().length === 0) throw new Error(`Trusted sandbox capability ${label} is missing`);
  }
  if (credentialSnapshot.credentialId !== adapter.credentialId || credentialSnapshot.secret.trim().length === 0) throw new Error("Authoritative sandbox capability credential snapshot is unavailable");
  const now = (runtime.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + profile.maxExpiryMs);
  const leaseBinding: SandboxCapabilityLeaseBindingV2 = {
    version: 2,
    tenantId: runtime.tenantId,
    environmentId: runtime.environmentId,
    sessionId: runtime.sessionId,
    runId: runtime.runId,
    toolCallId: runtime.toolCallId,
    profileFingerprint: runtime.profileFingerprint,
    capabilityCatalogFingerprint: runtime.capabilityCatalogFingerprint,
    executionBoundaryRevision: runtime.executionBoundaryRevision,
    capabilityId: selected.capabilityId,
    operation: adapter.operation,
    resource: adapter.resource,
    effectClass: adapter.effectClass,
    audience: profile.audience,
    brokerAuthority: runtime.brokerAuthority,
    credentialReference: {
      credentialId: credentialSnapshot.credentialId,
      revision: credentialSnapshot.revision,
    },
    policyRevision: runtime.policy?.policyRevision ?? runtime.executionBoundaryRevision,
    ...(runtime.approval === undefined ? {} : { approval: {
      ...(runtime.approval.approvalId === undefined ? {} : { approvalId: runtime.approval.approvalId }),
      authorityRevision: runtime.approval.authorityRevision,
    } }),
    ...(externalApprovalBinding === undefined ? {} : { externalApprovalBinding }),
    ...(runtime.parentAuthorization === undefined ? {} : { parentAuthorization: runtime.parentAuthorization }),
  };
  const durableLease = await runtime.leaseCoordinator.request({
    binding: leaseBinding,
    expiresAt: expiresAt.toISOString(),
    requestLimit: profile.maxRequests,
    responseByteLimit: profile.maxResponseBytes,
  });
  if (durableLease.transition !== "issued") {
    throw new Error(`Sandbox capability lease was not issued: ${durableLease.terminalReason ?? durableLease.transition}`);
  }
  const qualificationCheckpoint = async (
    checkpoint: import("./contracts.js").SandboxCapabilityQualificationCheckpoint,
  ) => await runtime.qualificationObserver?.checkpoint({
    checkpoint,
    leaseId: durableLease.leaseId,
    runId: runtime.runId,
    toolCallId: runtime.toolCallId,
  });
  await qualificationCheckpoint("lease_issued");
  let sensitiveMaterialReleased = false;
  let resultPersistenceCommitted = false;
  let providerInvocationReserved = false;
  let providerResultCommitted = false;
  let invocationResponseByteLimit = profile.maxResponseBytes;
  let releaseRegisteredSensitiveValue: (() => void) | undefined;
  const expiryTimer = setTimeout(() => {
    void runtime.leaseCoordinator!.expire(durableLease.leaseId, leaseBinding, "lease_expired").catch(() => {});
  }, Math.max(1, expiresAt.getTime() - (runtime.now ?? (() => new Date()))().getTime()));
  expiryTimer.unref?.();
  const disposeSensitiveMaterial = () => {
    if (sensitiveMaterialReleased) return;
    sensitiveMaterialReleased = true;
    clearTimeout(expiryTimer);
    releaseRegisteredSensitiveValue?.();
  };
  const grant: SandboxCapabilityGrant = {
    transport: "docker-shared-loopback-v1",
    lease: randomUUID(),
    operation: adapter.operation,
    destination: adapter.destination(profile),
    response: undefined,
    expiresAt: expiresAt.toISOString(),
    maxRequests: 1,
    maxResponseBytes: profile.maxResponseBytes,
    authority: {
      version: 2,
      capabilityId: adapter.capabilityId,
      operation: adapter.operation,
      resource: adapter.resource,
      effectClass: adapter.effectClass,
      tenantId: runtime.tenantId,
      environmentId: runtime.environmentId,
      sessionId: runtime.sessionId,
      runId: runtime.runId,
      toolCallId: runtime.toolCallId,
      profileFingerprint: runtime.profileFingerprint,
      executionBoundaryRevision: runtime.executionBoundaryRevision,
      brokerAuthority: runtime.brokerAuthority,
      credentialReference: {
        credentialId: credentialSnapshot.credentialId,
        revision: credentialSnapshot.revision,
      },
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    expectedInput: canonicalInputRecord,
    lifecycle: {
      beforeProviderInvocation: async () => {
        await qualificationCheckpoint("before_provider_invocation");
        const reservation = await runtime.leaseCoordinator!.reserveInvocation(durableLease.leaseId, leaseBinding);
        providerInvocationReserved = true;
        invocationResponseByteLimit = reservation.invocationResponseByteLimit;
        return { responseByteLimit: invocationResponseByteLimit };
      },
      commitProviderResult: async ({ result, responseBytes }) => {
        await runtime.leaseCoordinator!.commitResult({
          leaseId: durableLease.leaseId,
          expectedBinding: leaseBinding,
          result,
          responseBytes,
          exactProviderUsage: null,
        });
        providerResultCommitted = true;
        await qualificationCheckpoint("provider_result_committed");
      },
      recordProviderFailure: async (error) => {
        if (
          error instanceof SandboxCapabilityAdapterFailure &&
          error.code === "CAPABILITY_DEADLINE_EXCEEDED" &&
          (runtime.now ?? (() => new Date()))().getTime() >= expiresAt.getTime()
        ) {
          await runtime.leaseCoordinator!.expire(durableLease.leaseId, leaseBinding, "lease_expired_during_provider_invocation");
          return;
        }
        await runtime.leaseCoordinator!.recordProviderFailure(
          durableLease.leaseId,
          leaseBinding,
          error instanceof SandboxCapabilityAdapterFailure && error.code === "CAPABILITY_DEADLINE_EXCEEDED"
            ? "provider_invocation_timeout"
            : "provider_invocation_failed",
        );
      },
      beforeContainerTeardown: async (reason, completedOutput) => {
        let persistenceError: unknown;
        try {
            const effectiveReason = signal?.aborted === true ? "cancelled" : reason;
            if (completedOutput?.status === "ok" && persistCompletedCapabilityResult !== undefined) {
              try {
                await qualificationCheckpoint("before_exact_result_persistence");
                await persistCompletedCapabilityResult(buildCompletedCodeExecutionResult({
                  output: completedOutput,
                  policy: appliedPolicy,
                  retention,
                  capabilityReplayEvidence: {
                    version: 1,
                    leaseId: durableLease.leaseId,
                    bindingDigest: durableLease.bindingDigest,
                    toolCallId: durableLease.binding.toolCallId,
                  },
                  redact: runtime.redactSensitiveValues,
                }));
                resultPersistenceCommitted = true;
                await qualificationCheckpoint("exact_result_persisted");
              } catch (error) {
                persistenceError = error;
              }
            }
            const winningResultCommitted = resultPersistenceCommitted
              || persistenceError instanceof SandboxCapabilityExactResultConflictError;
            const settlementReason = signal?.aborted === true && !winningResultCommitted
              ? "cancelled"
              : winningResultCommitted && completedOutput !== undefined
                ? completedOutput.status === "ok" ? "completed" : completedOutput.status === "timeout" ? "timeout" : "failed"
                : effectiveReason;
            try {
              await qualificationCheckpoint("before_lease_cleanup");
              await runtime.leaseCoordinator!.settleBeforeTeardown({
                leaseId: durableLease.leaseId,
                expectedBinding: leaseBinding,
                reason: settlementReason,
                disposeSensitiveMaterial,
              });
              await qualificationCheckpoint("lease_cleanup_completed");
            } catch (error) {
              if (!winningResultCommitted) throw error;
            }
            if (persistenceError !== undefined && !(providerInvocationReserved && !providerResultCommitted)) {
              throw persistenceError;
            }
            return { completedResultCommitted: resultPersistenceCommitted };
        } finally {
          // Durable evidence can honestly remain non-cleaned when its store
          // is unavailable, but process-local authority must still be gone
          // before Docker is allowed to remove either container.
          disposeSensitiveMaterial();
        }
      },
    },
    adapter: async (adapterInput, signal) => {
      try {
        const remainingExpiryMs = expiresAt.getTime() - (runtime.now ?? (() => new Date()))().getTime();
        if (remainingExpiryMs <= 0) throw new Error("Tavily adapter capability expired before provider invocation");
        const response = await adapter.invoke(adapterInput, {
          fetchImpl: runtime.fetchImpl ?? fetch,
          credential: credentialSnapshot.secret,
          timeoutMs: profile.timeoutMs,
          expiryMs: remainingExpiryMs,
          maxResponseBytes: invocationResponseByteLimit,
          signal,
        });
        await qualificationCheckpoint("provider_response_received");
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const sanitized = message.split(credentialSnapshot.secret).join("[redacted:credential]");
        if (error instanceof SandboxCapabilityAdapterFailure) {
          throw new SandboxCapabilityAdapterFailure(error.code, sanitized);
        }
        throw new SandboxCapabilityAdapterFailure("CAPABILITY_PROVIDER_FAILED", sanitized);
      }
    },
  };
  const releaseSensitiveValue = runtime.registerSensitiveValue({
    referenceId: [
      "sandbox-capability",
      credentialSnapshot.credentialId,
      credentialSnapshot.revision,
      runtime.toolCallId,
    ].join(":"),
    value: credentialSnapshot.secret,
  });
  if (typeof releaseSensitiveValue !== "function") {
    await runtime.leaseCoordinator.settleBeforeTeardown({
      leaseId: durableLease.leaseId,
      expectedBinding: leaseBinding,
      reason: "failed",
      disposeSensitiveMaterial: () => {},
    });
    throw new Error("Sandbox capability sensitive-value registration must provide cleanup");
  }
  releaseRegisteredSensitiveValue = releaseSensitiveValue;
  return {
    grant,
    replayEvidence: {
      version: 1,
      leaseId: durableLease.leaseId,
      bindingDigest: durableLease.bindingDigest,
      toolCallId: durableLease.binding.toolCallId,
    },
    releaseSensitiveValue: disposeSensitiveMaterial,
    ...(runtime.redactSensitiveValues === undefined ? {} : { redactSensitiveValues: runtime.redactSensitiveValues }),
  };
}

function requireExactExternalApprovalBinding(input: {
  runtime: SandboxCapabilityRuntimeContext;
  adapter: { capabilityId: string; operation: string };
  canonicalInput: Record<string, unknown>;
}): RunnerExternalApprovalBindingV1 {
  const approval = input.runtime.approval;
  const binding = approval?.externalApprovalBinding;
  const expectedActionKey = sandboxCapabilityExternalActionKey({ toolCallId: input.runtime.toolCallId, capabilityId: input.adapter.capabilityId, operation: input.adapter.operation });
  const expectedPayloadHash = digestSandboxCapabilityExternalPayload({ capabilityId: input.adapter.capabilityId, operation: input.adapter.operation, input: input.canonicalInput });
  if (
    input.runtime.policy?.decision !== "approval_required" ||
    approval?.approvalId === undefined ||
    binding === undefined ||
    binding.approvalId !== approval.approvalId ||
    binding.actionKey !== expectedActionKey ||
    binding.payloadHash !== expectedPayloadHash ||
    binding.runId !== input.runtime.runId ||
    input.runtime.threadId === undefined || binding.threadId !== input.runtime.threadId ||
    Date.parse(binding.expiresAt) <= (input.runtime.now ?? (() => new Date()))().getTime() ||
    !binding.capabilities.includes("code.execute") ||
    !binding.capabilities.includes(input.adapter.capabilityId)
  ) {
    throw new Error("External-effect sandbox capability requires an exact current action-bound approval");
  }
  return binding;
}

function summarizeExecutionResult(output: SandboxExecutionOutput): string {
  if (output.status === "timeout") {
    return `Execution timed out after ${output.durationMs}ms.`;
  }

  const base =
    output.status === "ok"
      ? `Execution completed successfully in ${output.durationMs}ms.`
      : `Execution failed with exit code ${output.exitCode ?? "unknown"} in ${output.durationMs}ms.`;

  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();
  if (stdout.length === 0 && stderr.length === 0) {
    return `${base} No console output.`;
  }

  const snippets: string[] = [];
  if (stdout.length > 0) {
    snippets.push(`stdout: ${clip(stdout, 180)}`);
  }
  if (stderr.length > 0) {
    snippets.push(`stderr: ${clip(stderr, 180)}`);
  }

  return `${base} ${snippets.join(" ")}`;
}

function clip(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}
