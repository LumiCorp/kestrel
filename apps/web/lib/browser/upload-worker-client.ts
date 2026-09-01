import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import {
  parseBrowserUploadPreparedEffectV1,
  type BrowserUploadPreparationRequestV1,
  type BrowserUploadPreparedEffectV1,
} from "../../../../src/browser/contracts.js";

export interface HostedBrowserUploadWorkerPort {
  prepare(input: {
    routerUrl: string;
    organizationId: string;
    environmentId: string;
    projectId: string;
    userId: string;
    threadId: string;
    runId: string;
    sessionId: string;
    appName: string;
    machineId: string;
    capability: string;
    request: BrowserUploadPreparationRequestV1;
  }): Promise<BrowserUploadPreparedEffectV1>;
  transfer(input: {
    routerUrl: string;
    organizationId: string;
    environmentId: string;
    projectId: string;
    userId: string;
    threadId: string;
    runId: string;
    sessionId: string;
    appName: string;
    machineId: string;
    operationId: string;
    capability: string;
    sizeBytes: number;
    sha256: string;
    body: NodeJS.ReadableStream;
    signal?: AbortSignal | undefined;
  }): Promise<void>;
}

export class HostedBrowserUploadWorkerClient implements HostedBrowserUploadWorkerPort {
  constructor(private readonly options: {
    environmentPrivateKeyPem: string;
    fetchImpl?: typeof fetch | undefined;
  }) {}

  async prepare(input: Parameters<HostedBrowserUploadWorkerPort["prepare"]>[0]) {
    const envelope = {
      version: "hosted_browser_upload_prepare_router_envelope_v1" as const,
      ...scope(input),
      capability: input.capability,
      request: input.request,
    };
    const body = Buffer.from(JSON.stringify(envelope));
    const response = await this.#request(input, "browser.upload.prepare", body, "/internal/browser/upload/prepare", {
      "content-type": "application/json",
    });
    return parseBrowserUploadPreparedEffectV1(await response.json());
  }

  async transfer(input: Parameters<HostedBrowserUploadWorkerPort["transfer"]>[0]) {
    const envelope = {
      version: "hosted_browser_upload_bytes_router_envelope_v1" as const,
      ...scope(input),
      operationId: input.operationId,
      capability: input.capability,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    };
    const binding = Buffer.from(JSON.stringify(envelope));
    try {
      const response = await this.#request(
        input,
        "browser.upload.bytes",
        binding,
        "/internal/browser/upload/bytes",
        {
          "content-type": "application/octet-stream",
          "content-length": String(input.sizeBytes),
          "x-kestrel-browser-upload-envelope": binding.toString("base64url"),
        },
        input.body,
      );
      const result = await readBoundedJson(response);
      if (result.staged !== true || result.operationId !== input.operationId) {
        throw new Error("BROWSER_ENGINE_FAILURE");
      }
    } finally {
      destroyReadable(input.body);
    }
  }

  async #request(
    input: { organizationId: string; environmentId: string; userId: string; threadId: string; runId: string; sessionId: string; routerUrl: string; signal?: AbortSignal | undefined },
    operation: "browser.upload.prepare" | "browser.upload.bytes",
    binding: Buffer,
    pathname: string,
    headers: Record<string, string>,
    body?: NodeJS.ReadableStream,
  ) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = signEnvironmentToolCredential({
      privateKey: this.options.environmentPrivateKeyPem,
      ticket: {
        version: ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
        audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: `browser:${input.sessionId}`,
        threadId: input.threadId,
        runId: input.runId,
        actorId: input.userId,
        agentId: "kestrel-control-plane",
        providerKey: "built_in.browser",
        resourceId: input.sessionId,
        capability: operation,
        operation,
        operationBinding: `sha256:${createHash("sha256").update(binding).digest("base64url")}`,
        issuedAt,
        expiresAt: issuedAt + 60,
        nonce: randomUUID(),
      },
    });
    const response = await (this.options.fetchImpl ?? fetch)(
      new URL(pathname, input.routerUrl),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...headers },
        body: (body ?? binding) as unknown as BodyInit,
        redirect: "error",
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
        ...(body ? ({ duplex: "half" } as Record<string, unknown>) : {}),
      },
    );
    if (!response.ok) {
      const error = await readBoundedJson(response).catch(() => null);
      const code = error && typeof error.error === "object" && error.error !== null &&
          typeof (error.error as Record<string, unknown>).code === "string"
        ? (error.error as Record<string, unknown>).code as string
        : "BROWSER_SERVICE_UNAVAILABLE";
      throw new Error(/^BROWSER_[A-Z0-9_]+$/u.test(code)
        ? code
        : "BROWSER_SERVICE_UNAVAILABLE");
    }
    return response;
  }
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > 128 * 1024) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  return value as Record<string, unknown>;
}

function destroyReadable(body: NodeJS.ReadableStream): void {
  const readable = body as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
  readable.destroy?.();
}

function scope(input: {
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  threadId: string;
  runId: string;
  sessionId: string;
  appName: string;
  machineId: string;
}) {
  return {
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    projectId: input.projectId,
    userId: input.userId,
    threadId: input.threadId,
    runId: input.runId,
    sessionId: input.sessionId,
    machine: { appName: input.appName, machineId: input.machineId },
  };
}
