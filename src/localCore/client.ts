import { request } from "node:http";

import { parseRunnerEventV2 } from "@kestrel-agents/protocol";

import {
  parseDesktopUiStateV1,
  type DesktopUiStateSyncResult,
  type DesktopUiStateV1,
  type DesktopManagedProjectRun,
  type DesktopPackageManager,
  type DesktopProjectLauncherDescriptor,
} from "../desktopShell/contracts.js";
import type { ResolvedModelPolicy } from "../profile/modelPolicy.js";
import type {
  ReplayDoctorReport,
  ReplayQuery,
  ReplayResult,
} from "../replay/RunReplayService.js";
import type { RuntimeReplayBundleV1 } from "../replay/RuntimeReplayBundle.js";
import {
  parseLocalCoreDesktopExecutionConfig,
  parseLocalCoreRuntimeStoreResetResult,
  parseLocalCoreStatus,
  type LocalCoreDesktopExecutionConfig,
  type LocalCoreRuntimeStoreResetResult,
  type LocalCoreStatus,
} from "./contracts.js";
import type { DesktopAttachmentMetadata } from "./desktopAttachments.js";
import type { RunTurnAttachment, ThreadRecord } from "../kestrel/contracts/orchestration.js";
import type { WorkspaceRuntimeContext } from "../../cli/contracts.js";
import {
  parseLocalCoreCredentialId,
  parseLocalCoreCredentialSecret,
  parseLocalCoreCredentialStoreStatus,
  type LocalCoreCredentialId,
  type LocalCoreCredentialStoreStatus,
} from "./credentialStore.js";
import {
  parseLocalCoreRuntimeConfiguration,
  type LocalCoreRuntimeConfigurationV1,
} from "./runtimeConfiguration.js";
import type {
  LocalCoreMcpVerificationInput,
  LocalCoreMcpVerificationResult,
} from "./mcpVerification.js";
import type { LocalCoreExternalDatabaseVerificationResult } from "./externalDatabaseVerification.js";

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
    return parseLocalCoreStatus(
      readObjectField<Record<string, unknown>>(
        await this.get("/v1/status"),
        "status",
        "status",
      ),
    );
  }

  async settings(): Promise<unknown> {
    return await this.get("/v1/settings");
  }

  async patchSettings(patch: Record<string, unknown>): Promise<unknown> {
    return await this.patch("/v1/settings", patch);
  }

  async runtimeConfiguration(): Promise<LocalCoreRuntimeConfigurationV1> {
    const response = await this.get("/v1/runtime/configuration");
    return parseLocalCoreRuntimeConfiguration(
      readObjectField<Record<string, unknown>>(
        response,
        "runtimeConfiguration",
        "runtime configuration",
      ),
    );
  }

  async repairRuntimeConfiguration(
    runtimeConfiguration: LocalCoreRuntimeConfigurationV1,
  ): Promise<LocalCoreRuntimeConfigurationV1> {
    const response = await this.post("/v1/runtime/configuration/repair", {
      runtimeConfiguration: parseLocalCoreRuntimeConfiguration(runtimeConfiguration),
    });
    return parseLocalCoreRuntimeConfiguration(
      readObjectField<Record<string, unknown>>(
        response,
        "runtimeConfiguration",
        "runtime configuration repair",
      ),
    );
  }

  async credentialStatus(): Promise<LocalCoreCredentialStoreStatus> {
    const response = await this.get("/v1/credentials");
    return parseLocalCoreCredentialStoreStatus(
      readObjectField<Record<string, unknown>>(
        response,
        "credentials",
        "credential status",
      ),
    );
  }

  async setCredential(
    id: LocalCoreCredentialId,
    secret: string,
  ): Promise<LocalCoreCredentialStoreStatus> {
    const credentialId = parseLocalCoreCredentialId(id);
    const response = await this.put(
      `/v1/credentials/${encodeURIComponent(credentialId)}`,
      { secret: parseLocalCoreCredentialSecret(secret) },
    );
    return parseLocalCoreCredentialStoreStatus(
      readObjectField<Record<string, unknown>>(
        response,
        "credentials",
        "credential status",
      ),
    );
  }

  async deleteCredential(
    id: LocalCoreCredentialId,
  ): Promise<{ deleted: boolean; credentials: LocalCoreCredentialStoreStatus }> {
    const credentialId = parseLocalCoreCredentialId(id);
    const response = await this.delete(
      `/v1/credentials/${encodeURIComponent(credentialId)}`,
    );
    return {
      deleted: readBooleanField(response, "deleted", "credential deletion"),
      credentials: parseLocalCoreCredentialStoreStatus(
        readObjectField<Record<string, unknown>>(
          response,
          "credentials",
          "credential status",
        ),
      ),
    };
  }

  async verifyMcpServer(
    input: LocalCoreMcpVerificationInput,
  ): Promise<LocalCoreMcpVerificationResult> {
    const response = await this.post("/v1/mcp/verify", input);
    return readObjectField<LocalCoreMcpVerificationResult>(
      response,
      "verification",
      "MCP verification",
    );
  }

  async verifyExternalDatabase(
    databaseUrl: string,
  ): Promise<LocalCoreExternalDatabaseVerificationResult> {
    const response = await this.post("/v1/database/external/verify", { databaseUrl });
    return readObjectField<LocalCoreExternalDatabaseVerificationResult>(
      response,
      "verification",
      "external database verification",
    );
  }

  async desktopExecutionConfig(): Promise<LocalCoreDesktopExecutionConfig> {
    const response = await this.get("/v1/desktop/execution-config");
    return parseLocalCoreDesktopExecutionConfig(
      readObjectField<Record<string, unknown>>(
        response,
        "executionConfig",
        "Desktop execution config",
      ),
    );
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

  async syncDesktopThreadWorkspace(input: {
    sessionId: string;
    threadId: string;
    workspace: WorkspaceRuntimeContext;
  }): Promise<ThreadRecord> {
    const response = await this.put("/v1/desktop/thread-workspace", input);
    return readObjectField<ThreadRecord>(response, "thread", "Desktop thread workspace");
  }

  async importDesktopAttachment(input: {
    threadId: string;
    filename: string;
    mimeType?: string | undefined;
    data: string;
    sha256?: string | undefined;
  }): Promise<DesktopAttachmentMetadata> {
    const response = await this.post("/v1/desktop/attachments", input);
    return readObjectField<DesktopAttachmentMetadata>(response, "attachment", "Desktop attachment");
  }

  async listDesktopAttachments(threadId: string): Promise<DesktopAttachmentMetadata[]> {
    const response = await this.get(`/v1/desktop/attachments?threadId=${encodeURIComponent(threadId)}`) as { attachments?: unknown };
    if (Array.isArray(response.attachments) === false) throw new Error("Local Core Desktop attachment response is invalid.");
    return response.attachments as DesktopAttachmentMetadata[];
  }

  async removeDesktopAttachment(threadId: string, attachmentId: string): Promise<boolean> {
    const response = await this.delete(`/v1/desktop/attachments/${encodeURIComponent(attachmentId)}?threadId=${encodeURIComponent(threadId)}`) as { removed?: unknown };
    if (typeof response.removed !== "boolean") throw new Error("Local Core Desktop attachment removal response is invalid.");
    return response.removed;
  }

  async resolveDesktopAttachments(threadId: string, attachmentIds: string[]): Promise<RunTurnAttachment[]> {
    const response = await this.post("/v1/desktop/attachments/resolve", { threadId, attachmentIds }) as { attachments?: unknown };
    if (Array.isArray(response.attachments) === false) throw new Error("Local Core Desktop attachment resolution response is invalid.");
    return response.attachments as RunTurnAttachment[];
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
    let disconnectReported = false;
    let buffer = "";
    const reportDisconnect = (error: Error) => {
      if (closed || disconnectReported) {
        return;
      }
      disconnectReported = true;
      input.onError?.(error);
    };
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
        reportDisconnect(error);
      });
      response.on("end", () => {
        reportDisconnect(createLocalCoreStreamClosedError());
      });
      response.on("close", () => {
        reportDisconnect(createLocalCoreStreamClosedError());
      });
    });
    req.on("error", (error) => {
      reportDisconnect(error);
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

  async runtimeReplay(query: ReplayQuery): Promise<ReplayResult> {
    const response = await this.post("/v1/runtime/replay", { query });
    return readObjectField<ReplayResult>(response, "replay", "runtime replay");
  }

  async runtimeDoctor(query: ReplayQuery): Promise<ReplayDoctorReport> {
    const response = await this.post("/v1/runtime/doctor", { query });
    return readObjectField<ReplayDoctorReport>(response, "doctor", "runtime doctor");
  }

  async runtimeBundle(query: ReplayQuery): Promise<RuntimeReplayBundleV1> {
    const response = await this.post("/v1/runtime/bundle", { query });
    return readObjectField<RuntimeReplayBundleV1>(response, "bundle", "runtime bundle");
  }

  async sendRunnerCommand(
    line: string,
    input: {
      onLine(line: string): void;
      signal?: AbortSignal | undefined;
    },
  ): Promise<void> {
    const command = parseRunnerCommandEnvelope(line);
    const stream = command.type === "run.start"
      || command.type === "job.run"
      || (command.type === "operator.control" && command.payload.completionMode === "accepted");
    await new Promise<void>((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        path: `/runtime/v2/commands${stream ? "/stream" : ""}`,
        method: "POST",
        signal: input.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: stream ? "text/event-stream, application/json" : "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(line),
        },
      }, (response) => {
        const contentType = response.headers["content-type"] ?? "";
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          raw += chunk;
          if (contentType.includes("text/event-stream")) {
            raw = consumeRunnerSseBuffer(raw, input.onLine);
          }
        });
        response.on("end", () => {
          const trailing = raw.trim();
          if ((response.statusCode ?? 500) >= 400) {
            const runnerErrorLine = parseCorrelatedRunnerErrorLine(trailing, command.id);
            if (runnerErrorLine !== undefined) {
              input.onLine(runnerErrorLine);
              resolve();
              return;
            }
            reject(new LocalCoreApiError(
              response.statusCode ?? 500,
              parseJsonOrText(trailing),
            ));
            return;
          }
          if (contentType.includes("text/event-stream")) {
            consumeRunnerSseBuffer(`${raw}\n\n`, input.onLine);
          } else if (trailing.length > 0) {
            input.onLine(trailing);
          }
          resolve();
        });
        response.on("error", reject);
      });
      req.on("error", reject);
      req.write(line);
      req.end();
    });
  }

  async diagnostics(): Promise<unknown> {
    return await this.get("/v1/diagnostics");
  }

  async supportBundle(): Promise<unknown> {
    return await this.post("/v1/support-bundle", {});
  }

  async restart(): Promise<LocalCoreStatus> {
    return parseLocalCoreStatus(
      readObjectField<Record<string, unknown>>(
        await this.post("/v1/restart", {}),
        "status",
        "restart",
      ),
    );
  }

  async repair(): Promise<LocalCoreStatus> {
    return parseLocalCoreStatus(
      readObjectField<Record<string, unknown>>(
        await this.post("/v1/repair", {}),
        "status",
        "repair",
      ),
    );
  }

  async resetRuntimeStore(): Promise<LocalCoreRuntimeStoreResetResult> {
    return parseLocalCoreRuntimeStoreResetResult(
      await this.request(
        "POST",
        "/v1/runtime/store/reset",
        { confirm: true },
        true,
        { timeout: "none" },
      ),
    );
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

  private request(
    method: string,
    path: string,
    body: unknown,
    auth: boolean,
    options: { timeout?: "default" | "none" | undefined } = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({
        socketPath: this.socketPath,
        path,
        method,
        ...(options.timeout === "none" ? {} : { timeout: this.timeoutMs }),
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

function parseCorrelatedRunnerErrorLine(
  line: string,
  commandId: string,
): string | undefined {
  if (line.length === 0) {
    return undefined;
  }
  try {
    const event = parseRunnerEventV2(JSON.parse(line));
    if (event.type !== "runner.error" || event.commandId !== commandId) {
      return undefined;
    }
    return JSON.stringify(event);
  } catch {
    return undefined;
  }
}

function createLocalCoreStreamClosedError(): NodeJS.ErrnoException {
  return Object.assign(
    new Error("Local Core project run event stream closed."),
    { code: "ECONNRESET" },
  );
}

function parseRunnerCommandEnvelope(line: string): { id: string; type: string; payload: Record<string, unknown> } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw new Error("Local Core runner command must be valid JSON.");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("Local Core runner command must be an object.");
  }
  const id = (decoded as Record<string, unknown>).id;
  const type = (decoded as Record<string, unknown>).type;
  const payloadValue = (decoded as Record<string, unknown>).payload;
  if (typeof id !== "string" || id.length === 0 || typeof type !== "string" || type.length === 0) {
    throw new Error("Local Core runner command must include string id and type fields.");
  }
  const payload = typeof payloadValue === "object" && payloadValue !== null && !Array.isArray(payloadValue)
    ? payloadValue as Record<string, unknown>
    : {};
  return { id, type, payload };
}

function consumeRunnerSseBuffer(buffer: string, onLine: (line: string) => void): string {
  let remaining = buffer;
  let boundary = remaining.indexOf("\n\n");
  while (boundary !== -1) {
    const event = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + 2);
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data.length > 0) {
      onLine(data);
    }
    boundary = remaining.indexOf("\n\n");
  }
  return remaining;
}

function parseJsonOrText(value: string): unknown {
  if (value.length === 0) {
    return {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { message: value };
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

function readBooleanField(value: unknown, field: string, label: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Local Core ${label} response must be an object.`);
  }
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== "boolean") {
    throw new Error(`Local Core ${label} response did not include boolean field '${field}'.`);
  }
  return candidate;
}

export class LocalCoreApiError extends Error {
  readonly statusCode: number;
  readonly body: unknown;
  readonly code: string | undefined;
  readonly serviceMessage: string | undefined;

  constructor(statusCode: number, body: unknown) {
    const serviceError = readServiceError(body);
    super(serviceError?.message ?? `Local Core API request failed with HTTP ${statusCode}.`);
    this.statusCode = statusCode;
    this.body = body;
    this.code = serviceError?.code;
    this.serviceMessage = serviceError?.message;
  }
}

function readServiceError(body: unknown): { code: string; message: string } | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return ;
  }
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return ;
  }
  const code = (error as Record<string, unknown>).code;
  const message = (error as Record<string, unknown>).message;
  if (
    typeof code !== "string"
    || code.trim().length === 0
    || typeof message !== "string"
    || message.trim().length === 0
  ) {
    return ;
  }
  return { code: code.trim(), message: message.trim() };
}
