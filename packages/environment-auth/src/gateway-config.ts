export const ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION = 3 as const;
export const ENVIRONMENT_GATEWAY_CONFIG_VERSION =
  ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION;
export const ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS = [2, 3] as const;

export type EnvironmentGatewayPreviewRoute = {
  id: string;
  workspaceId: string;
  machineId: string;
  hostname: string;
  port: number;
  expiresAt: string;
  relayTicket: string;
};

export type EnvironmentGatewayModelGrant = {
  runId: string;
  workspaceId: string;
  gatewayId: string;
  rawModelId: string;
  provider:
    | "openai"
    | "openrouter"
    | "anthropic"
    | "ollama"
    | "lumi"
    | "runpod";
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

type EnvironmentGatewayConfigBase = {
  environmentId: string;
  revision: string;
  workspaces: Array<{
    id: string;
    machineId: string;
    serviceTokenHash: string;
  }>;
  previews: EnvironmentGatewayPreviewRoute[];
  modelGrants: EnvironmentGatewayModelGrant[];
};

export type EnvironmentGatewayConfigV2 = EnvironmentGatewayConfigBase & {
  version: 2;
  appGrants?: never;
};

export type EnvironmentGatewayConfigV3 = EnvironmentGatewayConfigBase & {
  version: typeof ENVIRONMENT_GATEWAY_CONFIG_VERSION;
  appGrants: EnvironmentGatewayAppGrant[];
};

export type EnvironmentGatewayConfig =
  | EnvironmentGatewayConfigV2
  | EnvironmentGatewayConfigV3;

export class EnvironmentGatewayConfigParseError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_VERSION" | "INVALID_CONFIG",
    readonly receivedVersion: number | null = null,
  ) {
    super(
      code === "UNSUPPORTED_VERSION"
        ? "Environment gateway configuration version is unsupported."
        : "Environment gateway configuration is invalid.",
    );
    this.name = "EnvironmentGatewayConfigParseError";
  }
}

export function serializeEnvironmentGatewayConfig(
  value: Omit<EnvironmentGatewayConfigV3, "version">,
): EnvironmentGatewayConfigV3 {
  return {
    version: ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
    ...value,
  };
}

export function parseEnvironmentGatewayConfig(
  value: unknown,
): EnvironmentGatewayConfigV3 {
  if (!isRecord(value)) throw invalidConfig();
  if (
    typeof value.version === "number" &&
    !ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS.some(
      (version) => version === value.version,
    )
  ) {
    throw new EnvironmentGatewayConfigParseError(
      "UNSUPPORTED_VERSION",
      value.version,
    );
  }
  if (
    (value.version !== 2 &&
      value.version !== ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION) ||
    typeof value.environmentId !== "string" ||
    !value.environmentId ||
    typeof value.revision !== "string" ||
    RETIRED_PREVIEW_PROVIDER_FIELD in value ||
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.previews) ||
    !Array.isArray(value.modelGrants) ||
    (value.version === ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION &&
      !Array.isArray(value.appGrants))
  ) {
    throw invalidConfig();
  }
  const workspaces = value.workspaces.map(parseWorkspace);
  const previews = value.previews.map(parsePreview);
  const modelGrants = value.modelGrants.map(parseModelGrant);
  const appGrants =
    value.version === 2
      ? []
      : (value.appGrants as unknown[]).map(parseAppGrant);
  const workspaceMachines = new Map(
    workspaces.map((workspace) => [workspace.id, workspace.machineId]),
  );
  if (
    previews.some(
      (preview) =>
        workspaceMachines.get(preview.workspaceId) !== preview.machineId,
    ) ||
    modelGrants.some((grant) => !workspaceMachines.has(grant.workspaceId)) ||
    appGrants.some((grant) => !workspaceMachines.has(grant.workspaceId))
  ) {
    throw invalidConfig();
  }
  if (
    new Set(previews.map((preview) => preview.hostname)).size !==
    previews.length
  ) {
    throw invalidConfig();
  }
  return {
    version: ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
    environmentId: value.environmentId,
    revision: value.revision,
    workspaces,
    previews,
    modelGrants,
    appGrants,
  };
}

const RETIRED_PREVIEW_PROVIDER_FIELD = ["n", "g", "r", "o", "k"].join("");

function parseAppGrant(
  value: unknown,
): EnvironmentGatewayConfigV3["appGrants"][number] {
  if (!isRecord(value)) throw invalidConfig();
  return {
    executionId: stringField(value, "executionId"),
    runId: nullableStringField(value, "runId"),
    workspaceId: stringField(value, "workspaceId"),
    executionTicket: stringField(value, "executionTicket"),
    credentialExpiresAt: dateField(value, "credentialExpiresAt"),
  };
}

function parseWorkspace(
  value: unknown,
): EnvironmentGatewayConfigV3["workspaces"][number] {
  if (!isRecord(value)) throw invalidConfig();
  const serviceTokenHash = stringField(value, "serviceTokenHash");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(serviceTokenHash)) throw invalidConfig();
  return {
    id: stringField(value, "id"),
    machineId: stringField(value, "machineId"),
    serviceTokenHash,
  };
}

function parsePreview(
  value: unknown,
): EnvironmentGatewayConfigV3["previews"][number] {
  if (!isRecord(value) || "ingress" in value) throw invalidConfig();
  const port = integerField(value, "port");
  const expiresAt = dateField(value, "expiresAt");
  const hostname = stringField(value, "hostname").toLowerCase();
  if (
    port < 1024 ||
    port > 65_535 ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(hostname)
  ) {
    throw invalidConfig();
  }
  return {
    id: stringField(value, "id"),
    workspaceId: stringField(value, "workspaceId"),
    machineId: stringField(value, "machineId"),
    hostname,
    port,
    expiresAt,
    relayTicket: stringField(value, "relayTicket"),
  };
}

function parseModelGrant(
  value: unknown,
): EnvironmentGatewayConfigV3["modelGrants"][number] {
  if (!isRecord(value)) throw invalidConfig();
  const provider = value.provider;
  const protocol = value.protocol;
  if (
    !new Set([
      "openai",
      "openrouter",
      "anthropic",
      "ollama",
      "lumi",
      "runpod",
    ]).has(String(provider))
  ) {
    throw invalidConfig();
  }
  if (protocol !== "openai" && protocol !== "anthropic") {
    throw invalidConfig();
  }
  const baseUrl = nullableString(value, "baseUrl");
  if (baseUrl) requireSecureProviderUrl(baseUrl);
  return {
    runId: stringField(value, "runId"),
    workspaceId: stringField(value, "workspaceId"),
    gatewayId: stringField(value, "gatewayId"),
    rawModelId: stringField(value, "rawModelId"),
    provider:
      provider as EnvironmentGatewayConfigV3["modelGrants"][number]["provider"],
    protocol,
    baseUrl,
    apiKey: nullableString(value, "apiKey"),
    credentialExpiresAt: dateField(value, "credentialExpiresAt"),
  };
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
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw invalidConfig();
  }
}

function invalidConfig() {
  return new EnvironmentGatewayConfigParseError("INVALID_CONFIG");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLoopback(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}
