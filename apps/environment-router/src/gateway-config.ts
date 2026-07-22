import type { EnvironmentGatewayConfig } from "@lumi/kestrel-environment-auth";
import { ENVIRONMENT_GATEWAY_CONFIG_VERSION } from "@lumi/kestrel-environment-auth";

export class EnvironmentGatewayConfigClient {
  private current: EnvironmentGatewayConfig | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<EnvironmentGatewayConfig> | null = null;
  private readonly listeners = new Set<
    (config: EnvironmentGatewayConfig) => void | Promise<void>
  >();

  constructor(
    private readonly input: {
      controlPlaneUrl: string;
      environmentId: string;
      serviceToken: string;
      fetchImpl?: typeof fetch | undefined;
      refreshIntervalMs?: number | undefined;
    }
  ) {}

  get snapshot() {
    return this.current;
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(
        () => void this.refresh().catch(() => {}),
        this.input.refreshIntervalMs ?? 30_000
      );
      this.timer.unref();
    }
    return this.refresh();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(listener: (config: EnvironmentGatewayConfig) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): Promise<EnvironmentGatewayConfig> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async refreshLatest(): Promise<EnvironmentGatewayConfig> {
    const inFlight = this.refreshing;
    if (inFlight) await inFlight.catch(() => undefined);
    return this.refresh();
  }

  async notifyWorkspaceIdle(body: Record<string, unknown>) {
    const response = await (this.input.fetchImpl ?? fetch)(
      new URL("/api/runtime/environments/idle", requireControlPlaneUrl(this.input.controlPlaneUrl)),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.input.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    if (response.status !== 202) throw new Error(`Workspace idle notification failed (${response.status}).`);
    return response.json();
  }

  async reportNgrokStatus(input: {
    connectionId: string;
    status: "connected" | "degraded";
    failureCode?: string | undefined;
  }) {
    const response = await (this.input.fetchImpl ?? fetch)(
      new URL(
        `/api/runtime/environments/${encodeURIComponent(this.input.environmentId)}/gateway/config`,
        requireControlPlaneUrl(this.input.controlPlaneUrl)
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.input.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }
    );
    if (!response.ok) throw new Error(`ngrok status report failed (${response.status}).`);
  }

  private async load() {
    const endpoint = new URL(
      `/api/runtime/environments/${encodeURIComponent(this.input.environmentId)}/gateway/config`,
      requireControlPlaneUrl(this.input.controlPlaneUrl)
    );
    const response = await (this.input.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.input.serviceToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Environment gateway configuration failed (${response.status}).`);
    }
    const config = parseEnvironmentGatewayConfig(await response.json());
    if (config.environmentId !== this.input.environmentId) {
      throw new Error("Environment gateway configuration scope is invalid.");
    }
    this.current = config;
    await Promise.allSettled(
      [...this.listeners].map((listener) =>
        Promise.resolve().then(() => listener(config))
      )
    );
    return config;
  }
}

function requireControlPlaneUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new Error("Environment gateway configuration requires HTTPS.");
  }
  return url;
}

function parseEnvironmentGatewayConfig(value: unknown): EnvironmentGatewayConfig {
  if (!isRecord(value)) {
    throw new Error("Environment gateway configuration is invalid.");
  }
  if (
    value.version !== ENVIRONMENT_GATEWAY_CONFIG_VERSION ||
    typeof value.environmentId !== "string" ||
    !value.environmentId ||
    typeof value.revision !== "string" ||
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.previews) ||
    !Array.isArray(value.modelGrants)
  ) {
    throw new Error("Environment gateway configuration is invalid.");
  }
  const ngrok = value.ngrok === null
    ? null
    : parseNgrok(value.ngrok);
  const workspaces = value.workspaces.map(parseWorkspace);
  const previews = value.previews.map(parsePreview);
  const modelGrants = value.modelGrants.map(parseModelGrant);
  const workspaceMachines = new Map(
    workspaces.map((workspace) => [workspace.id, workspace.machineId])
  );
  if (
    previews.some(
      (preview) => workspaceMachines.get(preview.workspaceId) !== preview.machineId
    ) ||
    modelGrants.some((grant) => !workspaceMachines.has(grant.workspaceId))
  ) {
    throw new Error("Environment gateway configuration workspace scope is invalid.");
  }
  if (new Set(previews.map((preview) => preview.hostname)).size !== previews.length) {
    throw new Error("Environment gateway configuration contains duplicate preview hosts.");
  }
  return {
    version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
    environmentId: value.environmentId,
    revision: value.revision,
    ngrok,
    workspaces,
    previews,
    modelGrants,
  };
}

function parseNgrok(value: unknown): NonNullable<EnvironmentGatewayConfig["ngrok"]> {
  if (!isRecord(value)) throw invalid();
  const connectionId = stringField(value, "connectionId");
  const authtoken = stringField(value, "authtoken");
  const wildcardDomain = stringField(value, "wildcardDomain").toLowerCase();
  if (!/^\*\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(wildcardDomain)) throw invalid();
  return { connectionId, authtoken, wildcardDomain };
}

function parseWorkspace(value: unknown): EnvironmentGatewayConfig["workspaces"][number] {
  if (!isRecord(value)) throw invalid();
  const serviceTokenHash = stringField(value, "serviceTokenHash");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(serviceTokenHash)) throw invalid();
  return {
    id: stringField(value, "id"),
    machineId: stringField(value, "machineId"),
    serviceTokenHash,
  };
}

function parsePreview(value: unknown): EnvironmentGatewayConfig["previews"][number] {
  if (!isRecord(value)) throw invalid();
  const port = integerField(value, "port");
  const expiresAt = dateField(value, "expiresAt");
  const hostname = stringField(value, "hostname").toLowerCase();
  if (port < 1024 || port > 65_535 || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(hostname)) throw invalid();
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

function parseModelGrant(value: unknown): EnvironmentGatewayConfig["modelGrants"][number] {
  if (!isRecord(value)) throw invalid();
  const provider = value.provider;
  const protocol = value.protocol;
  if (!new Set(["openai", "openrouter", "anthropic", "ollama", "lumi", "runpod"]).has(String(provider))) throw invalid();
  if (protocol !== "openai" && protocol !== "anthropic") throw invalid();
  const baseUrl = nullableString(value, "baseUrl");
  if (baseUrl) requireSecureProviderUrl(baseUrl);
  return {
    runId: stringField(value, "runId"),
    workspaceId: stringField(value, "workspaceId"),
    gatewayId: stringField(value, "gatewayId"),
    rawModelId: stringField(value, "rawModelId"),
    provider: provider as EnvironmentGatewayConfig["modelGrants"][number]["provider"],
    protocol,
    baseUrl,
    apiKey: nullableString(value, "apiKey"),
    credentialExpiresAt: dateField(value, "credentialExpiresAt"),
  };
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) throw invalid();
  return field.trim();
}

function nullableString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string" || !field.trim()) throw invalid();
  return field.trim();
}

function integerField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (!Number.isSafeInteger(field)) throw invalid();
  return field as number;
}

function dateField(value: Record<string, unknown>, key: string) {
  const field = stringField(value, key);
  if (!Number.isFinite(Date.parse(field))) throw invalid();
  return field;
}

function requireSecureProviderUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) throw invalid();
}

function invalid() {
  return new Error("Environment gateway configuration is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
