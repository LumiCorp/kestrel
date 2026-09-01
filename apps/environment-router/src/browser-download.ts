import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { CONVERSATION_ATTACHMENT_MAX_FILE_BYTES } from "@kestrel-agents/conversation";
import { verifyEnvironmentToolCredential } from "@lumi/kestrel-environment-auth";

const MAX_CONTROL_BYTES = 128 * 1024;

export async function handleBrowserDownload(input: {
  request: IncomingMessage;
  response: ServerResponse;
  publicKey: string;
  environmentId: string;
  expectedAppName: string;
  fetchImpl?: typeof fetch;
}) {
  try {
    const body = await readBounded(input.request, MAX_CONTROL_BYTES);
    const envelope = requireEnvelope(JSON.parse(body.toString("utf8")));
    authorize(input, body, envelope);
    const upstream = await (input.fetchImpl ?? fetch)(
      new URL(`http://${envelope.machine.machineId}.vm.${envelope.machine.appName}.internal:43105/v1/download/${envelope.action}`),
      {
        method: "POST",
        headers: envelope.action === "bytes"
          ? {
              "content-type": "application/json",
              "x-kestrel-browser-operation-id": envelope.operationId!,
              "x-kestrel-browser-operation-capability": envelope.capability,
            }
          : { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (envelope.action !== "bytes") return await relayBuffered(input.response, upstream);
    const declared = Number(upstream.headers.get("content-length") ?? "-1");
    if (
      !upstream.ok ||
      !upstream.body ||
      declared !== envelope.sizeBytes ||
      declared < 0 ||
      declared > CONVERSATION_ATTACHMENT_MAX_FILE_BYTES ||
      upstream.headers.get("x-kestrel-browser-download-sha256") !== envelope.sha256
    ) throw new Error("invalid worker download response");
    input.response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
      "content-length": String(declared),
      "x-kestrel-browser-download-sha256": envelope.sha256!,
    });
    await pipeline(upstream.body as never, input.response);
  } catch {
    if (!input.response.headersSent) {
      input.response.writeHead(403, { "content-type": "application/json" });
      input.response.end(JSON.stringify({ error: { code: "BROWSER_DOWNLOAD_UNAVAILABLE" } }));
    } else {
      input.response.destroy();
    }
  }
}

type Envelope = {
  action: "prepare" | "bytes" | "release";
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  threadId: string;
  runId: string;
  sessionId: string;
  machine: { appName: string; machineId: string };
  capability: string;
  operationId?: string;
  sizeBytes?: number;
  sha256?: string;
};

function authorize(
  input: Parameters<typeof handleBrowserDownload>[0],
  body: Buffer,
  envelope: Envelope,
) {
  const token = input.request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!token) throw new Error("missing credential");
  const credential = verifyEnvironmentToolCredential({ token, publicKey: input.publicKey });
  const operation = `browser.download.${envelope.action}`;
  const binding = `sha256:${createHash("sha256").update(body).digest("base64url")}`;
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

function requireEnvelope(value: unknown): Envelope & Record<string, unknown> {
  const record = requireRecord(value);
  const action = record.version === "hosted_browser_download_prepare_router_envelope_v1"
    ? "prepare"
    : record.version === "hosted_browser_download_bytes_router_envelope_v1"
      ? "bytes"
      : record.version === "hosted_browser_download_release_router_envelope_v1"
        ? "release"
        : undefined;
  if (!action) {
    throw new Error("invalid envelope");
  }
  const machine = requireRecord(record.machine);
  const result: Envelope = {
    action,
    organizationId: requiredString(record.organizationId),
    environmentId: requiredString(record.environmentId),
    projectId: requiredString(record.projectId),
    userId: requiredString(record.userId),
    threadId: requiredString(record.threadId),
    runId: requiredString(record.runId),
    sessionId: requiredString(record.sessionId),
    machine: {
      appName: requiredString(machine.appName),
      machineId: requiredString(machine.machineId),
    },
    capability: requiredString(record.capability),
  };
  if (action === "prepare") {
    requireRecord(record.request);
  } else if (action === "bytes") {
    result.operationId = requiredString(record.operationId);
    if (!Number.isSafeInteger(record.sizeBytes) || Number(record.sizeBytes) < 0) throw new Error("invalid size");
    result.sizeBytes = Number(record.sizeBytes);
    if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(record.sha256)) throw new Error("invalid hash");
    result.sha256 = record.sha256;
  } else {
    result.operationId = requiredString(record.operationId);
    requireRecord(record.effect);
  }
  return { ...record, ...result };
}

async function relayBuffered(response: ServerResponse, upstream: Response) {
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_CONTROL_BYTES) throw new Error("worker response too large");
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

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid string");
  return value;
}
