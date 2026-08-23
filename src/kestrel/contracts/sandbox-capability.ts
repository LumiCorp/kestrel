import { createHash } from "node:crypto";

export const SANDBOX_CAPABILITY_CONTRACT_VERSION = 1 as const;
export const TAVILY_SEARCH_CAPABILITY_ID = "tavily.search.read" as const;
export const TAVILY_SEARCH_OPERATION = "search" as const;
export const TAVILY_SEARCH_RESOURCE = "https://api.tavily.com/search" as const;

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

export function fingerprintSandboxCapabilityProfileV1(profile: SandboxCapabilityProfileV1): string {
  return createHash("sha256").update(canonical(profile)).digest("hex");
}

export function fingerprintSandboxCapabilityCatalogV1(value: unknown): string {
  return createHash("sha256").update(canonical(parseSandboxCapabilityProfilesV1(value))).digest("hex");
}

function strictRecord(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => allowed.includes(key) === false);
  if (unknown.length > 0) fail(`${label} contains unknown field '${unknown[0]}'`);
  return record;
}
function stringPair<L extends string, R extends string>(value: unknown, left: L, right: R, label: string): Record<L | R, string> {
  const record = strictRecord(value, [left, right], label);
  return { [left]: nonEmpty(record[left], `${label}.${left}`), [right]: nonEmpty(record[right], `${label}.${right}`) } as Record<L | R, string>;
}
function nonEmpty(value: unknown, label: string): string { if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be non-empty`); return value.trim(); }
function boundedInt(value: unknown, min: number, max: number, label: string): number { if (typeof value !== "number" || Number.isSafeInteger(value) === false || value < min || value > max) fail(`${label} is outside its allowed range`); return value; }
function fail(message: string): never { throw new Error(message); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
