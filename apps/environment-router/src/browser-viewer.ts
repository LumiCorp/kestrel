import { createHash, createPublicKey, verify } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyEnvironmentToolCredential } from "@lumi/kestrel-environment-auth";

const MAX_BROWSER_VIEWER_REQUEST_BYTES = 64 * 1024;
const MAX_BROWSER_VIEWER_RESPONSE_BYTES = 28 * 1024 * 1024;
const BROWSER_VIEWER_TIMEOUT_MS = 12_000;
const VIEWER_AUDIENCE = "kestrel-one-browser-viewer";
const VIEWER_AUTHORITY_EXPIRED = "BROWSER_VIEWER_AUTHORITY_EXPIRED";
const VIEWER_FRAME_UNAVAILABLE = "BROWSER_VIEWER_FRAME_UNAVAILABLE";

type ViewerAction =
  | "connect"
  | "frame"
  | "accept"
  | "renew"
  | "input"
  | "return"
  | "disconnect"
  | "close";

type BrowserViewerEnvelope = {
  version: "hosted_browser_viewer_router_envelope_v1";
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  threadId: string;
  runId: string;
  viewerPublicKeyPem: string;
  instruction: {
    version: "hosted_browser_viewer_instruction_v1";
    sessionId: string;
    generation: number;
    action: ViewerAction;
    operation: string;
    viewerTicket: string;
    machine: { appName: string; machineId: string };
    connectionId?: string | undefined;
    leaseId?: string | undefined;
    viewerInput?: unknown;
  };
};

type BrowserViewerCleanupEnvelope = {
  version: "hosted_browser_viewer_cleanup_router_envelope_v1";
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  threadId: string;
  runId: string;
  instruction: {
    version: "hosted_browser_viewer_cleanup_instruction_v1";
    sessionId: string;
    generation: number;
    connectionId: string;
    operation: "viewer.cleanup";
    purpose: "disconnect" | "authority_loss";
    cleanupCapability: string;
    machine: { appName: string; machineId: string };
  };
};

export async function handleBrowserViewerControl(input: {
  request: IncomingMessage;
  response: ServerResponse;
  publicKey: string;
  environmentId: string;
  expectedAppName: string;
  fetchImpl?: typeof fetch | undefined;
}) {
  let envelope: BrowserViewerEnvelope | BrowserViewerCleanupEnvelope;
  try {
    const body = await readBoundedRequestBody(input.request);
    const parsed = JSON.parse(body.toString("utf8")) as { version?: unknown };
    envelope = parsed.version === "hosted_browser_viewer_cleanup_router_envelope_v1"
      ? authorizeBrowserViewerCleanup({
          authorization: input.request.headers.authorization,
          body,
          publicKey: input.publicKey,
          environmentId: input.environmentId,
          expectedAppName: input.expectedAppName,
        })
      : authorizeBrowserViewerControl({
      authorization: input.request.headers.authorization,
      body,
      publicKey: input.publicKey,
      environmentId: input.environmentId,
      expectedAppName: input.expectedAppName,
        });
  } catch {
    return writeError(input.response, 403, "BROWSER_VIEWER_CONTROL_DENIED");
  }

  const cleanup = envelope.version === "hosted_browser_viewer_cleanup_router_envelope_v1";
  const routedViewerAction =
    envelope.version === "hosted_browser_viewer_router_envelope_v1"
      ? envelope.instruction.action
      : undefined;
  let workerRequest: Record<string, unknown>;
  if (envelope.version === "hosted_browser_viewer_cleanup_router_envelope_v1") {
    workerRequest = {
      organizationId: envelope.organizationId,
      environmentId: envelope.environmentId,
      projectId: envelope.projectId,
      actorId: envelope.userId,
      threadId: envelope.threadId,
      sessionId: envelope.instruction.sessionId,
      generation: envelope.instruction.generation,
      connectionId: envelope.instruction.connectionId,
      purpose: envelope.instruction.purpose,
      cleanupCapability: envelope.instruction.cleanupCapability,
    };
  } else {
    workerRequest = {
      ticket: envelope.instruction.viewerTicket,
      action: envelope.instruction.action,
      ...(envelope.instruction.connectionId === undefined
        ? {}
        : { connectionId: envelope.instruction.connectionId }),
      ...(envelope.instruction.leaseId === undefined
        ? {}
        : { leaseId: envelope.instruction.leaseId }),
      ...(envelope.instruction.viewerInput === undefined
        ? {}
        : { viewerInput: envelope.instruction.viewerInput }),
    };
  }
  const instruction = envelope.instruction;
  let worker: Response;
  try {
    worker = await (input.fetchImpl ?? fetch)(
      new URL(
        `http://${instruction.machine.machineId}.vm.${instruction.machine.appName}.internal:43105/${cleanup ? "v1/viewer-cleanup" : "v1/viewer"}`,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(workerRequest),
        redirect: "error",
        signal: AbortSignal.timeout(BROWSER_VIEWER_TIMEOUT_MS),
      },
    );
  } catch {
    return writeError(input.response, 503, "BROWSER_VIEWER_UNAVAILABLE");
  }
  if (!worker.ok) {
    try {
      const body = await readBoundedBrowserViewerWorkerBody(worker);
      const parsed = JSON.parse(body.toString("utf8")) as {
        error?: { code?: unknown } | undefined;
      };
      if (
        parsed.error?.code === VIEWER_AUTHORITY_EXPIRED ||
        (routedViewerAction === "frame" &&
          parsed.error?.code === VIEWER_FRAME_UNAVAILABLE)
      ) {
        return writeError(input.response, worker.status, parsed.error.code);
      }
    } catch {
      // A malformed worker error is ordinary downstream uncertainty.
    }
    return writeError(input.response, 503, "BROWSER_VIEWER_UNAVAILABLE");
  }
  let responseBody: Buffer;
  try {
    responseBody = await readBoundedBrowserViewerWorkerBody(worker);
  } catch {
    return writeError(input.response, 503, "BROWSER_VIEWER_UNAVAILABLE");
  }
  input.response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  input.response.end(responseBody);
}

export function authorizeBrowserViewerCleanup(input: {
  authorization: string | undefined;
  body: Buffer;
  publicKey: string;
  environmentId: string;
  expectedAppName: string;
  now?: number | undefined;
}): BrowserViewerCleanupEnvelope {
  const token = input.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!token) throw new Error("Browser viewer cleanup credential is required.");
  const credential = verifyEnvironmentToolCredential({
    token,
    publicKey: input.publicKey,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const envelope = parseCleanupEnvelope(JSON.parse(input.body.toString("utf8")));
  const instruction = envelope.instruction;
  const bodyBinding = `sha256:${createHash("sha256").update(input.body).digest("base64url")}`;
  if (
    credential.organizationId !== envelope.organizationId ||
    credential.environmentId !== input.environmentId ||
    credential.environmentId !== envelope.environmentId ||
    credential.workspaceId !== `browser:${instruction.sessionId}` ||
    credential.threadId !== envelope.threadId ||
    credential.runId !== envelope.runId ||
    credential.actorId !== envelope.userId ||
    credential.agentId !== "kestrel-control-plane" ||
    credential.providerKey !== "built_in.browser" ||
    credential.resourceId !== instruction.sessionId ||
    credential.capability !== "browser.viewer.cleanup" ||
    credential.operation !== "viewer.cleanup" ||
    credential.operationBinding !== bodyBinding ||
    instruction.operation !== "viewer.cleanup" ||
    instruction.machine.appName !== input.expectedAppName
  ) {
    throw new Error("Browser viewer cleanup credential scope is invalid.");
  }
  return envelope;
}

export function authorizeBrowserViewerControl(input: {
  authorization: string | undefined;
  body: Buffer;
  publicKey: string;
  environmentId: string;
  expectedAppName: string;
  now?: number | undefined;
}): BrowserViewerEnvelope {
  const token = input.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!token) throw new Error("Browser viewer credential is required.");
  const credential = verifyEnvironmentToolCredential({
    token,
    publicKey: input.publicKey,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const envelope = parseEnvelope(JSON.parse(input.body.toString("utf8")));
  const instruction = envelope.instruction;
  const operation = `viewer.${instruction.action}`;
  const bodyBinding = `sha256:${createHash("sha256").update(input.body).digest("base64url")}`;
  const viewerClaims = verifyViewerTicket(
    instruction.viewerTicket,
    envelope.viewerPublicKeyPem,
    input.now,
  );
  if (
    credential.organizationId !== envelope.organizationId ||
    credential.environmentId !== input.environmentId ||
    credential.environmentId !== envelope.environmentId ||
    credential.workspaceId !== `browser:${instruction.sessionId}` ||
    credential.threadId !== envelope.threadId ||
    credential.runId !== envelope.runId ||
    credential.actorId !== envelope.userId ||
    credential.agentId !== "kestrel-control-plane" ||
    credential.providerKey !== "built_in.browser" ||
    credential.resourceId !== instruction.sessionId ||
    credential.capability !== "browser.viewer.control" ||
    credential.operation !== operation ||
    credential.operationBinding !== bodyBinding ||
    instruction.operation !== operation ||
    instruction.machine.appName !== input.expectedAppName ||
    viewerClaims.organizationId !== envelope.organizationId ||
    viewerClaims.environmentId !== envelope.environmentId ||
    viewerClaims.projectId !== envelope.projectId ||
    viewerClaims.threadId !== envelope.threadId ||
    viewerClaims.sessionId !== instruction.sessionId ||
    viewerClaims.generation !== instruction.generation ||
    viewerClaims.actorId !== envelope.userId ||
    viewerClaims.connectionId !== instruction.connectionId
  ) {
    throw new Error("Browser viewer credential scope is invalid.");
  }
  return envelope;
}

export async function readBoundedBrowserViewerWorkerBody(
  response: Response,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BROWSER_VIEWER_RESPONSE_BYTES
  ) {
    throw new Error("Browser viewer response is too large.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > MAX_BROWSER_VIEWER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Browser viewer response is too large.");
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
}

function parseEnvelope(value: unknown): BrowserViewerEnvelope {
  const envelope = record(value);
  const instruction = record(envelope.instruction);
  const machine = record(instruction.machine);
  const action = viewerAction(instruction.action);
  const baseInstructionKeys = [
    "version",
    "sessionId",
    "generation",
    "action",
    "operation",
    "viewerTicket",
    "machine",
  ];
  const actionKeys =
    action === "connect"
      ? [...baseInstructionKeys, "connectionId"]
      : action === "frame" ||
          action === "accept" ||
          action === "disconnect" ||
          action === "close"
        ? [...baseInstructionKeys, "connectionId"]
        : action === "renew" || action === "return"
          ? [...baseInstructionKeys, "connectionId", "leaseId"]
          : [...baseInstructionKeys, "connectionId", "leaseId", "viewerInput"];
  if (
    !exactKeys(envelope, [
      "version",
      "organizationId",
      "environmentId",
      "projectId",
      "userId",
      "threadId",
      "runId",
      "viewerPublicKeyPem",
      "instruction",
    ]) ||
    !exactKeys(instruction, actionKeys) ||
    !exactKeys(machine, ["appName", "machineId"]) ||
    envelope.version !== "hosted_browser_viewer_router_envelope_v1" ||
    !texts(envelope, [
      "organizationId",
      "environmentId",
      "projectId",
      "userId",
      "threadId",
      "runId",
      "viewerPublicKeyPem",
    ]) ||
    String(envelope.viewerPublicKeyPem).length > 8192 ||
    instruction.version !== "hosted_browser_viewer_instruction_v1" ||
    !text(instruction.sessionId) ||
    !Number.isSafeInteger(instruction.generation) ||
    Number(instruction.generation) < 1 ||
    !text(instruction.operation) ||
    !text(instruction.viewerTicket, 16 * 1024) ||
    ("connectionId" in instruction && !text(instruction.connectionId)) ||
    ("leaseId" in instruction && !text(instruction.leaseId)) ||
    typeof machine.appName !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(machine.appName) ||
    typeof machine.machineId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(machine.machineId)
  ) {
    throw new Error("Browser viewer request is invalid.");
  }
  return value as BrowserViewerEnvelope;
}

function parseCleanupEnvelope(value: unknown): BrowserViewerCleanupEnvelope {
  const envelope = record(value);
  const instruction = record(envelope.instruction);
  const machine = record(instruction.machine);
  if (
    !exactKeys(envelope, [
      "version",
      "organizationId",
      "environmentId",
      "projectId",
      "userId",
      "threadId",
      "runId",
      "instruction",
    ]) ||
    !exactKeys(instruction, [
      "version",
      "sessionId",
      "generation",
      "connectionId",
      "operation",
      "purpose",
      "cleanupCapability",
      "machine",
    ]) ||
    !exactKeys(machine, ["appName", "machineId"]) ||
    envelope.version !== "hosted_browser_viewer_cleanup_router_envelope_v1" ||
    !texts(envelope, [
      "organizationId",
      "environmentId",
      "projectId",
      "userId",
      "threadId",
      "runId",
    ]) ||
    instruction.version !== "hosted_browser_viewer_cleanup_instruction_v1" ||
    !text(instruction.sessionId) ||
    !Number.isSafeInteger(instruction.generation) ||
    Number(instruction.generation) < 1 ||
    !text(instruction.connectionId) ||
    instruction.operation !== "viewer.cleanup" ||
    (instruction.purpose !== "disconnect" &&
      instruction.purpose !== "authority_loss") ||
    !text(instruction.cleanupCapability, 16 * 1024) ||
    typeof machine.appName !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(machine.appName) ||
    typeof machine.machineId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(machine.machineId)
  ) {
    throw new Error("Browser viewer cleanup request is invalid.");
  }
  return value as BrowserViewerCleanupEnvelope;
}

function verifyViewerTicket(token: string, publicKeyPem: string, now?: number) {
  const [payload, signature, extra] = token.split(".");
  if (!(payload && signature) || extra !== undefined) {
    throw new Error("Browser viewer ticket is invalid.");
  }
  const key = createPublicKey(publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"))
  ) {
    throw new Error("Browser viewer ticket is invalid.");
  }
  const claims = record(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  const issuedAt = Date.parse(String(claims.issuedAt));
  const expiresAt = Date.parse(String(claims.expiresAt));
  const nowMilliseconds = (now ?? Math.floor(Date.now() / 1000)) * 1000;
  if (
    !exactKeys(claims, [
      "version",
      "audience",
      "organizationId",
      "environmentId",
      "projectId",
      "threadId",
      "sessionId",
      "generation",
      "actorId",
      "connectionId",
      "nonce",
      "issuedAt",
      "expiresAt",
    ]) ||
    claims.version !== "hosted_browser_viewer_ticket_v1" ||
    claims.audience !== VIEWER_AUDIENCE ||
    !texts(claims, [
      "organizationId",
      "environmentId",
      "projectId",
      "threadId",
      "sessionId",
      "actorId",
      "connectionId",
      "nonce",
      "issuedAt",
      "expiresAt",
    ]) ||
    !Number.isSafeInteger(claims.generation) ||
    Number(claims.generation) < 1 ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - issuedAt !== 60_000 ||
    issuedAt > nowMilliseconds + 5000
  ) {
    throw new Error("Browser viewer ticket is invalid.");
  }
  return claims as {
    organizationId: string;
    environmentId: string;
    projectId: string;
    threadId: string;
    sessionId: string;
    generation: number;
    actorId: string;
    connectionId: string;
  };
}

async function readBoundedRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_BROWSER_VIEWER_REQUEST_BYTES) {
      throw new Error("Browser viewer request is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function viewerAction(value: unknown): ViewerAction {
  if (
    value !== "connect" &&
    value !== "frame" &&
    value !== "accept" &&
    value !== "renew" &&
    value !== "input" &&
    value !== "return" &&
    value !== "disconnect" &&
    value !== "close"
  ) {
    throw new Error("Browser viewer action is invalid.");
  }
  return value;
}

function texts(value: Record<string, unknown>, keys: readonly string[]) {
  return keys.every(
    (key) => text(value[key], key === "viewerPublicKeyPem" ? 8192 : 1024),
  );
}

function text(value: unknown, maxLength = 1024): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    Boolean(value.trim())
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser viewer request is invalid.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function writeError(response: ServerResponse, status: number, code: string) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: { code } }));
}
