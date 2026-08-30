import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import type {
  DesktopBrowserViewerFrameV1,
  DesktopBrowserViewerInputV1,
  DesktopBrowserViewerStateV1,
} from "../../../../src/desktopShell/contracts.js";

const MAX_VIEWER_RESPONSE_BYTES = 28 * 1024 * 1024;
const VIEWER_REQUEST_TIMEOUT_MS = 15_000;

export type HostedBrowserViewerWorkerAction =
  | "connect"
  | "frame"
  | "accept"
  | "renew"
  | "input"
  | "return"
  | "disconnect"
  | "close";

export interface HostedBrowserViewerWorkerPort {
  invoke(input: {
    routerUrl: string;
    organizationId: string;
    environmentId: string;
    projectId: string;
    threadId: string;
    runId: string;
    actorId: string;
    sessionId: string;
    generation: number;
    appName: string;
    machineId: string;
    ticket: string;
    action: HostedBrowserViewerWorkerAction;
    connectionId?: string | undefined;
    leaseId?: string | undefined;
    viewerInput?: DesktopBrowserViewerInputV1 | undefined;
  }): Promise<DesktopBrowserViewerStateV1 | DesktopBrowserViewerFrameV1 | null>;
}

export class HostedBrowserViewerWorkerClient
  implements HostedBrowserViewerWorkerPort {
  constructor(private readonly options: {
    environmentPrivateKeyPem: string;
    viewerPublicKeyPem: string;
    fetchImpl?: typeof fetch | undefined;
  }) {}

  async invoke(input: {
    routerUrl: string;
    organizationId: string;
    environmentId: string;
    projectId: string;
    threadId: string;
    runId: string;
    actorId: string;
    sessionId: string;
    generation: number;
    appName: string;
    machineId: string;
    ticket: string;
    action: HostedBrowserViewerWorkerAction;
    connectionId?: string | undefined;
    leaseId?: string | undefined;
    viewerInput?: DesktopBrowserViewerInputV1 | undefined;
  }) {
    if (
      !(
        /^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.appName) &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.machineId)
      )
    ) {
      throw new Error("BROWSER_SESSION_LOST");
    }
    const operation = `viewer.${input.action}`;
    const envelope = {
      version: "hosted_browser_viewer_router_envelope_v1" as const,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      projectId: input.projectId,
      userId: input.actorId,
      threadId: input.threadId,
      runId: input.runId,
      viewerPublicKeyPem: this.options.viewerPublicKeyPem,
      instruction: {
        version: "hosted_browser_viewer_instruction_v1" as const,
        sessionId: input.sessionId,
        generation: input.generation,
        action: input.action,
        operation,
        viewerTicket: input.ticket,
        machine: { appName: input.appName, machineId: input.machineId },
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.leaseId ? { leaseId: input.leaseId } : {}),
        ...(input.viewerInput ? { viewerInput: input.viewerInput } : {}),
      },
    };
    const body = JSON.stringify(envelope);
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
        actorId: input.actorId,
        agentId: "kestrel-control-plane",
        providerKey: "built_in.browser",
        resourceId: input.sessionId,
        capability: "browser.viewer.control",
        operation,
        operationBinding: `sha256:${createHash("sha256").update(body).digest("base64url")}`,
        issuedAt,
        expiresAt: issuedAt + 60,
        nonce: randomUUID(),
      },
    });
    const response = await (this.options.fetchImpl ?? fetch)(
      new URL("/internal/browser/viewer", input.routerUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(VIEWER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(await readWorkerError(response));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_VIEWER_RESPONSE_BYTES) {
      throw new Error("BROWSER_ENGINE_FAILURE");
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as
      | DesktopBrowserViewerStateV1
      | DesktopBrowserViewerFrameV1
      | null;
  }
}

async function readWorkerError(response: Response) {
  try {
    const value = (await response.json()) as { error?: { code?: unknown } };
    return typeof value.error?.code === "string" &&
      value.error.code.startsWith("BROWSER_")
      ? value.error.code
      : "BROWSER_ENGINE_FAILURE";
  } catch {
    return "BROWSER_ENGINE_FAILURE";
  }
}
