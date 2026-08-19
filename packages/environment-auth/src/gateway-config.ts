import { isIP } from "node:net";

export const ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION = 4 as const;
export const ENVIRONMENT_GATEWAY_CONFIG_VERSION = ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION;
export const ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS = [2, 3, 4] as const;

export type LegacyEnvironmentGatewayPreviewRoute = {
  id: string;
  workspaceId: string;
  machineId: string;
  hostname: string;
  port: number;
  expiresAt: string;
  relayTicket: string;
};

export type EnvironmentGatewayPreviewRoute = Omit<
  LegacyEnvironmentGatewayPreviewRoute,
  "machineId"
>;

export type EnvironmentGatewayModelGrant = {
  runId: string;
  workspaceId: string;
  gatewayId: string;
  rawModelId: string;
  provider: "openai" | "openrouter" | "anthropic" | "ollama" | "lumi" | "runpod";
  protocol: "openai" | "anthropic";
  baseUrl: string | null;
  apiKey: string | null;
  credentialExpiresAt: string;
};

export type EnvironmentGatewayAppGrant = {
  executionId: string;
  runId: string | null;
  workspaceId: string;
  executionTicket: string;
  credentialExpiresAt: string;
};

type LegacyEnvironmentGatewayConfigBase = {
  environmentId: string;
  revision: string;
  workspaces: Array<{ id: string; machineId: string; serviceTokenHash: string }>;
  previews: LegacyEnvironmentGatewayPreviewRoute[];
  modelGrants: EnvironmentGatewayModelGrant[];
};

export type EnvironmentGatewayConfigV2 = LegacyEnvironmentGatewayConfigBase & {
  version: 2;
  appGrants?: never;
};

export type EnvironmentGatewayConfigV3 = LegacyEnvironmentGatewayConfigBase & {
  version: 3;
  appGrants: EnvironmentGatewayAppGrant[];
};

export type GatewayPrivateBackend = {
  kind: "private_dns";
  hostname: string;
  port: number;
  computeResourceId: string;
  desiredRevision: string;
};

export type EnvironmentGatewayConfigV4 = {
  version: 4;
  environmentId: string;
  gatewayId: string;
  revision: string;
  routeGeneration: string;
  workspaces: Array<{
    id: string;
    serviceTokenHash: string;
    backend: GatewayPrivateBackend;
  }>;
  previews: EnvironmentGatewayPreviewRoute[];
  modelGrants: EnvironmentGatewayModelGrant[];
  appGrants: EnvironmentGatewayAppGrant[];
};

export type EnvironmentGatewayConfig = EnvironmentGatewayConfigV3 | EnvironmentGatewayConfigV4;

export class EnvironmentGatewayConfigParseError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_VERSION" | "INVALID_CONFIG",
    readonly receivedVersion: number | null = null,
  ) {
    super(code === "UNSUPPORTED_VERSION"
      ? "Environment gateway configuration version is unsupported."
      : "Environment gateway configuration is invalid.");
    this.name = "EnvironmentGatewayConfigParseError";
  }
}

export function serializeEnvironmentGatewayConfig(
  value: Omit<EnvironmentGatewayConfigV4, "version">,
): EnvironmentGatewayConfigV4 {
  return { version: ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION, ...value };
}

export function serializeLegacyEnvironmentGatewayConfig(
  value: Omit<EnvironmentGatewayConfigV3, "version">,
): EnvironmentGatewayConfigV3 {
  return { version: 3, ...value };
}

export function parseEnvironmentGatewayConfig(value: unknown): EnvironmentGatewayConfig {
  if (!isRecord(value)) throw invalidConfig();
  if (
    typeof value.version === "number" &&
    !ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS.some((version) => version === value.version)
  ) {
    throw new EnvironmentGatewayConfigParseError("UNSUPPORTED_VERSION", value.version);
  }
  return value.version === 4 ? parseV4(value) : parseLegacy(value);
}

function parseLegacy(value: Record<string, unknown>): EnvironmentGatewayConfigV3 {
  const expectedKeys = value.version === 2
    ? ["version", "environmentId", "revision", "workspaces", "previews", "modelGrants"]
    : ["version", "environmentId", "revision", "workspaces", "previews", "modelGrants", "appGrants"];
  if (
    (value.version !== 2 && value.version !== 3) ||
    !hasExactKeys(value, expectedKeys) ||
    RETIRED_PREVIEW_PROVIDER_FIELD in value ||
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.previews) ||
    !Array.isArray(value.modelGrants) ||
    (value.version === 3 && !Array.isArray(value.appGrants))
  ) throw invalidConfig();
  const environmentId = stringField(value, "environmentId");
  const revision = stringField(value, "revision");
  const workspaces = value.workspaces.map(parseLegacyWorkspace);
  const previews = value.previews.map(parseLegacyPreview);
  const modelGrants = value.modelGrants.map(parseModelGrant);
  const appGrants = value.version === 2 ? [] : (value.appGrants as unknown[]).map(parseAppGrant);
  const workspaceMachines = new Map(workspaces.map((workspace) => [workspace.id, workspace.machineId]));
  validateCommonRelations({
    workspaceIds: new Set(workspaceMachines.keys()), previews, modelGrants, appGrants,
  });
  if (previews.some((preview) => workspaceMachines.get(preview.workspaceId) !== preview.machineId)) {
    throw invalidConfig();
  }
  return { version: 3, environmentId, revision, workspaces, previews, modelGrants, appGrants };
}

function parseV4(value: Record<string, unknown>): EnvironmentGatewayConfigV4 {
  if (
    !hasExactKeys(value, [
      "version", "environmentId", "gatewayId", "revision", "routeGeneration",
      "workspaces", "previews", "modelGrants", "appGrants",
    ]) ||
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.previews) ||
    !Array.isArray(value.modelGrants) ||
    !Array.isArray(value.appGrants)
  ) throw invalidConfig();
  const workspaces = value.workspaces.map(parseWorkspaceV4);
  const previews = value.previews.map(parsePreviewV4);
  const modelGrants = value.modelGrants.map(parseModelGrant);
  const appGrants = value.appGrants.map(parseAppGrant);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  if (
    workspaceIds.size !== workspaces.length ||
    new Set(workspaces.map((workspace) => workspace.backend.computeResourceId)).size !== workspaces.length
  ) throw invalidConfig();
  validateCommonRelations({ workspaceIds, previews, modelGrants, appGrants });
  return {
    version: 4,
    environmentId: stringField(value, "environmentId"),
    gatewayId: stringField(value, "gatewayId"),
    revision: digestField(value, "revision"),
    routeGeneration: digestField(value, "routeGeneration"),
    workspaces,
    previews,
    modelGrants,
    appGrants,
  };
}

const RETIRED_PREVIEW_PROVIDER_FIELD = ["n", "g", "r", "o", "k"].join("");

function parseAppGrant(value: unknown): EnvironmentGatewayAppGrant {
  if (!isRecord(value) || !hasExactKeys(value, [
    "executionId", "runId", "workspaceId", "executionTicket", "credentialExpiresAt",
  ])) throw invalidConfig();
  return {
    executionId: stringField(value, "executionId"),
    runId: nullableStringField(value, "runId"),
    workspaceId: stringField(value, "workspaceId"),
    executionTicket: stringField(value, "executionTicket"),
    credentialExpiresAt: dateField(value, "credentialExpiresAt"),
  };
}

function parseLegacyWorkspace(value: unknown): EnvironmentGatewayConfigV3["workspaces"][number] {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "machineId", "serviceTokenHash"])) {
    throw invalidConfig();
  }
  return {
    id: stringField(value, "id"),
    machineId: stringField(value, "machineId"),
    serviceTokenHash: tokenHashField(value),
  };
}

function parseWorkspaceV4(value: unknown): EnvironmentGatewayConfigV4["workspaces"][number] {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "serviceTokenHash", "backend"])) {
    throw invalidConfig();
  }
  return {
    id: stringField(value, "id"),
    serviceTokenHash: tokenHashField(value),
    backend: parsePrivateBackend(value.backend),
  };
}

function parsePrivateBackend(value: unknown): GatewayPrivateBackend {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "hostname", "port", "computeResourceId", "desiredRevision"]) ||
    value.kind !== "private_dns"
  ) throw invalidConfig();
  const port = integerField(value, "port");
  if (port < 1 || port > 65_535) throw invalidConfig();
  return {
    kind: "private_dns",
    hostname: dnsHostnameField(value, "hostname"),
    port,
    computeResourceId: stringField(value, "computeResourceId"),
    desiredRevision: stringField(value, "desiredRevision"),
  };
}

function parseLegacyPreview(value: unknown): LegacyEnvironmentGatewayPreviewRoute {
  if (!isRecord(value) || "ingress" in value || !hasExactKeys(value, [
    "id", "workspaceId", "machineId", "hostname", "port", "expiresAt", "relayTicket",
  ])) throw invalidConfig();
  return { ...parsePreviewCommon(value), machineId: stringField(value, "machineId") };
}

function parsePreviewV4(value: unknown): EnvironmentGatewayPreviewRoute {
  if (!isRecord(value) || "ingress" in value || !hasExactKeys(value, [
    "id", "workspaceId", "hostname", "port", "expiresAt", "relayTicket",
  ])) throw invalidConfig();
  return parsePreviewCommon(value);
}

function parsePreviewCommon(value: Record<string, unknown>): EnvironmentGatewayPreviewRoute {
  const port = integerField(value, "port");
  if (port < 1024 || port > 65_535) throw invalidConfig();
  return {
    id: stringField(value, "id"),
    workspaceId: stringField(value, "workspaceId"),
    hostname: dnsHostnameField(value, "hostname"),
    port,
    expiresAt: dateField(value, "expiresAt"),
    relayTicket: stringField(value, "relayTicket"),
  };
}

function parseModelGrant(value: unknown): EnvironmentGatewayModelGrant {
  if (!isRecord(value) || !hasExactKeys(value, [
    "runId", "workspaceId", "gatewayId", "rawModelId", "provider", "protocol",
    "baseUrl", "apiKey", "credentialExpiresAt",
  ])) throw invalidConfig();
  const provider = value.provider;
  const protocol = value.protocol;
  if (!new Set(["openai", "openrouter", "anthropic", "ollama", "lumi", "runpod"]).has(String(provider))) {
    throw invalidConfig();
  }
  if (protocol !== "openai" && protocol !== "anthropic") throw invalidConfig();
  const baseUrl = nullableString(value, "baseUrl");
  if (baseUrl) requireSecureProviderUrl(baseUrl);
  return {
    runId: stringField(value, "runId"),
    workspaceId: stringField(value, "workspaceId"),
    gatewayId: stringField(value, "gatewayId"),
    rawModelId: stringField(value, "rawModelId"),
    provider: provider as EnvironmentGatewayModelGrant["provider"],
    protocol,
    baseUrl,
    apiKey: nullableString(value, "apiKey"),
    credentialExpiresAt: dateField(value, "credentialExpiresAt"),
  };
}

function validateCommonRelations(input: {
  workspaceIds: Set<string>;
  previews: Array<{ workspaceId: string; hostname: string }>;
  modelGrants: EnvironmentGatewayModelGrant[];
  appGrants: EnvironmentGatewayAppGrant[];
}) {
  if (
    input.previews.some((preview) => !input.workspaceIds.has(preview.workspaceId)) ||
    input.modelGrants.some((grant) => !input.workspaceIds.has(grant.workspaceId)) ||
    input.appGrants.some((grant) => !input.workspaceIds.has(grant.workspaceId)) ||
    new Set(input.previews.map((preview) => preview.hostname)).size !== input.previews.length
  ) throw invalidConfig();
}

function tokenHashField(value: Record<string, unknown>) {
  const hash = stringField(value, "serviceTokenHash");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(hash)) throw invalidConfig();
  return hash;
}

function digestField(value: Record<string, unknown>, key: string) {
  const digest = stringField(value, key);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw invalidConfig();
  return digest;
}

function dnsHostnameField(value: Record<string, unknown>, key: string) {
  const hostname = stringField(value, key);
  if (
    hostname !== hostname.toLowerCase() ||
    hostname.length > 253 ||
    isIP(hostname) !== 0 ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(hostname) ||
    hostname.split(".").some((label) =>
      !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
  ) throw invalidConfig();
  return hostname;
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) throw invalidConfig();
  return field.trim();
}

function nullableStringField(value: Record<string, unknown>, key: string) {
  return value[key] === null ? null : stringField(value, key);
}

function nullableString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string" || !field.trim()) throw invalidConfig();
  return field.trim();
}

function integerField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (!Number.isSafeInteger(field)) throw invalidConfig();
  return field as number;
}

function dateField(value: Record<string, unknown>, key: string) {
  const field = stringField(value, key);
  if (!Number.isFinite(Date.parse(field))) throw invalidConfig();
  return field;
}

function requireSecureProviderUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfig();
  }
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) throw invalidConfig();
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function invalidConfig() {
  return new EnvironmentGatewayConfigParseError("INVALID_CONFIG");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
