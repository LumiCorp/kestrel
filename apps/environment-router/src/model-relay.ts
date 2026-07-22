import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnvironmentGatewayConfigClient } from "./gateway-config.js";

const MAX_MODEL_REQUEST_BYTES = 32 * 1024 * 1024;
const MODEL_PATH =
  /^\/internal\/models\/([^/]+)(\/(?:v1\/(?:chat\/completions|responses|messages)|api\/v1\/(?:chat\/completions|responses)))$/u;

export async function handleModelRelay(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: EnvironmentGatewayConfigClient;
}) {
  const match = new URL(
    input.request.url ?? "/",
    "http://gateway.internal"
  ).pathname.match(MODEL_PATH);
  if (!(match?.[1] && match[2]) || input.request.method !== "POST") {
    writeError(input.response, 404, "MODEL_RELAY_ROUTE_NOT_FOUND");
    return;
  }
  let runId: string;
  try {
    runId = decodeURIComponent(match[1]);
  } catch (error) {
    writeError(input.response, 400, "MODEL_RELAY_RUN_INVALID");
    return;
  }
  const token = readWorkspaceToken(input.request);
  if (!token) {
    writeError(input.response, 401, "MODEL_RELAY_AUTHORIZATION_REQUIRED");
    return;
  }
  let config = input.config.snapshot;
  if (!config) {
    try {
      config = await input.config.refresh();
    } catch {
      writeError(input.response, 503, "MODEL_RELAY_CONFIG_UNAVAILABLE");
      return;
    }
  }
  let workspace = config.workspaces.find((candidate) =>
    matchesToken(token, candidate.serviceTokenHash)
  );
  let grant = config.modelGrants.find(
    (candidate) => candidate.runId === runId && candidate.workspaceId === workspace?.id
  );
  if (!grant || Date.parse(grant.credentialExpiresAt) <= Date.now()) {
    try {
      config = await input.config.refresh();
      workspace = config.workspaces.find((candidate) =>
        matchesToken(token, candidate.serviceTokenHash)
      );
      grant = config.modelGrants.find(
        (candidate) => candidate.runId === runId && candidate.workspaceId === workspace?.id
      );
    } catch {
      grant = undefined;
    }
  }
  if (!(workspace && grant)) {
    writeError(input.response, 403, "MODEL_RELAY_GRANT_DENIED");
    return;
  }
  if (!pathAllowedForGrant(grant.provider, grant.protocol, match[2])) {
    writeError(input.response, 404, "MODEL_RELAY_PROVIDER_PATH_DENIED");
    return;
  }
  let rawBody: Buffer;
  let body: Record<string, unknown>;
  try {
    rawBody = await readBoundedBody(input.request);
    const parsed = JSON.parse(rawBody.toString("utf8"));
    if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
      throw new Error("invalid body");
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    writeError(
      input.response,
      error instanceof ModelRelayBodyTooLargeError ? 413 : 400,
      error instanceof ModelRelayBodyTooLargeError
        ? "MODEL_RELAY_BODY_TOO_LARGE"
        : "MODEL_RELAY_BODY_INVALID"
    );
    return;
  }
  if (body.model !== grant.rawModelId) {
    writeError(input.response, 403, "MODEL_RELAY_MODEL_DENIED");
    return;
  }
  if (!grant.baseUrl || (!grant.apiKey && grant.provider !== "ollama")) {
    writeError(input.response, 503, "MODEL_RELAY_PROVIDER_UNAVAILABLE");
    return;
  }
  const controller = new AbortController();
  input.response.once("close", () => controller.abort());
  try {
    const upstream = await fetch(
      `${grant.baseUrl.replace(/\/+$/u, "")}${match[2]}`,
      {
        method: "POST",
        headers: providerHeaders(input.request, grant.protocol, grant.apiKey),
        body: rawBody,
        signal: controller.signal,
      }
    );
    input.response.writeHead(upstream.status, responseHeaders(upstream.headers));
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (!input.response.write(Buffer.from(chunk))) {
          await new Promise<void>((resolve) => input.response.once("drain", resolve));
        }
      }
    }
    input.response.end();
  } catch {
    if (!input.response.headersSent) {
      writeError(input.response, 502, "MODEL_RELAY_PROVIDER_FAILED");
    } else {
      input.response.destroy();
    }
  }
}

function providerHeaders(
  request: IncomingMessage,
  protocol: "openai" | "anthropic",
  apiKey: string | null
) {
  const headers: Record<string, string> = {
    accept: request.headers.accept ?? "application/json",
    "content-type": "application/json",
  };
  if (protocol === "anthropic") {
    if (apiKey) headers["x-api-key"] = apiKey;
    const version = request.headers["anthropic-version"];
    headers["anthropic-version"] =
      typeof version === "string" ? version : "2023-06-01";
    const beta = request.headers["anthropic-beta"];
    if (typeof beta === "string") headers["anthropic-beta"] = beta;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function responseHeaders(headers: Headers) {
  const result: Record<string, string> = { "cache-control": "no-store" };
  for (const name of [
    "content-type",
    "request-id",
    "x-request-id",
    "retry-after",
  ]) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

function readWorkspaceToken(request: IncomingMessage) {
  const authorization = request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (authorization) return authorization;
  const anthropic = request.headers["x-api-key"];
  return typeof anthropic === "string" && anthropic ? anthropic : null;
}

function matchesToken(token: string, expectedHash: string) {
  const supplied = Buffer.from(
    createHash("sha256").update(token, "utf8").digest("base64url"),
    "utf8"
  );
  const expected = Buffer.from(expectedHash, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function pathAllowedForGrant(
  provider: string,
  protocol: "openai" | "anthropic",
  path: string
) {
  if (protocol === "anthropic") return path === "/v1/messages";
  if (provider === "openrouter") {
    return path === "/api/v1/chat/completions" || path === "/api/v1/responses";
  }
  return path === "/v1/chat/completions" || path === "/v1/responses";
}

async function readBoundedBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_MODEL_REQUEST_BYTES) throw new ModelRelayBodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class ModelRelayBodyTooLargeError extends Error {}

function writeError(response: ServerResponse, status: number, code: string) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: { code } }));
}
