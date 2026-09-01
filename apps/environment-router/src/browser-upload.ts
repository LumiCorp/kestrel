import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONVERSATION_ATTACHMENT_MAX_FILE_BYTES } from "@kestrel-agents/conversation";
import { verifyEnvironmentToolCredential } from "@lumi/kestrel-environment-auth";

const MAX_PREPARE_BYTES = 128 * 1024;
const MAX_UPLOAD_BYTES = CONVERSATION_ATTACHMENT_MAX_FILE_BYTES;

export async function handleBrowserUpload(input: {
  request: IncomingMessage;
  response: ServerResponse;
  publicKey: string;
  environmentId: string;
  expectedAppName: string;
  prepare: boolean;
  fetchImpl?: typeof fetch | undefined;
}) {
  try {
    if (input.prepare) {
      const body = await readBounded(input.request, MAX_PREPARE_BYTES);
      const envelope = requirePrepareEnvelope(JSON.parse(body.toString("utf8")));
      authorize(input, body, envelope, "browser.upload.prepare");
      const upstream = await workerFetch(input, envelope.machine, "/v1/upload/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      return await relay(input.response, upstream, MAX_PREPARE_BYTES);
    }
    const encoded = singleHeader(input.request.headers["x-kestrel-browser-upload-envelope"]);
    const envelopeBytes = Buffer.from(encoded, "base64url");
    const envelope = requireBytesEnvelope(JSON.parse(envelopeBytes.toString("utf8")));
    authorize(input, envelopeBytes, envelope, "browser.upload.bytes");
    const declared = Number(input.request.headers["content-length"] ?? "-1");
    if (declared !== envelope.sizeBytes || declared > MAX_UPLOAD_BYTES) throw new Error("invalid upload length");
    const upstream = await workerFetch(input, envelope.machine, "/v1/upload/bytes", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(declared),
        "x-kestrel-browser-operation-id": envelope.operationId,
        "x-kestrel-browser-operation-capability": envelope.capability,
      },
      body: input.request as never,
      // Node streaming request bodies require duplex even though lib.dom omits it.
      ...({ duplex: "half" } as Record<string, unknown>),
    });
    return await relay(input.response, upstream, MAX_PREPARE_BYTES);
  } catch {
    input.response.writeHead(403, { "content-type": "application/json" });
    input.response.end(JSON.stringify({ error: { code: "BROWSER_UPLOAD_DENIED" } }));
  }
}

type Scope = {
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  threadId: string;
  runId: string;
  sessionId: string;
  machine: { appName: string; machineId: string };
};

function authorize(
  input: Parameters<typeof handleBrowserUpload>[0],
  bindingBytes: Buffer,
  envelope: Scope,
  operation: string,
) {
  const token = input.request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!token) throw new Error("missing credential");
  const credential = verifyEnvironmentToolCredential({ token, publicKey: input.publicKey });
  const binding = `sha256:${createHash("sha256").update(bindingBytes).digest("base64url")}`;
  if (
    credential.organizationId !== envelope.organizationId ||
    credential.environmentId !== input.environmentId ||
    envelope.environmentId !== input.environmentId ||
    credential.workspaceId !== `browser:${envelope.sessionId}` ||
    credential.threadId !== envelope.threadId ||
    credential.runId !== envelope.runId ||
    credential.actorId !== envelope.userId ||
    credential.agentId !== "kestrel-control-plane" ||
    credential.providerKey !== "built_in.browser" ||
    credential.resourceId !== envelope.sessionId ||
    credential.capability !== operation ||
    credential.operation !== operation ||
    credential.operationBinding !== binding ||
    envelope.machine.appName !== input.expectedAppName
  ) throw new Error("invalid credential scope");
}

function requirePrepareEnvelope(value: unknown): Scope & Record<string, unknown> {
  const record = requireRecord(value);
  if (record.version !== "hosted_browser_upload_prepare_router_envelope_v1") throw new Error("invalid envelope");
  requireRecord(record.request);
  requiredString(record.capability);
  return requireScope(record) as Scope & Record<string, unknown>;
}

function requireBytesEnvelope(value: unknown): Scope & {
  operationId: string;
  capability: string;
  sizeBytes: number;
  sha256: string;
} {
  const record = requireRecord(value);
  if (
    record.version !== "hosted_browser_upload_bytes_router_envelope_v1" ||
    !Number.isSafeInteger(record.sizeBytes) ||
    Number(record.sizeBytes) < 0 ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.sha256)
  ) throw new Error("invalid envelope");
  const scope = requireScope(record);
  return {
    ...scope,
    operationId: requiredString(record.operationId),
    capability: requiredString(record.capability),
    sizeBytes: Number(record.sizeBytes),
    sha256: record.sha256,
  };
}

function requireScope(record: Record<string, unknown>): Scope {
  const machine = requireRecord(record.machine);
  const appName = requiredString(machine.appName);
  const machineId = requiredString(machine.machineId);
  if (!(
    /^[a-z0-9][a-z0-9-]{0,62}$/u.test(appName)
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(machineId)
  )) throw new Error("invalid machine");
  return {
    organizationId: requiredString(record.organizationId),
    environmentId: requiredString(record.environmentId),
    projectId: requiredString(record.projectId),
    userId: requiredString(record.userId),
    threadId: requiredString(record.threadId),
    runId: requiredString(record.runId),
    sessionId: requiredString(record.sessionId),
    machine: { appName, machineId },
  };
}

async function workerFetch(
  input: Parameters<typeof handleBrowserUpload>[0],
  machine: Scope["machine"],
  pathname: string,
  init: RequestInit,
) {
  return await (input.fetchImpl ?? fetch)(
    new URL(`http://${machine.machineId}.vm.${machine.appName}.internal:43105${pathname}`),
    { ...init, redirect: "error", signal: AbortSignal.timeout(60_000) },
  );
}

async function relay(response: ServerResponse, upstream: Response, maximum: number) {
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error("worker response too large");
  response.writeHead(upstream.status, {
    "cache-control": "no-store",
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  response.end(bytes);
}

async function readBounded(request: IncomingMessage, maximum: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > maximum) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function singleHeader(value: string | string[] | undefined) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024) throw new Error("invalid header");
  return value;
}
function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid record");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid string");
  return value;
}
