import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import {
  parseBrowserDownloadPreparedEffectV1,
  type BrowserDownloadPreparationRequestV1,
  type BrowserDownloadPreparedEffectV1,
} from "../../../../src/browser/contracts.js";

type Scope = {
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
};

export interface HostedBrowserDownloadWorkerPort {
  prepare(input: Scope & {
    capability: string;
    request: BrowserDownloadPreparationRequestV1;
  }): Promise<BrowserDownloadPreparedEffectV1>;
  open(input: Scope & {
    operationId: string;
    capability: string;
    sizeBytes: number;
    sha256: string;
    signal?: AbortSignal;
  }): Promise<NodeJS.ReadableStream>;
}

export class HostedBrowserDownloadWorkerClient implements HostedBrowserDownloadWorkerPort {
  constructor(private readonly options: {
    environmentPrivateKeyPem: string;
    fetchImpl?: typeof fetch;
  }) {}

  async prepare(input: Parameters<HostedBrowserDownloadWorkerPort["prepare"]>[0]) {
    const envelope = {
      version: "hosted_browser_download_prepare_router_envelope_v1" as const,
      ...scope(input),
      capability: input.capability,
      request: input.request,
    };
    const response = await this.#request(input, "browser.download.prepare", envelope, "/internal/browser/download/prepare");
    return parseBrowserDownloadPreparedEffectV1(await response.json());
  }

  async open(input: Parameters<HostedBrowserDownloadWorkerPort["open"]>[0]) {
    const envelope = {
      version: "hosted_browser_download_bytes_router_envelope_v1" as const,
      ...scope(input),
      operationId: input.operationId,
      capability: input.capability,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    };
    const response = await this.#request(input, "browser.download.bytes", envelope, "/internal/browser/download/bytes");
    if (
      !response.body ||
      Number(response.headers.get("content-length") ?? "-1") !== input.sizeBytes ||
      response.headers.get("x-kestrel-browser-download-sha256") !== input.sha256
    ) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
    return Readable.fromWeb(response.body as never);
  }

  async #request(
    input: Scope & { signal?: AbortSignal },
    operation: "browser.download.prepare" | "browser.download.bytes",
    envelope: Record<string, unknown>,
    pathname: string,
  ) {
    const body = Buffer.from(JSON.stringify(envelope));
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
        operationBinding: `sha256:${createHash("sha256").update(body).digest("base64url")}`,
        issuedAt,
        expiresAt: issuedAt + 60,
        nonce: randomUUID(),
      },
    });
    const response = await (this.options.fetchImpl ?? fetch)(new URL(pathname, input.routerUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(body.byteLength),
      },
      body,
      redirect: "error",
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
    return response;
  }
}

function scope(input: Scope) {
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
