import { request } from "node:http";

import {
  parseDesktopUiStateV1,
  type DesktopUiStateSyncResult,
  type DesktopUiStateV1,
  type DesktopManagedProjectRun,
  type DesktopPackageManager,
  type DesktopProjectLauncherDescriptor,
} from "../desktopShell/contracts.js";
import type { ResolvedModelPolicy } from "../profile/modelPolicy.js";
import type { LocalCoreStatus } from "./contracts.js";

export interface LocalCoreClientOptions {
  socketPath: string;
  token: string;
  timeoutMs?: number | undefined;
}

export class LocalCoreClient {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: LocalCoreClientOptions) {
    this.socketPath = options.socketPath;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async health(): Promise<{ ok: true }> {
    return await this.get("/v1/health", { auth: false }) as { ok: true };
  }

  async status(): Promise<LocalCoreStatus> {
    const response = await this.get("/v1/status") as { status?: LocalCoreStatus };
    if (response.status === undefined) {
      throw new Error("Local Core status response did not include status.");
    }
    return response.status;
  }

  async settings(): Promise<unknown> {
    return await this.get("/v1/settings");
  }

  async patchSettings(patch: Record<string, unknown>): Promise<unknown> {
    return await this.patch("/v1/settings", patch);
  }

  async desktopSettings<TSettings = Record<string, unknown>>(): Promise<{
    settings: TSettings;
    modelPolicy: ResolvedModelPolicy;
  }> {
    const response = await this.settings();
    const settings = readObjectField<Record<string, unknown>>(response, "settings", "settings");
    const modelPolicy = readObjectField<ResolvedModelPolicy>(settings, "modelPolicy", "settings.modelPolicy");
    return {
      settings: settings as TSettings,
      modelPolicy,
    };
  }

  async patchDesktopSettings<TSettings = Record<string, unknown>>(settings: TSettings): Promise<{
    settings: TSettings;
    modelPolicy: ResolvedModelPolicy;
  }> {
    const response = await this.patchSettings(settings as Record<string, unknown>);
    const nextSettings = readObjectField<Record<string, unknown>>(response, "settings", "settings");
    const modelPolicy = readObjectField<ResolvedModelPolicy>(nextSettings, "modelPolicy", "settings.modelPolicy");
    return {
      settings: nextSettings as TSettings,
      modelPolicy,
    };
  }

  async getDesktopUiState(): Promise<DesktopUiStateV1 | null> {
    const response = await this.get("/v1/desktop/ui-state");
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      throw new Error("Local Core Desktop UI state response must be an object.");
    }
    const state = (response as Record<string, unknown>).state;
    return state === null ? null : parseDesktopUiStateV1(state);
  }

  async syncDesktopUiState(state: DesktopUiStateV1): Promise<DesktopUiStateSyncResult> {
    const response = await this.put("/v1/desktop/ui-state", {
      state: parseDesktopUiStateV1(state),
    });
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      throw new Error("Local Core Desktop UI state sync response must be an object.");
    }
    const record = response as Record<string, unknown>;
    if (typeof record.updated !== "boolean") {
      throw new Error("Local Core Desktop UI state sync response did not include updated.");
    }
    return {
      state: parseDesktopUiStateV1(record.state),
      updated: record.updated,
    };
  }

  async readDesktopProjectLauncher(input: {
    projectPath: string;
    packageManagerOverride?: DesktopPackageManager | undefined;
  }): Promise<DesktopProjectLauncherDescriptor | undefined> {
    const params = new URLSearchParams({ projectPath: input.projectPath });
    if (input.packageManagerOverride !== undefined) {
      params.set("packageManagerOverride", input.packageManagerOverride);
    }
    const response = await this.get(`/v1/desktop/project-launcher?${params.toString()}`) as {
      launcher?: DesktopProjectLauncherDescriptor | null | undefined;
    };
    return response.launcher ?? undefined;
  }

  async listDesktopProjectRuns(): Promise<DesktopManagedProjectRun[]> {
    const response = await this.get("/v1/desktop/project-runs") as {
      runs?: DesktopManagedProjectRun[] | undefined;
    };
    return response.runs ?? [];
  }

  async startDesktopProjectRun(input: {
    projectPath: string;
    scriptName: string;
    packageManagerOverride?: DesktopPackageManager | undefined;
  }): Promise<DesktopManagedProjectRun> {
    const response = await this.post("/v1/desktop/project-runs", input) as {
      run?: DesktopManagedProjectRun | undefined;
    };
    if (response.run === undefined) {
      throw new Error("Local Core Desktop project run response did not include run.");
    }
    return response.run;
  }

  async stopDesktopProjectRun(runId: string): Promise<DesktopManagedProjectRun | undefined> {
    const response = await this.post(`/v1/desktop/project-runs/${encodeURIComponent(runId)}/stop`, {}) as {
      run?: DesktopManagedProjectRun | null | undefined;
    };
    return response.run ?? undefined;
  }

  async restartDesktopProjectRun(runId: string): Promise<DesktopManagedProjectRun> {
    const response = await this.post(`/v1/desktop/project-runs/${encodeURIComponent(runId)}/restart`, {}) as {
      run?: DesktopManagedProjectRun | undefined;
    };
    if (response.run === undefined) {
      throw new Error("Local Core Desktop project run restart response did not include run.");
    }
    return response.run;
  }

  subscribeDesktopProjectRuns(input: {
    onRuns(runs: DesktopManagedProjectRun[]): void;
    onError?(error: Error): void;
  }): () => void {
    let closed = false;
    let buffer = "";
    const req = request({
      socketPath: this.socketPath,
      path: "/v1/desktop/project-runs/events",
      method: "GET",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "text/event-stream",
      },
    }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let eventEnd = buffer.indexOf("\n\n");
        while (eventEnd !== -1) {
          const rawEvent = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          eventEnd = buffer.indexOf("\n\n");
          const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine === undefined) {
            continue;
          }
          try {
            const parsed = JSON.parse(dataLine.slice("data: ".length)) as { runs?: DesktopManagedProjectRun[] };
            input.onRuns(parsed.runs ?? []);
          } catch (error) {
            input.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      response.on("error", (error) => {
        if (!closed) {
          input.onError?.(error);
        }
      });
    });
    req.on("error", (error) => {
      if (!closed) {
        input.onError?.(error);
      }
    });
    req.end();
    return () => {
      closed = true;
      req.destroy();
    };
  }

  async providerReadiness(): Promise<unknown> {
    return await this.get("/v1/provider-readiness");
  }

  async workspaces(): Promise<unknown> {
    return await this.get("/v1/workspaces");
  }

  async addWorkspace(workspace: Record<string, unknown>): Promise<unknown> {
    return await this.post("/v1/workspaces", workspace);
  }

  async deleteWorkspace(workspaceId: string): Promise<unknown> {
    return await this.delete(`/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async sessions(): Promise<unknown> {
    return await this.get("/v1/sessions");
  }

  async session(sessionId: string): Promise<unknown> {
    return await this.get(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async runs(): Promise<unknown> {
    return await this.get("/v1/runs");
  }

  async diagnostics(): Promise<unknown> {
    return await this.get("/v1/diagnostics");
  }

  async supportBundle(): Promise<unknown> {
    return await this.post("/v1/support-bundle", {});
  }

  async restart(): Promise<LocalCoreStatus> {
    const response = await this.post("/v1/restart", {}) as { status?: LocalCoreStatus };
    if (response.status === undefined) {
      throw new Error("Local Core restart response did not include status.");
    }
    return response.status;
  }

  async repair(): Promise<LocalCoreStatus> {
    const response = await this.post("/v1/repair", {}) as { status?: LocalCoreStatus };
    if (response.status === undefined) {
      throw new Error("Local Core repair response did not include status.");
    }
    return response.status;
  }

  async legacyState(): Promise<unknown> {
    return await this.get("/v1/legacy-state");
  }

  async getJson(path: string, options: { auth?: boolean | undefined } = {}): Promise<unknown> {
    return await this.get(path, options);
  }

  async postJson(path: string, body: unknown): Promise<unknown> {
    return await this.post(path, body);
  }

  async putJson(path: string, body: unknown): Promise<unknown> {
    return await this.put(path, body);
  }

  async patchJson(path: string, body: unknown): Promise<unknown> {
    return await this.patch(path, body);
  }

  async deleteJson(path: string): Promise<unknown> {
    return await this.delete(path);
  }

  private async get(path: string, options: { auth?: boolean | undefined } = {}): Promise<unknown> {
    return await this.request("GET", path, undefined, options.auth ?? true);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return await this.request("POST", path, body, true);
  }

  private async patch(path: string, body: unknown): Promise<unknown> {
    return await this.request("PATCH", path, body, true);
  }

  private async put(path: string, body: unknown): Promise<unknown> {
    return await this.request("PUT", path, body, true);
  }

  private async delete(path: string): Promise<unknown> {
    return await this.request("DELETE", path, undefined, true);
  }

  private request(method: string, path: string, body: unknown, auth: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({
        socketPath: this.socketPath,
        path,
        method,
        timeout: this.timeoutMs,
        headers: {
          ...(auth ? { authorization: `Bearer ${this.token}` } : {}),
          ...(payload !== undefined
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
      }, (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          const parsed = raw.trim().length > 0 ? JSON.parse(raw) as unknown : {};
          if ((response.statusCode ?? 500) >= 400) {
            reject(new LocalCoreApiError(response.statusCode ?? 500, parsed));
            return;
          }
          resolve(parsed);
        });
      });
      req.on("timeout", () => {
        req.destroy(new Error(`Local Core API request timed out: ${method} ${path}`));
      });
      req.on("error", reject);
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }
}

function readObjectField<T extends object>(value: unknown, field: string, label: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Local Core ${label} response must be an object.`);
  }
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(`Local Core ${label} response did not include object field '${field}'.`);
  }
  return candidate as T;
}

export class LocalCoreApiError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(statusCode: number, body: unknown) {
    super(`Local Core API request failed with HTTP ${statusCode}.`);
    this.statusCode = statusCode;
    this.body = body;
  }
}
