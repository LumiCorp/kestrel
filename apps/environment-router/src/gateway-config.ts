import type {
  EnvironmentGatewayConfigV3,
} from "@lumi/kestrel-environment-auth";
import {
  ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS,
  EnvironmentGatewayConfigParseError,
  parseEnvironmentGatewayConfig as parseSharedEnvironmentGatewayConfig,
} from "@lumi/kestrel-environment-auth";

export class EnvironmentGatewayConfigClient {
  private current: EnvironmentGatewayConfigV3 | null = null;
  private failure: {
    code: "UNSUPPORTED_VERSION" | "INVALID_CONFIG" | "UNAVAILABLE";
    receivedVersion: number | null;
    occurredAt: string;
  } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<EnvironmentGatewayConfigV3> | null = null;
  private readonly listeners = new Set<
    (config: EnvironmentGatewayConfigV3) => void | Promise<void>
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

  get health() {
    return {
      ready: this.current !== null,
      acceptedVersions: [...ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS],
      activeVersion: this.current?.version ?? null,
      lastFailure: this.failure,
    };
  }

  get controlPlaneUrl() {
    return requireControlPlaneUrl(this.input.controlPlaneUrl);
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

  subscribe(listener: (config: EnvironmentGatewayConfigV3) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): Promise<EnvironmentGatewayConfigV3> {
    this.refreshing ??= this.load()
      .then((config) => {
        this.failure = null;
        return config;
      })
      .catch((error) => {
        this.failure = {
          code:
            error instanceof EnvironmentGatewayConfigParseError
              ? error.code
              : "UNAVAILABLE",
          receivedVersion:
            error instanceof EnvironmentGatewayConfigParseError
              ? error.receivedVersion
              : null,
          occurredAt: new Date().toISOString(),
        };
        throw error;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  async refreshLatest(): Promise<EnvironmentGatewayConfigV3> {
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
    const config = parseSharedEnvironmentGatewayConfig(await response.json());
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

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
