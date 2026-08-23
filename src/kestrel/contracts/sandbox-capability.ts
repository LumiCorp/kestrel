import { createHash } from "node:crypto";
import { parseRunnerExternalApprovalBindingV1, type RunnerExternalApprovalBindingV1 } from "@kestrel-agents/protocol";

export const SANDBOX_CAPABILITY_CONTRACT_VERSION = 1 as const;
export const TAVILY_SEARCH_CAPABILITY_ID = "tavily.search.read" as const;
export const TAVILY_SEARCH_OPERATION = "search" as const;
export const TAVILY_SEARCH_RESOURCE = "https://api.tavily.com/search" as const;

export type SandboxCapabilityEffectClassV2 = "read_only" | "external_effect";

/** Generic authoring contract. V1 remains readable for durable Tavily replay. */
export interface SandboxCapabilityProfileV2 {
  version: 2;
  capabilityId: string;
  operation: string;
  resource: string;
  effectClass: SandboxCapabilityEffectClassV2;
  audience: { tenantId: string; environmentId: string };
  maxRequests: number;
  maxResponseBytes: number;
  timeoutMs: number;
  maxExpiryMs: number;
  brokerAuthority: { authorityId: string; revision: string };
  adapterConfig: Record<string, unknown>;
}

export interface SandboxCapabilitySelectionV2 {
  version: 2;
  capabilityId: string;
  operation: string;
  input: Record<string, unknown>;
}

export interface SandboxCapabilityAuthorityV2 {
  version: 2;
  capabilityId: string;
  operation: string;
  resource: string;
  effectClass: SandboxCapabilityEffectClassV2;
  tenantId: string;
  environmentId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  profileFingerprint: string;
  executionBoundaryRevision: string;
  brokerAuthority: { authorityId: string; revision: string };
  credentialReference: { credentialId: string; revision: string };
  issuedAt: string;
  expiresAt: string;
}

export interface SandboxCapabilityLeaseBindingV2 {
  version: 2;
  tenantId: string;
  environmentId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  profileFingerprint: string;
  capabilityCatalogFingerprint: string;
  executionBoundaryRevision: string;
  capabilityId: string;
  operation: string;
  resource: string;
  effectClass: SandboxCapabilityEffectClassV2;
  audience: { tenantId: string; environmentId: string };
  brokerAuthority: { authorityId: string; revision: string };
  credentialReference: { credentialId: string; revision: string };
  policyRevision: string;
  approval?: { approvalId?: string | undefined; authorityRevision: string } | undefined;
  externalApprovalBinding?: RunnerExternalApprovalBindingV1 | undefined;
  parentAuthorization?: SandboxCapabilityLeaseBindingV1["parentAuthorization"] | undefined;
}

export type SandboxCapabilityProfile = SandboxCapabilityProfileV1 | SandboxCapabilityProfileV2;
export type SandboxCapabilitySelection = SandboxCapabilitySelectionV1 | SandboxCapabilitySelectionV2;
export type SandboxCapabilityLeaseBinding = SandboxCapabilityLeaseBindingV1 | SandboxCapabilityLeaseBindingV2;

export function parseSandboxCapabilityProfileV2(value: unknown): SandboxCapabilityProfileV2 {
  const record = strictRecord(value, ["version", "capabilityId", "operation", "resource", "effectClass", "audience", "maxRequests", "maxResponseBytes", "timeoutMs", "maxExpiryMs", "brokerAuthority", "adapterConfig"], "sandbox capability profile v2");
  if (record.version !== 2) fail("sandbox capability profile v2 version is invalid");
  const resource = exactHttpsResource(record.resource, "sandbox capability profile v2 resource");
  const audience = stringPair(record.audience, "tenantId", "environmentId", "sandbox capability profile v2 audience");
  const brokerAuthority = stringPair(record.brokerAuthority, "authorityId", "revision", "sandbox capability profile v2 broker authority");
  const adapterConfig = arbitraryRecord(record.adapterConfig, "sandbox capability profile v2 adapterConfig");
  return { version: 2, capabilityId: nonEmpty(record.capabilityId, "capabilityId"), operation: nonEmpty(record.operation, "operation"), resource, effectClass: effectClassV2(record.effectClass), audience, maxRequests: boundedInt(record.maxRequests, 1, 1, "maxRequests"), maxResponseBytes: boundedInt(record.maxResponseBytes, 1, 1_000_000_000, "maxResponseBytes"), timeoutMs: boundedInt(record.timeoutMs, 100, 30_000, "timeoutMs"), maxExpiryMs: boundedInt(record.maxExpiryMs, 100, 60_000, "maxExpiryMs"), brokerAuthority, adapterConfig: canonicalClone(adapterConfig) };
}

export function parseSandboxCapabilitySelectionV2(value: unknown): SandboxCapabilitySelectionV2 {
  const record = strictRecord(value, ["version", "capabilityId", "operation", "input"], "sandbox capability selection v2");
  if (record.version !== 2) fail("sandbox capability selection v2 version is invalid");
  const input = arbitraryRecord(record.input, "sandbox capability selection v2 input");
  return { version: 2, capabilityId: nonEmpty(record.capabilityId, "capabilityId"), operation: nonEmpty(record.operation, "operation"), input: canonicalClone(input) };
}

export function parseSandboxCapabilityAuthorityV2(value: unknown): SandboxCapabilityAuthorityV2 {
  const record = strictRecord(value, ["version", "capabilityId", "operation", "resource", "effectClass", "tenantId", "environmentId", "sessionId", "runId", "toolCallId", "profileFingerprint", "executionBoundaryRevision", "brokerAuthority", "credentialReference", "issuedAt", "expiresAt"], "sandbox capability authority v2");
  if (record.version !== 2) fail("sandbox capability authority v2 version is invalid");
  const issuedAt = timestamp(record.issuedAt, "issuedAt");
  const expiresAt = timestamp(record.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) fail("sandbox capability authority expiry must follow issuance");
  return { version: 2, capabilityId: nonEmpty(record.capabilityId, "capabilityId"), operation: nonEmpty(record.operation, "operation"), resource: exactHttpsResource(record.resource, "resource"), effectClass: effectClassV2(record.effectClass), tenantId: nonEmpty(record.tenantId, "tenantId"), environmentId: nonEmpty(record.environmentId, "environmentId"), sessionId: nonEmpty(record.sessionId, "sessionId"), runId: nonEmpty(record.runId, "runId"), toolCallId: nonEmpty(record.toolCallId, "toolCallId"), profileFingerprint: hashValue(record.profileFingerprint, "profileFingerprint"), executionBoundaryRevision: nonEmpty(record.executionBoundaryRevision, "executionBoundaryRevision"), brokerAuthority: stringPair(record.brokerAuthority, "authorityId", "revision", "sandbox capability authority broker"), credentialReference: stringPair(record.credentialReference, "credentialId", "revision", "sandbox capability authority credential"), issuedAt, expiresAt };
}

export function parseSandboxCapabilityLeaseBindingV2(value: unknown): SandboxCapabilityLeaseBindingV2 {
  const record = strictRecord(value, ["version", "tenantId", "environmentId", "sessionId", "runId", "toolCallId", "profileFingerprint", "capabilityCatalogFingerprint", "executionBoundaryRevision", "capabilityId", "operation", "resource", "effectClass", "audience", "brokerAuthority", "credentialReference", "policyRevision", "approval", "externalApprovalBinding", "parentAuthorization"], "sandbox capability lease binding v2");
  if (record.version !== 2) fail("sandbox capability lease binding v2 version is invalid");
  const audience = stringPair(record.audience, "tenantId", "environmentId", "sandbox capability lease audience");
  const brokerAuthority = stringPair(record.brokerAuthority, "authorityId", "revision", "sandbox capability lease broker authority");
  const credentialReference = stringPair(record.credentialReference, "credentialId", "revision", "sandbox capability lease credential reference");
  const tenantId = nonEmpty(record.tenantId, "tenantId");
  const environmentId = nonEmpty(record.environmentId, "environmentId");
  if (tenantId !== audience.tenantId || environmentId !== audience.environmentId) fail("sandbox capability lease audience is inconsistent");
  const approval = record.approval === undefined ? undefined : (() => { const item = strictRecord(record.approval, ["approvalId", "authorityRevision"], "sandbox capability lease approval"); return { ...(item.approvalId === undefined ? {} : { approvalId: nonEmpty(item.approvalId, "approvalId") }), authorityRevision: nonEmpty(item.authorityRevision, "approval authorityRevision") }; })();
  const effectClass = effectClassV2(record.effectClass);
  const externalApprovalBinding = record.externalApprovalBinding === undefined ? undefined : parseRunnerExternalApprovalBindingV1(record.externalApprovalBinding);
  if (effectClass === "external_effect" && (approval?.approvalId === undefined || externalApprovalBinding === undefined)) fail("external-effect sandbox capability requires exact action-bound approval");
  if (externalApprovalBinding !== undefined && externalApprovalBinding.approvalId !== approval?.approvalId) fail("external-effect sandbox approval identity is inconsistent");
  const parentAuthorization = parseParentAuthorization(record.parentAuthorization);
  return { version: 2, tenantId, environmentId, sessionId: nonEmpty(record.sessionId, "sessionId"), runId: nonEmpty(record.runId, "runId"), toolCallId: nonEmpty(record.toolCallId, "toolCallId"), profileFingerprint: hashValue(record.profileFingerprint, "profileFingerprint"), capabilityCatalogFingerprint: hashValue(record.capabilityCatalogFingerprint, "capabilityCatalogFingerprint"), executionBoundaryRevision: nonEmpty(record.executionBoundaryRevision, "executionBoundaryRevision"), capabilityId: nonEmpty(record.capabilityId, "capabilityId"), operation: nonEmpty(record.operation, "operation"), resource: exactHttpsResource(record.resource, "resource"), effectClass, audience, brokerAuthority, credentialReference, policyRevision: nonEmpty(record.policyRevision, "policyRevision"), ...(approval === undefined ? {} : { approval }), ...(externalApprovalBinding === undefined ? {} : { externalApprovalBinding }), ...(parentAuthorization === undefined ? {} : { parentAuthorization }) };
}

export function fingerprintSandboxCapabilityProfileV2(value: unknown): string {
  return createHash("sha256").update(canonical(parseSandboxCapabilityProfileV2(value))).digest("hex");
}

export function fingerprintSandboxCapabilityLeaseBindingV2(value: unknown): string {
  return createHash("sha256").update(canonical(parseSandboxCapabilityLeaseBindingV2(value))).digest("hex");
}

export interface SandboxCapabilityProfileV1 {
  version: 1;
  capabilityId: typeof TAVILY_SEARCH_CAPABILITY_ID;
  operations: [typeof TAVILY_SEARCH_OPERATION];
  resource: typeof TAVILY_SEARCH_RESOURCE;
  audience: { tenantId: string; environmentId: string };
  maxRequests: 1;
  maxQueryChars: number;
  maxResults: number;
  maxResponseBytes: number;
  timeoutMs: number;
  maxExpiryMs: number;
  brokerAuthority: { authorityId: string; revision: string };
}

export interface SandboxCapabilitySelectionV1 {
  capabilityId: typeof TAVILY_SEARCH_CAPABILITY_ID;
  input: { query: string; maxResults?: number | undefined };
}

export interface SandboxCapabilityAuthorityV1 {
  version: 1;
  tenantId: string;
  environmentId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  profileFingerprint: string;
  executionBoundaryRevision: string;
  brokerAuthority: { authorityId: string; revision: string };
  credentialReference: { credentialId: "tool.tavily.default"; revision: string };
  issuedAt: string;
  expiresAt: string;
}

export interface TavilySearchAdapterRequestV1 {
  version: 1;
  operation: typeof TAVILY_SEARCH_OPERATION;
  resource: typeof TAVILY_SEARCH_RESOURCE;
  input: { query: string; maxResults: number };
  authority: SandboxCapabilityAuthorityV1;
}

export interface TavilySearchAdapterResponseV1 {
  version: 1;
  results: Array<{ title: string; url: string; content: string }>;
}

export const SANDBOX_CAPABILITY_LEASE_LIFECYCLE_VERSION = 1 as const;
export type SandboxCapabilityLeaseTransitionV1 =
  | "requested" | "denied" | "issued" | "invoking" | "consumed" | "exhausted"
  | "revoked" | "expired" | "cancelled" | "cleaned";
export type SandboxCapabilityLeaseTerminalOutcomeV1 =
  | "denied" | "completed" | "failed" | "exhausted" | "revoked" | "expired" | "cancelled";

export interface SandboxCapabilityLeaseBindingV1 {
  version: 1;
  tenantId: string;
  environmentId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  profileFingerprint: string;
  capabilityCatalogFingerprint: string;
  executionBoundaryRevision: string;
  capabilityId: typeof TAVILY_SEARCH_CAPABILITY_ID;
  operation: typeof TAVILY_SEARCH_OPERATION;
  resource: typeof TAVILY_SEARCH_RESOURCE;
  audience: { tenantId: string; environmentId: string };
  brokerAuthority: { authorityId: string; revision: string };
  credentialReference: { credentialId: "tool.tavily.default"; revision: string };
  policyRevision: string;
  approval?: { approvalId?: string | undefined; authorityRevision: string } | undefined;
  parentAuthorization?: {
    leaseId: string;
    bindingDigest: string;
    authorizationDecisionId: string;
    reservationId: string;
    requestLimit: number;
    responseByteLimit: number;
  } | undefined;
}

export type SandboxCapabilityChildReservationStatusV1 = "reserved" | "committed" | "released" | "revoked";
export interface SandboxCapabilityChildAuthorizationDecisionV1 {
  version: 1;
  decisionId: string;
  parentLeaseId: string;
  parentBindingDigest: string;
  childSessionId: string;
  childRunId: string;
  childToolCallId: string;
  policyRevision: string;
  approval: { approvalId?: string | undefined; authorityRevision: string };
  requestLimit: number;
  responseByteLimit: number;
  decidedAt: string;
}
export interface SandboxCapabilityChildReservationV1 {
  version: 1;
  reservationId: string;
  sequence: number;
  status: SandboxCapabilityChildReservationStatusV1;
  decision: SandboxCapabilityChildAuthorizationDecisionV1;
  requestsCommitted: number;
  responseBytesCommitted: number;
  reason?: string | undefined;
  occurredAt: string;
}

export function parseSandboxCapabilityChildReservationV1(value: unknown): SandboxCapabilityChildReservationV1 {
  const record = strictRecord(value, ["version", "reservationId", "sequence", "status", "decision", "requestsCommitted", "responseBytesCommitted", "reason", "occurredAt"], "sandbox capability child reservation");
  if (record.version !== 1) fail("sandbox capability child reservation version is invalid");
  const decision = parseSandboxCapabilityChildAuthorizationDecisionV1(record.decision);
  const statuses: SandboxCapabilityChildReservationStatusV1[] = ["reserved", "committed", "released", "revoked"];
  if (statuses.includes(record.status as SandboxCapabilityChildReservationStatusV1) === false) fail("sandbox capability child reservation status is invalid");
  const requestsCommitted = boundedInt(record.requestsCommitted, 0, decision.requestLimit, "child requestsCommitted");
  const responseBytesCommitted = boundedInt(record.responseBytesCommitted, 0, decision.responseByteLimit, "child responseBytesCommitted");
  if (record.status === "reserved" && (requestsCommitted !== 0 || responseBytesCommitted !== 0)) fail("reserved child authorization cannot contain committed usage");
  return { version: 1, reservationId: nonEmpty(record.reservationId, "child reservationId"), sequence: boundedInt(record.sequence, 1, Number.MAX_SAFE_INTEGER, "child reservation sequence"), status: record.status as SandboxCapabilityChildReservationStatusV1, decision, requestsCommitted, responseBytesCommitted, ...(record.reason === undefined ? {} : { reason: nonEmpty(record.reason, "child reservation reason") }), occurredAt: timestamp(record.occurredAt, "child reservation occurredAt") };
}

export function parseSandboxCapabilityChildAuthorizationDecisionV1(value: unknown): SandboxCapabilityChildAuthorizationDecisionV1 {
  const record = strictRecord(value, ["version", "decisionId", "parentLeaseId", "parentBindingDigest", "childSessionId", "childRunId", "childToolCallId", "policyRevision", "approval", "requestLimit", "responseByteLimit", "decidedAt"], "sandbox capability child authorization decision");
  if (record.version !== 1) fail("sandbox capability child authorization decision version is invalid");
  const approvalRecord = strictRecord(record.approval, ["approvalId", "authorityRevision"], "sandbox capability child approval");
  return { version: 1, decisionId: nonEmpty(record.decisionId, "child decisionId"), parentLeaseId: nonEmpty(record.parentLeaseId, "child parentLeaseId"), parentBindingDigest: hashValue(record.parentBindingDigest, "child parentBindingDigest"), childSessionId: nonEmpty(record.childSessionId, "child sessionId"), childRunId: nonEmpty(record.childRunId, "child runId"), childToolCallId: nonEmpty(record.childToolCallId, "child toolCallId"), policyRevision: nonEmpty(record.policyRevision, "child policyRevision"), approval: { ...(approvalRecord.approvalId === undefined ? {} : { approvalId: nonEmpty(approvalRecord.approvalId, "child approvalId") }), authorityRevision: nonEmpty(approvalRecord.authorityRevision, "child approval authorityRevision") }, requestLimit: boundedInt(record.requestLimit, 1, 1_000_000, "child requestLimit"), responseByteLimit: boundedInt(record.responseByteLimit, 1, 1_000_000_000, "child responseByteLimit"), decidedAt: timestamp(record.decidedAt, "child decidedAt") };
}

export interface SandboxCapabilityLeaseUsageV1 {
  requestLimit: number;
  requestsConsumed: number;
  responseByteLimit: number;
  responseBytesConsumed: number;
  /** Null means the provider did not return an exact usage measurement. */
  exactProviderUsage: number | null;
}

export interface SandboxCapabilityLeaseResultEvidenceV1 {
  digest: string;
  reference: string;
}

export interface SandboxCapabilityLeaseTransitionRecordV1 {
  version: 1;
  leaseId: string;
  sequence: number;
  transition: SandboxCapabilityLeaseTransitionV1;
  binding: SandboxCapabilityLeaseBinding;
  bindingDigest: string;
  usage: SandboxCapabilityLeaseUsageV1;
  issuedAt?: string | undefined;
  expiresAt: string;
  terminalOutcome?: SandboxCapabilityLeaseTerminalOutcomeV1 | undefined;
  terminalReason?: string | undefined;
  cleanedAt?: string | undefined;
  result?: SandboxCapabilityLeaseResultEvidenceV1 | undefined;
  occurredAt: string;
}

export function parseSandboxCapabilityLeaseTransitionRecordV1(value: unknown): SandboxCapabilityLeaseTransitionRecordV1 {
  const record = strictRecord(value, ["version", "leaseId", "sequence", "transition", "binding", "bindingDigest", "usage", "issuedAt", "expiresAt", "terminalOutcome", "terminalReason", "cleanedAt", "result", "occurredAt"], "sandbox capability lease transition");
  if (record.version !== SANDBOX_CAPABILITY_LEASE_LIFECYCLE_VERSION) fail("sandbox capability lease transition version is invalid");
  const transition = leaseTransition(record.transition);
  const binding = parseSandboxCapabilityLeaseBinding(record.binding);
  const usageRecord = strictRecord(record.usage, ["requestLimit", "requestsConsumed", "responseByteLimit", "responseBytesConsumed", "exactProviderUsage"], "sandbox capability lease usage");
  const usage: SandboxCapabilityLeaseUsageV1 = {
    requestLimit: boundedInt(usageRecord.requestLimit, 1, 1_000_000, "requestLimit"),
    requestsConsumed: boundedInt(usageRecord.requestsConsumed, 0, 1_000_000, "requestsConsumed"),
    responseByteLimit: boundedInt(usageRecord.responseByteLimit, 1, 1_000_000_000, "responseByteLimit"),
    responseBytesConsumed: boundedInt(usageRecord.responseBytesConsumed, 0, 1_000_000_000, "responseBytesConsumed"),
    exactProviderUsage: usageRecord.exactProviderUsage === null ? null : boundedInt(usageRecord.exactProviderUsage, 0, 1_000_000_000, "exactProviderUsage"),
  };
  if (usage.requestsConsumed > usage.requestLimit || usage.responseBytesConsumed > usage.responseByteLimit) fail("sandbox capability lease usage exceeds its ceiling");
  const terminalOutcome = record.terminalOutcome === undefined ? undefined : leaseTerminalOutcome(record.terminalOutcome);
  const cleanedAt = optionalTimestamp(record.cleanedAt, "cleanedAt");
  if (transition === "cleaned" && cleanedAt === undefined) fail("cleaned lease transition requires cleanedAt");
  const result = record.result === undefined ? undefined : parseLeaseResult(record.result);
  return {
    version: 1,
    leaseId: nonEmpty(record.leaseId, "sandbox capability lease ID"),
    sequence: boundedInt(record.sequence, 1, Number.MAX_SAFE_INTEGER, "sandbox capability lease sequence"),
    transition,
    binding,
    bindingDigest: hashValue(record.bindingDigest, "sandbox capability binding digest"),
    usage,
    ...(record.issuedAt === undefined ? {} : { issuedAt: timestamp(record.issuedAt, "issuedAt") }),
    expiresAt: timestamp(record.expiresAt, "expiresAt"),
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
    ...(record.terminalReason === undefined ? {} : { terminalReason: nonEmpty(record.terminalReason, "terminalReason") }),
    ...(cleanedAt === undefined ? {} : { cleanedAt }),
    ...(result === undefined ? {} : { result }),
    occurredAt: timestamp(record.occurredAt, "occurredAt"),
  };
}

export function parseSandboxCapabilityLeaseBindingV1(value: unknown): SandboxCapabilityLeaseBindingV1 {
  const record = strictRecord(value, ["version", "tenantId", "environmentId", "sessionId", "runId", "toolCallId", "profileFingerprint", "capabilityCatalogFingerprint", "executionBoundaryRevision", "capabilityId", "operation", "resource", "audience", "brokerAuthority", "credentialReference", "policyRevision", "approval", "parentAuthorization"], "sandbox capability lease binding");
  if (record.version !== 1 || record.capabilityId !== TAVILY_SEARCH_CAPABILITY_ID || record.operation !== TAVILY_SEARCH_OPERATION || record.resource !== TAVILY_SEARCH_RESOURCE) fail("sandbox capability lease binding constants are invalid");
  const audience = stringPair(record.audience, "tenantId", "environmentId", "sandbox capability lease audience");
  const brokerAuthority = stringPair(record.brokerAuthority, "authorityId", "revision", "sandbox capability lease broker authority");
  const credentialReference = stringPair(record.credentialReference, "credentialId", "revision", "sandbox capability lease credential reference");
  if (credentialReference.credentialId !== "tool.tavily.default") fail("sandbox capability lease credential reference is invalid");
  const approval = record.approval === undefined ? undefined : (() => { const item = strictRecord(record.approval, ["approvalId", "authorityRevision"], "sandbox capability lease approval"); return { ...(item.approvalId === undefined ? {} : { approvalId: nonEmpty(item.approvalId, "approvalId") }), authorityRevision: nonEmpty(item.authorityRevision, "approval authorityRevision") }; })();
  const parentAuthorization = parseParentAuthorization(record.parentAuthorization);
  const output: SandboxCapabilityLeaseBindingV1 = { version: 1, tenantId: nonEmpty(record.tenantId, "tenantId"), environmentId: nonEmpty(record.environmentId, "environmentId"), sessionId: nonEmpty(record.sessionId, "sessionId"), runId: nonEmpty(record.runId, "runId"), toolCallId: nonEmpty(record.toolCallId, "toolCallId"), profileFingerprint: hashValue(record.profileFingerprint, "profileFingerprint"), capabilityCatalogFingerprint: hashValue(record.capabilityCatalogFingerprint, "capabilityCatalogFingerprint"), executionBoundaryRevision: nonEmpty(record.executionBoundaryRevision, "executionBoundaryRevision"), capabilityId: TAVILY_SEARCH_CAPABILITY_ID, operation: TAVILY_SEARCH_OPERATION, resource: TAVILY_SEARCH_RESOURCE, audience, brokerAuthority, credentialReference: { credentialId: "tool.tavily.default", revision: credentialReference.revision }, policyRevision: nonEmpty(record.policyRevision, "policyRevision"), ...(approval === undefined ? {} : { approval }), ...(parentAuthorization === undefined ? {} : { parentAuthorization }) };
  if (output.tenantId !== audience.tenantId || output.environmentId !== audience.environmentId) fail("sandbox capability lease audience is inconsistent");
  return output;
}

export function fingerprintSandboxCapabilityLeaseBindingV1(value: unknown): string {
  return createHash("sha256").update(canonical(parseSandboxCapabilityLeaseBindingV1(value))).digest("hex");
}

export function parseSandboxCapabilityLeaseBinding(value: unknown): SandboxCapabilityLeaseBinding {
  const version = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { version?: unknown }).version : undefined;
  return version === 2 ? parseSandboxCapabilityLeaseBindingV2(value) : parseSandboxCapabilityLeaseBindingV1(value);
}

export function fingerprintSandboxCapabilityLeaseBinding(value: unknown): string {
  return createHash("sha256").update(canonical(parseSandboxCapabilityLeaseBinding(value))).digest("hex");
}

export function assertSandboxCapabilityLeaseTransitionV1(
  previous: SandboxCapabilityLeaseTransitionV1 | undefined,
  next: SandboxCapabilityLeaseTransitionV1,
): void {
  const allowed: Record<string, SandboxCapabilityLeaseTransitionV1[]> = {
    start: ["requested"],
    requested: ["denied", "issued", "revoked", "expired", "cancelled"],
    denied: ["cleaned"],
    issued: ["invoking", "revoked", "expired", "cancelled"],
    invoking: ["consumed", "exhausted", "revoked", "expired", "cancelled"],
    consumed: ["exhausted", "revoked", "expired", "cancelled", "cleaned"],
    exhausted: ["revoked", "expired", "cancelled", "cleaned"], revoked: ["cleaned"], expired: ["cleaned"], cancelled: ["cleaned"], cleaned: [],
  };
  if ((allowed[previous ?? "start"] ?? []).includes(next) === false) {
    fail(`sandbox capability lease transition '${previous ?? "start"}' -> '${next}' is invalid`);
  }
}

function leaseTransition(value: unknown): SandboxCapabilityLeaseTransitionV1 { const values: SandboxCapabilityLeaseTransitionV1[] = ["requested", "denied", "issued", "invoking", "consumed", "exhausted", "revoked", "expired", "cancelled", "cleaned"]; if (values.includes(value as SandboxCapabilityLeaseTransitionV1) === false) fail("sandbox capability lease transition is invalid"); return value as SandboxCapabilityLeaseTransitionV1; }
function leaseTerminalOutcome(value: unknown): SandboxCapabilityLeaseTerminalOutcomeV1 { const values: SandboxCapabilityLeaseTerminalOutcomeV1[] = ["denied", "completed", "failed", "exhausted", "revoked", "expired", "cancelled"]; if (values.includes(value as SandboxCapabilityLeaseTerminalOutcomeV1) === false) fail("sandbox capability lease terminal outcome is invalid"); return value as SandboxCapabilityLeaseTerminalOutcomeV1; }
function timestamp(value: unknown, label: string): string { const text = nonEmpty(value, label); if (Number.isFinite(Date.parse(text)) === false) fail(`${label} must be a timestamp`); return new Date(text).toISOString(); }
function optionalTimestamp(value: unknown, label: string): string | undefined { return value === undefined ? undefined : timestamp(value, label); }
function hashValue(value: unknown, label: string): string { const text = nonEmpty(value, label); if (/^(?:sha256:)?[a-f0-9]{64}$/u.test(text) === false) fail(`${label} must be a SHA-256 digest`); return text; }
function parseParentAuthorization(value: unknown): NonNullable<SandboxCapabilityLeaseBindingV1["parentAuthorization"]> | undefined { if (value === undefined) return; const item = strictRecord(value, ["leaseId", "bindingDigest", "authorizationDecisionId", "reservationId", "requestLimit", "responseByteLimit"], "sandbox capability parent authorization"); return { leaseId: nonEmpty(item.leaseId, "parent leaseId"), bindingDigest: hashValue(item.bindingDigest, "parent bindingDigest"), authorizationDecisionId: nonEmpty(item.authorizationDecisionId, "parent authorizationDecisionId"), reservationId: nonEmpty(item.reservationId, "parent reservationId"), requestLimit: boundedInt(item.requestLimit, 1, 1_000_000, "parent requestLimit"), responseByteLimit: boundedInt(item.responseByteLimit, 1, 1_000_000_000, "parent responseByteLimit") }; }
function effectClassV2(value: unknown): SandboxCapabilityEffectClassV2 { if (value !== "read_only" && value !== "external_effect") fail("sandbox capability effectClass is invalid"); return value; }
function exactHttpsResource(value: unknown, label: string): string { const text = nonEmpty(value, label); let parsed: URL; try { parsed = new URL(text); } catch { fail(`${label} must be an exact HTTPS URL`); } if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") fail(`${label} must be an exact credential-free HTTPS URL`); return parsed.toString(); }
function canonicalClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function parseLeaseResult(value: unknown): SandboxCapabilityLeaseResultEvidenceV1 { const record = strictRecord(value, ["digest", "reference"], "sandbox capability lease result evidence"); return { digest: hashValue(record.digest, "result digest"), reference: nonEmpty(record.reference, "result reference") }; }

export function parseSandboxCapabilityProfileV1(value: unknown): SandboxCapabilityProfileV1 {
  const record = strictRecord(value, ["version", "capabilityId", "operations", "resource", "audience", "maxRequests", "maxQueryChars", "maxResults", "maxResponseBytes", "timeoutMs", "maxExpiryMs", "brokerAuthority"], "sandbox capability profile");
  if (record.version !== 1 || record.capabilityId !== TAVILY_SEARCH_CAPABILITY_ID || record.resource !== TAVILY_SEARCH_RESOURCE || record.maxRequests !== 1) fail("sandbox capability profile constants are invalid");
  if (Array.isArray(record.operations) === false || record.operations.length !== 1 || record.operations[0] !== TAVILY_SEARCH_OPERATION) fail("sandbox capability operations must be exactly search");
  const audienceRecord = stringPair(record.audience, "tenantId", "environmentId", "sandbox capability audience");
  const brokerRecord = stringPair(record.brokerAuthority, "authorityId", "revision", "sandbox broker authority");
  const audience = { tenantId: audienceRecord.tenantId, environmentId: audienceRecord.environmentId };
  const brokerAuthority = { authorityId: brokerRecord.authorityId, revision: brokerRecord.revision };
  return {
    version: 1,
    capabilityId: TAVILY_SEARCH_CAPABILITY_ID,
    operations: [TAVILY_SEARCH_OPERATION],
    resource: TAVILY_SEARCH_RESOURCE,
    audience,
    maxRequests: 1,
    maxQueryChars: boundedInt(record.maxQueryChars, 1, 400, "maxQueryChars"),
    maxResults: boundedInt(record.maxResults, 1, 20, "maxResults"),
    maxResponseBytes: boundedInt(record.maxResponseBytes, 256, 64_000, "maxResponseBytes"),
    timeoutMs: boundedInt(record.timeoutMs, 100, 30_000, "timeoutMs"),
    maxExpiryMs: boundedInt(record.maxExpiryMs, 100, 60_000, "maxExpiryMs"),
    brokerAuthority,
  };
}

export function parseSandboxCapabilityProfilesV1(value: unknown): SandboxCapabilityProfileV1[] {
  if (Array.isArray(value) === false) fail("sandbox capability profiles must be an array");
  const profiles = value.map(parseSandboxCapabilityProfileV1);
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.capabilityId)) fail(`duplicate sandbox capability ID '${profile.capabilityId}'`);
    seen.add(profile.capabilityId);
  }
  return profiles;
}

export function normalizeSandboxCapabilityProfileV2(value: unknown): SandboxCapabilityProfileV2 {
  const version = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { version?: unknown }).version : undefined;
  if (version === 2) return parseSandboxCapabilityProfileV2(value);
  const legacy = parseSandboxCapabilityProfileV1(value);
  return {
    version: 2,
    capabilityId: legacy.capabilityId,
    operation: legacy.operations[0],
    resource: legacy.resource,
    effectClass: "read_only",
    audience: legacy.audience,
    maxRequests: legacy.maxRequests,
    maxResponseBytes: legacy.maxResponseBytes,
    timeoutMs: legacy.timeoutMs,
    maxExpiryMs: legacy.maxExpiryMs,
    brokerAuthority: legacy.brokerAuthority,
    adapterConfig: { maxQueryChars: legacy.maxQueryChars, maxResults: legacy.maxResults },
  };
}

export function normalizeSandboxCapabilityProfilesV2(value: unknown): SandboxCapabilityProfileV2[] {
  if (!Array.isArray(value)) fail("sandbox capability profiles must be an array");
  const profiles = value.map(normalizeSandboxCapabilityProfileV2);
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.capabilityId)) fail(`duplicate sandbox capability ID '${profile.capabilityId}'`);
    seen.add(profile.capabilityId);
  }
  return profiles;
}

export function parseSandboxCapabilitySelectionV1(value: unknown): SandboxCapabilitySelectionV1 {
  const record = strictRecord(value, ["capabilityId", "input"], "sandbox capability selection");
  if (record.capabilityId !== TAVILY_SEARCH_CAPABILITY_ID) fail("unknown sandbox capability ID");
  const input = strictRecord(record.input, ["query", "maxResults"], "sandbox capability input");
  const query = nonEmpty(input.query, "sandbox capability query");
  return {
    capabilityId: TAVILY_SEARCH_CAPABILITY_ID,
    input: {
      query,
      ...(input.maxResults === undefined ? {} : { maxResults: boundedInt(input.maxResults, 1, 20, "maxResults") }),
    },
  };
}

export function normalizeSandboxCapabilitySelectionV2(value: unknown): SandboxCapabilitySelectionV2 {
  const version = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { version?: unknown }).version : undefined;
  if (version === 2) return parseSandboxCapabilitySelectionV2(value);
  const legacy = parseSandboxCapabilitySelectionV1(value);
  return { version: 2, capabilityId: legacy.capabilityId, operation: TAVILY_SEARCH_OPERATION, input: legacy.input };
}

export function fingerprintSandboxCapabilityProfileV1(profile: SandboxCapabilityProfileV1): string {
  return createHash("sha256").update(canonical(profile)).digest("hex");
}

export function fingerprintSandboxCapabilityCatalogV1(value: unknown): string {
  return createHash("sha256").update(canonical(parseSandboxCapabilityProfilesV1(value))).digest("hex");
}

export function fingerprintSandboxCapabilityCatalogV2(value: unknown): string {
  return createHash("sha256").update(canonical(normalizeSandboxCapabilityProfilesV2(value))).digest("hex");
}

function strictRecord(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => allowed.includes(key) === false);
  if (unknown.length > 0) fail(`${label} contains unknown field '${unknown[0]}'`);
  return record;
}
function arbitraryRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function stringPair<L extends string, R extends string>(value: unknown, left: L, right: R, label: string): Record<L | R, string> {
  const record = strictRecord(value, [left, right], label);
  return { [left]: nonEmpty(record[left], `${label}.${left}`), [right]: nonEmpty(record[right], `${label}.${right}`) } as Record<L | R, string>;
}
function nonEmpty(value: unknown, label: string): string { if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be non-empty`); return value.trim(); }
function boundedInt(value: unknown, min: number, max: number, label: string): number { if (typeof value !== "number" || Number.isSafeInteger(value) === false || value < min || value > max) fail(`${label} is outside its allowed range`); return value; }
function fail(message: string): never { throw new Error(message); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
