import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnvironmentGatewayConfigClient } from "./gateway-config.js";

const V1 = "workspace-idle-notification-v1";
const V2 = "workspace-idle-notification-v2";

export async function handleWorkspaceIdle(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: EnvironmentGatewayConfigClient;
}) {
  if (input.request.method !== "POST") return write(input.response, 404, "WORKSPACE_IDLE_ROUTE_NOT_FOUND");
  const token = input.request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  let body: Record<string, unknown>;
  try {
    const raw = await readBody(input.request);
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) throw new Error();
    body = parsed as Record<string, unknown>;
    if (!validIdleBody(body)) throw new Error();
  } catch {
    return write(input.response, 400, "WORKSPACE_IDLE_NOTIFICATION_INVALID");
  }
  let config = input.config.snapshot;
  if (!config) config = await input.config.refresh().catch(() => null);
  const workspace = config?.workspaces.find((candidate) => {
    if (
      candidate.id !== body.workspaceId ||
      typeof token !== "string" ||
      !matchesToken(token, candidate.serviceTokenHash)
    ) return false;
    return body.version === V2 || (
      body.version === V1 &&
      config.version === 3 &&
      "machineId" in candidate &&
      candidate.machineId === body.machineId
    );
  });
  if (
    !workspace ||
    (body.version !== V1 && body.version !== V2) ||
    body.environmentId !== config?.environmentId
  ) return write(input.response, 403, "WORKSPACE_IDLE_UNAUTHORIZED");
  try {
    const result = await input.config.notifyWorkspaceIdle(body);
    input.response.writeHead(202, { "cache-control": "no-store", "content-type": "application/json" });
    input.response.end(JSON.stringify(result));
  } catch {
    write(input.response, 502, "WORKSPACE_IDLE_CONTROL_PLANE_FAILED");
  }
}

function validIdleBody(body: Record<string, unknown>) {
  const expected = body.version === V1
    ? ["version", "organizationId", "environmentId", "workspaceId", "machineId", "lastActivityAt"]
    : body.version === V2
      ? ["version", "organizationId", "environmentId", "workspaceId", "lastActivityAt"]
      : [];
  return expected.length > 0 &&
    Object.keys(body).length === expected.length &&
    expected.every((key) => Object.hasOwn(body, key)) &&
    expected.filter((key) => key !== "version" && key !== "lastActivityAt")
      .every((key) => typeof body[key] === "string" && body[key] !== "") &&
    typeof body.lastActivityAt === "string" &&
    Number.isFinite(Date.parse(body.lastActivityAt));
}

function matchesToken(token: string, expectedHash: string) {
  const supplied = Buffer.from(createHash("sha256").update(token, "utf8").digest("base64url"));
  const expected = Buffer.from(expectedHash);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 100_000) throw new Error();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function write(response: ServerResponse, status: number, code: string) {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code } }));
}
