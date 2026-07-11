import { hostname } from "node:os";

import type { ResolvedWorkspace, TuiProfile, TuiSessionMeta } from "../contracts.js";

const DEFAULT_LOCAL_STUDIO_URL = "http://localhost:43200";
const DEFAULT_LOCAL_SERVICE_TOKEN = "local-runner-token";
const HEARTBEAT_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 1_500;

interface MissionControlRuntimeReporterOptions {
  cwd: string;
  workspace?: ResolvedWorkspace | undefined;
  profile: TuiProfile;
  session: TuiSessionMeta;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: typeof fetch | undefined;
}

interface ReporterConfig {
  endpoint: string;
  token: string;
}

export class MissionControlRuntimeReporter {
  private readonly options: MissionControlRuntimeReporterOptions;
  private readonly instanceId: string;
  private interval: ReturnType<typeof setInterval> | undefined;
  private registered = false;
  private stopped = false;

  constructor(options: MissionControlRuntimeReporterOptions) {
    this.options = options;
    this.instanceId = buildRuntimeInstanceId();
  }

  start(): void {
    const config = resolveReporterConfig(this.options.env ?? process.env);
    if (!config) {
      return;
    }

    void this.register(config);
  }

  stop(): void {
    this.stopped = true;
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async register(config: ReporterConfig): Promise<void> {
    const ok = await this.send(config, "POST", {
      id: this.instanceId,
      shell: "cli",
      displayName: "Kestrel TUI",
      capabilities: ["chat", "run", "status"],
      metadata: {
        source: "kestrel-tui",
        pid: process.pid,
        host: hostname(),
        cwd: this.options.cwd,
        profileId: this.options.profile.id,
        sessionId: this.options.session.sessionId,
        sessionName: this.options.session.name,
        workspaceId: this.options.workspace?.manifest.workspaceId,
        workspaceRoot: this.options.workspace?.rootPath,
        version: process.env.npm_package_version,
      },
    });

    if (!ok || this.stopped) {
      return;
    }

    this.registered = true;
    this.interval = setInterval(() => {
      void this.heartbeat(config);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async heartbeat(config: ReporterConfig): Promise<void> {
    if (!this.registered || this.stopped) {
      return;
    }

    const ok = await this.send(config, "PATCH", { id: this.instanceId });
    if (!ok) {
      this.stop();
    }
  }

  private async send(
    config: ReporterConfig,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
  ): Promise<boolean> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(config.endpoint, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function resolveReporterConfig(env: NodeJS.ProcessEnv): ReporterConfig | null {
  if (env.KESTREL_MISSION_CONTROL_DISABLED === "1") {
    return null;
  }

  const configuredBaseUrl =
    readNonEmpty(env.KESTREL_MISSION_CONTROL_URL) ??
    readNonEmpty(env.KESTREL_STUDIO_URL);
  const baseUrl = configuredBaseUrl ?? DEFAULT_LOCAL_STUDIO_URL;
  const token =
    readNonEmpty(env.KESTREL_RUNTIME_INSTANCE_SERVICE_TOKEN) ??
    readNonEmpty(env.KESTREL_MISSION_CONTROL_TOKEN) ??
    (configuredBaseUrl === undefined ? DEFAULT_LOCAL_SERVICE_TOKEN : undefined);

  if (!token) {
    return null;
  }

  let endpoint: URL;
  try {
    endpoint = new URL("/api/kestrel/runtime-instances", baseUrl);
  } catch {
    return null;
  }

  return {
    endpoint: endpoint.toString(),
    token,
  };
}

function buildRuntimeInstanceId(): string {
  const host = hostname().replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return `cli:${host}:${process.pid}`;
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
