import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";

import { parse as parseDomain } from "tldts";

import { hashCanonical } from "../kestrel/contracts/tool-contract.js";
import type { BrowserMode } from "./contracts.js";

export const BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION =
  "browser_public_domain_authority_v1" as const;
export const BROWSER_ENVIRONMENT_DOMAIN_AUTHORITY_VERSION =
  "browser_environment_domain_authority_v1" as const;
export const BROWSER_PROJECT_DOMAIN_AUTHORITY_VERSION =
  "browser_project_domain_authority_v1" as const;
export const BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION =
  "browser_personal_domain_authority_v1" as const;
export const BROWSER_QA_DOMAIN_AUTHORITY_VERSION =
  "browser_qa_domain_authority_v1" as const;
export const BROWSER_QA_TARGET_VERSION = "browser_qa_target_v1" as const;
export const BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION =
  "browser_effective_domain_authority_v1" as const;
export const BROWSER_PUBLIC_GRANT_DECISION_VERSION =
  "browser_public_grant_decision_v1" as const;

export interface BrowserPublicDomainAuthorityV1 {
  version: typeof BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION;
  scheme: "https";
  canonicalDomain: string;
  includeSubdomains: true;
  port: 443;
}

export interface BrowserEnvironmentDomainAuthorityV1 {
  version: typeof BROWSER_ENVIRONMENT_DOMAIN_AUTHORITY_VERSION;
  environmentId: string;
  revision: string;
  enabledModes: readonly BrowserMode[];
  personalGrantsEnabled: boolean;
  configuredPublicDomains: readonly BrowserPublicDomainAuthorityV1[];
  blockedPublicDomains: readonly BrowserPublicDomainAuthorityV1[];
}

export interface BrowserProjectDomainAuthorityV1 {
  version: typeof BROWSER_PROJECT_DOMAIN_AUTHORITY_VERSION;
  projectId: string;
  revision: string;
  enabledModes: readonly BrowserMode[];
  personalGrantsEnabled: boolean;
  blockedPublicDomains: readonly BrowserPublicDomainAuthorityV1[];
}

export interface BrowserPersonalDomainAuthorityV1 {
  version: typeof BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION;
  userId: string;
  environmentId: string;
  revision: string;
  activeDomains: readonly BrowserPublicDomainAuthorityV1[];
}

export interface BrowserQaTargetV1 {
  version: typeof BROWSER_QA_TARGET_VERSION;
  scheme: "http" | "https";
  hostname: string;
  port: number;
}

export interface BrowserQaDomainAuthorityV1 {
  version: typeof BROWSER_QA_DOMAIN_AUTHORITY_VERSION;
  revision: string;
  target: BrowserQaTargetV1 | null;
}

export interface BrowserEffectiveDomainAuthorityV1 {
  version: typeof BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION;
  environmentId: string;
  projectId: string;
  userId: string;
  enabledModes: readonly BrowserMode[];
  personalGrantsEnabled: boolean;
  publicDomains: readonly BrowserPublicDomainAuthorityV1[];
  qaTarget: BrowserQaTargetV1 | null;
  effectiveAllowlistRevision: string;
}

export interface BrowserDomainAuthorityInputV1 {
  environment: BrowserEnvironmentDomainAuthorityV1;
  project: BrowserProjectDomainAuthorityV1;
  personal: BrowserPersonalDomainAuthorityV1;
  qa: BrowserQaDomainAuthorityV1;
}

export interface BrowserPublicGrantDecisionV1 {
  version: typeof BROWSER_PUBLIC_GRANT_DECISION_VERSION;
  decision: "already_allowed" | "approval_required" | "blocked";
  authority: BrowserPublicDomainAuthorityV1;
  effectiveAllowlistRevision: string;
}

/**
 * Converts one public destination into its tenant boundary. The PSL lookup uses
 * private suffixes so, for example, tenant.vercel.app cannot authorize another
 * tenant under vercel.app.
 */
export function canonicalizePublicBrowserDestination(
  destination: string,
): BrowserPublicDomainAuthorityV1 {
  const raw = nonEmptyString(destination, "destination");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidDestination("Destination must be an absolute HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw invalidDestination("Public Browser destinations must use HTTPS.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalidDestination("Public Browser destinations cannot contain credentials.");
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    throw invalidDestination("Public Browser destinations must use port 443.");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (isIpLiteral(hostname)) {
    throw invalidDestination("Public Browser grants cannot target an IP literal.");
  }
  if (isReservedHostname(hostname)) {
    throw invalidDestination("The destination is local, private, metadata, or reserved.");
  }

  const result = parseDomain(hostname, { allowPrivateDomains: true });
  const canonicalDomain = result.domain?.toLowerCase();
  if (canonicalDomain === undefined || canonicalDomain === "") {
    throw invalidDestination(
      result.publicSuffix === hostname
        ? "A public suffix cannot become a Browser grant."
        : "Destination does not have a registrable public domain.",
    );
  }
  if (isReservedHostname(canonicalDomain)) {
    throw invalidDestination("The destination is local, private, metadata, or reserved.");
  }

  return {
    version: BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
    scheme: "https",
    canonicalDomain,
    includeSubdomains: true,
    port: 443,
  };
}

/** Canonicalizes a trusted QA origin without converting it into public authority. */
export function canonicalizeTrustedBrowserQaTarget(destination: string): BrowserQaTargetV1 {
  const raw = nonEmptyString(destination, "destination");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Trusted Browser QA target must be an absolute HTTP or HTTPS URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Trusted Browser QA target must use HTTP or HTTPS.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Trusted Browser QA target cannot contain credentials.");
  }
  const hostname = normalizeHostname(parsed.hostname);
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Trusted Browser QA target port is invalid.");
  }
  return {
    version: BROWSER_QA_TARGET_VERSION,
    scheme: parsed.protocol === "https:" ? "https" : "http",
    hostname,
    port,
  };
}

export function resolveEffectiveBrowserDomainAuthority(
  input: BrowserDomainAuthorityInputV1,
): BrowserEffectiveDomainAuthorityV1 {
  validateAuthorityInput(input);

  const enabledModes = input.project.enabledModes
    .filter((mode) => input.environment.enabledModes.includes(mode))
    .slice()
    .sort(compareStrings);
  const operatorEnabled = enabledModes.includes("operator");
  const personalGrantsEnabled =
    operatorEnabled &&
    input.environment.personalGrantsEnabled &&
    input.project.personalGrantsEnabled;
  const blocked = new Set([
    ...input.environment.blockedPublicDomains.map(domainKey),
    ...input.project.blockedPublicDomains.map(domainKey),
  ]);
  const candidates = [
    ...(operatorEnabled ? input.environment.configuredPublicDomains : []),
    ...(personalGrantsEnabled ? input.personal.activeDomains : []),
  ];
  const publicDomains = uniqueSortedDomains(
    candidates.filter((domain) => !blocked.has(domainKey(domain))),
  );
  const qaTarget = enabledModes.includes("qa") ? input.qa.target : null;

  const revisionProjection = {
    version: BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
    environment: canonicalEnvironment(input.environment),
    project: canonicalProject(input.project),
    personal: canonicalPersonal(input.personal),
    qa: canonicalQa(input.qa),
  };

  return {
    version: BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
    environmentId: input.environment.environmentId,
    projectId: input.project.projectId,
    userId: input.personal.userId,
    enabledModes,
    personalGrantsEnabled,
    publicDomains,
    qaTarget,
    effectiveAllowlistRevision: hashCanonical(revisionProjection),
  };
}

export function browserPublicDomainAllowsHostname(
  authority: BrowserPublicDomainAuthorityV1,
  hostname: string,
): boolean {
  validatePublicDomain(authority, "authority");
  const candidate = normalizeHostname(hostname);
  return (
    candidate === authority.canonicalDomain ||
    candidate.endsWith(`.${authority.canonicalDomain}`)
  );
}

export function effectiveBrowserAuthorityAllowsPublicDestination(
  authority: BrowserEffectiveDomainAuthorityV1,
  destination: string,
): boolean {
  const canonical = canonicalizePublicBrowserDestination(destination);
  return authority.publicDomains.some(
    (entry) => entry.canonicalDomain === canonical.canonicalDomain,
  );
}

export function resolveBrowserPublicGrantDecision(
  input: BrowserDomainAuthorityInputV1,
  destination: string,
): BrowserPublicGrantDecisionV1 {
  const authority = canonicalizePublicBrowserDestination(destination);
  const effective = resolveEffectiveBrowserDomainAuthority(input);
  const key = domainKey(authority);
  const decision = effective.publicDomains.some((entry) => domainKey(entry) === key)
    ? "already_allowed"
    : !effective.personalGrantsEnabled ||
        input.environment.blockedPublicDomains.some((entry) => domainKey(entry) === key) ||
        input.project.blockedPublicDomains.some((entry) => domainKey(entry) === key)
      ? "blocked"
      : "approval_required";
  return {
    version: BROWSER_PUBLIC_GRANT_DECISION_VERSION,
    decision,
    authority,
    effectiveAllowlistRevision: effective.effectiveAllowlistRevision,
  };
}

/**
 * DNS results must pass this check at connection time and after every
 * resolution. Canonical domain authority alone never authorizes an address.
 */
export function assertPublicBrowserResolvedAddresses(
  addresses: readonly string[],
): void {
  if (addresses.length === 0) {
    throw invalidDestination("Destination did not resolve to a public network address.");
  }
  for (const address of addresses) {
    const family = isIP(address);
    if (
      family === 0 ||
      RESERVED_NETWORKS.check(address, family === 4 ? "ipv4" : "ipv6")
    ) {
      throw invalidDestination(
        "Destination resolved to a private, local, link-local, metadata, or reserved address.",
      );
    }
  }
}

function validateAuthorityInput(input: BrowserDomainAuthorityInputV1): void {
  exactKeys(input as unknown, ["environment", "project", "personal", "qa"], "BrowserDomainAuthorityInputV1");
  const environment = input.environment;
  exactKeys(environment, [
    "version",
    "environmentId",
    "revision",
    "enabledModes",
    "personalGrantsEnabled",
    "configuredPublicDomains",
    "blockedPublicDomains",
  ], "BrowserEnvironmentDomainAuthorityV1");
  if (environment.version !== BROWSER_ENVIRONMENT_DOMAIN_AUTHORITY_VERSION) {
    throw new Error("Browser Environment authority version is invalid.");
  }
  nonEmptyString(environment.environmentId, "environment.environmentId");
  nonEmptyString(environment.revision, "environment.revision");
  booleanValue(environment.personalGrantsEnabled, "environment.personalGrantsEnabled");
  validateModes(environment.enabledModes, "environment.enabledModes");
  validateDomainSet(environment.configuredPublicDomains, "environment.configuredPublicDomains");
  validateDomainSet(environment.blockedPublicDomains, "environment.blockedPublicDomains");

  const project = input.project;
  exactKeys(project, [
    "version",
    "projectId",
    "revision",
    "enabledModes",
    "personalGrantsEnabled",
    "blockedPublicDomains",
  ], "BrowserProjectDomainAuthorityV1");
  if (project.version !== BROWSER_PROJECT_DOMAIN_AUTHORITY_VERSION) {
    throw new Error("Browser Project authority version is invalid.");
  }
  nonEmptyString(project.projectId, "project.projectId");
  nonEmptyString(project.revision, "project.revision");
  booleanValue(project.personalGrantsEnabled, "project.personalGrantsEnabled");
  validateModes(project.enabledModes, "project.enabledModes");
  validateDomainSet(project.blockedPublicDomains, "project.blockedPublicDomains");
  if (project.enabledModes.some((mode) => !environment.enabledModes.includes(mode))) {
    throw new Error("Project Browser modes may only narrow Environment modes.");
  }
  if (project.personalGrantsEnabled && !environment.personalGrantsEnabled) {
    throw new Error("Project policy cannot enable personal grants above its Environment ceiling.");
  }

  const personal = input.personal;
  exactKeys(personal, ["version", "userId", "environmentId", "revision", "activeDomains"], "BrowserPersonalDomainAuthorityV1");
  if (personal.version !== BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION) {
    throw new Error("Browser personal authority version is invalid.");
  }
  nonEmptyString(personal.userId, "personal.userId");
  nonEmptyString(personal.environmentId, "personal.environmentId");
  nonEmptyString(personal.revision, "personal.revision");
  if (personal.environmentId !== environment.environmentId) {
    throw new Error("Personal Browser authority belongs to a different Environment.");
  }
  validateDomainSet(personal.activeDomains, "personal.activeDomains");

  const qa = input.qa;
  exactKeys(qa, ["version", "revision", "target"], "BrowserQaDomainAuthorityV1");
  if (qa.version !== BROWSER_QA_DOMAIN_AUTHORITY_VERSION) {
    throw new Error("Browser QA authority version is invalid.");
  }
  nonEmptyString(qa.revision, "qa.revision");
  if (qa.target !== null) validateQaTarget(qa.target);
}

function validateModes(modes: readonly BrowserMode[], field: string): void {
  if (!Array.isArray(modes) || modes.some((mode) => mode !== "qa" && mode !== "operator")) {
    throw new Error(`${field} must contain only qa or operator.`);
  }
  if (new Set(modes).size !== modes.length) throw new Error(`${field} cannot contain duplicates.`);
}

function validateDomainSet(domains: readonly BrowserPublicDomainAuthorityV1[], field: string): void {
  if (!Array.isArray(domains)) throw new Error(`${field} must be an array.`);
  for (const [index, domain] of domains.entries()) validatePublicDomain(domain, `${field}[${index}]`);
  if (new Set(domains.map(domainKey)).size !== domains.length) throw new Error(`${field} cannot contain duplicates.`);
}

function validatePublicDomain(domain: BrowserPublicDomainAuthorityV1, field: string): void {
  exactKeys(domain, ["version", "scheme", "canonicalDomain", "includeSubdomains", "port"], field);
  if (
    domain.version !== BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION ||
    domain.scheme !== "https" ||
    domain.includeSubdomains !== true ||
    domain.port !== 443
  ) throw new Error(`${field} is not canonical Browser public authority.`);
  const canonical = canonicalizePublicBrowserDestination(`https://${domain.canonicalDomain}`);
  if (canonical.canonicalDomain !== domain.canonicalDomain) throw new Error(`${field}.canonicalDomain is not canonical.`);
}

function validateQaTarget(target: BrowserQaTargetV1): void {
  exactKeys(target, ["version", "scheme", "hostname", "port"], "BrowserQaTargetV1");
  if (target.version !== BROWSER_QA_TARGET_VERSION) throw new Error("Browser QA target version is invalid.");
  if (target.scheme !== "http" && target.scheme !== "https") throw new Error("Browser QA target scheme is invalid.");
  if (normalizeHostname(target.hostname) !== target.hostname) throw new Error("Browser QA target hostname is not canonical.");
  if (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65_535) throw new Error("Browser QA target port is invalid.");
}

function canonicalEnvironment(value: BrowserEnvironmentDomainAuthorityV1) {
  return {
    ...value,
    enabledModes: [...value.enabledModes].sort(compareStrings),
    configuredPublicDomains: uniqueSortedDomains(value.configuredPublicDomains),
    blockedPublicDomains: uniqueSortedDomains(value.blockedPublicDomains),
  };
}

function canonicalProject(value: BrowserProjectDomainAuthorityV1) {
  return {
    ...value,
    enabledModes: [...value.enabledModes].sort(compareStrings),
    blockedPublicDomains: uniqueSortedDomains(value.blockedPublicDomains),
  };
}

function canonicalPersonal(value: BrowserPersonalDomainAuthorityV1) {
  return { ...value, activeDomains: uniqueSortedDomains(value.activeDomains) };
}

function canonicalQa(value: BrowserQaDomainAuthorityV1) {
  return { ...value, target: value.target === null ? null : { ...value.target } };
}

function uniqueSortedDomains(domains: readonly BrowserPublicDomainAuthorityV1[]): BrowserPublicDomainAuthorityV1[] {
  const byKey = new Map<string, BrowserPublicDomainAuthorityV1>();
  for (const domain of domains) byKey.set(domainKey(domain), domain);
  return [...byKey.values()].sort((left, right) => compareStrings(domainKey(left), domainKey(right)));
}

function domainKey(domain: BrowserPublicDomainAuthorityV1): string {
  return `https://${domain.canonicalDomain}:443/*`;
}

function normalizeHostname(value: string): string {
  const withoutTrailingDot = value.toLowerCase().replace(/\.+$/u, "");
  const unbracketed =
    withoutTrailingDot.startsWith("[") && withoutTrailingDot.endsWith("]")
      ? withoutTrailingDot.slice(1, -1)
      : withoutTrailingDot;
  const normalized = isIP(unbracketed) === 0 ? domainToASCII(unbracketed) : unbracketed;
  if (normalized === "" || normalized.length > 253) throw new Error("Browser destination hostname is invalid.");
  return normalized;
}

function isIpLiteral(hostname: string): boolean {
  return isIP(hostname) !== 0;
}

function isReservedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "metadata" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localdomain") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".invalid") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".onion")
  );
}

function invalidDestination(message: string): Error {
  return new Error(`BROWSER_DESTINATION_BLOCKED: ${message}`);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function booleanValue(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
}

function exactKeys(value: unknown, allowed: readonly string[], type: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${type} must be an object.`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${type} contains unknown fields: ${unknown.sort(compareStrings).join(", ")}.`);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const RESERVED_NETWORKS = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  RESERVED_NETWORKS.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  RESERVED_NETWORKS.addSubnet(network, prefix, "ipv6");
}
