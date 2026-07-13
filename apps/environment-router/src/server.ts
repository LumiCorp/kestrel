import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  authorizeEnvironmentHttpRequest,
  authorizeEnvironmentRequest,
  authorizeEnvironmentSubscription,
} from "./router.js";
import { proxyWorkspaceRequest } from "./proxy.js";

const port = readPort(process.env.PORT);
const publicKey = process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "";
const expectedAppName = required(
  process.env.KESTREL_ENVIRONMENT_APP_NAME,
  "KESTREL_ENVIRONMENT_APP_NAME"
);

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "environment-router" }));
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://router.internal").pathname;
  const isCommand = request.method === "POST" && (pathname === "/commands" || pathname === "/commands/stream");
  const isWorkspaceApi = pathname.startsWith("/v1/");
  const isSubscription =
    request.method === "POST" && pathname === "/events/stream";
  if (!(isCommand || isWorkspaceApi || isSubscription)) {
    response.writeHead(404).end();
    return;
  }
  if (isWorkspaceApi) {
    const decision = authorizeEnvironmentHttpRequest({
      authorization: request.headers.authorization,
      pathname,
      method: request.method ?? "GET",
      publicKey,
      expectedAppName,
    });
    await applyDecision(request, response, decision);
    return;
  }
  const body = await readJsonBody(request);
  if (!body.ok) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: body.code } }));
    return;
  }
  const decision = isSubscription
    ? authorizeEnvironmentSubscription({
        authorization: request.headers.authorization,
        body: body.value,
        publicKey,
        expectedAppName,
      })
    : authorizeEnvironmentRequest({
        authorization: request.headers.authorization,
        body: body.value,
        publicKey,
        expectedAppName,
      });
  await applyDecision(request, response, decision, body.raw);
}).listen(port);

async function applyDecision(
  request: IncomingMessage,
  response: ServerResponse,
  decision: ReturnType<typeof authorizeEnvironmentRequest>,
  bufferedBody?: Buffer
) {
  if (decision.status !== 200) {
    process.stdout.write(
      `${JSON.stringify({
        type: "environment.router.denied",
        code: decision.code,
        status: decision.status,
        occurredAt: new Date().toISOString(),
      })}\n`
    );
    response.writeHead(decision.status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: decision.code } }));
    return;
  }
  await proxyWorkspaceRequest({
    request,
    response,
    targetUrl: decision.targetUrl,
    bufferedBody,
  });
}

async function readJsonBody(request: NodeJS.ReadableStream): Promise<
  | { ok: true; value: unknown; raw: Buffer }
  | { ok: false; code: string }
> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 2_000_000) return { ok: false, code: "REQUEST_TOO_LARGE" };
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  try {
    return { ok: true, value: JSON.parse(raw.toString("utf8")), raw };
  } catch {
    return { ok: false, code: "REQUEST_JSON_INVALID" };
  }
}

function readPort(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "8080", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  return parsed;
}

function required(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
