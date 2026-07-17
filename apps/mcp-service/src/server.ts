import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Pool } from "pg";
import { authorizeMcpRequest, isAllowedOrigin } from "./authorization.js";
import { createGrantMcpServer } from "./grant-server.js";
import { PostgresInvocationAudit } from "./invocation-audit.js";
import { PostgresMcpGrantStore } from "./postgres-grant-store.js";
import { GrantUpstreamManager } from "./upstream.js";
import { McpDiscoveryWorker } from "./discovery-worker.js";
import { PostgresMcpCredentialStore } from "./credential-store.js";
import { PostgresMcpApprovalAuthorizer } from "./approval-authorizer.js";
import { PostgresMcpInteractionCoordinator } from "./interaction-coordinator.js";

const port = readPort(process.env.PORT);
const publicKey = required(
  process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
  "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY"
);
const databaseUrl = required(process.env.DATABASE_URL, "DATABASE_URL");
const allowedOrigins = readAllowedOrigins(
  process.env.KESTREL_MCP_ALLOWED_ORIGINS
);
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const grantStore = new PostgresMcpGrantStore(pool);
const invocationAudit = new PostgresInvocationAudit(pool);
const credentialStore = new PostgresMcpCredentialStore(pool);
const discoveryWorker = new McpDiscoveryWorker(pool, credentialStore);
const approvalAuthorizer = new PostgresMcpApprovalAuthorizer(pool);
const interactionCoordinator = new PostgresMcpInteractionCoordinator(pool);
const sessions = new Map<
  string,
  {
    grantId: string;
    transport: StreamableHTTPServerTransport;
    server: ReturnType<typeof createGrantMcpServer>;
    upstreams: GrantUpstreamManager;
    expiresAt: Date;
    lastSeenAt: Date;
  }
>();

createServer((request, response) => {
  void handleRequest(request, response).catch(() => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    writeJson(response, 500, {
      error: { code: "MCP_INTERNAL_ERROR" },
    });
  });
}).listen(port);

async function handleRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    try {
      const queue = await pool.query<{
        queued: string;
        running: string;
        failed: string;
      }>(`SELECT count(*) FILTER (WHERE status = 'queued')::text AS queued,
                 count(*) FILTER (WHERE status = 'running')::text AS running,
                 count(*) FILTER (WHERE status = 'failed')::text AS failed
            FROM mcp_discovery_jobs
           WHERE created_at >= now() - interval '24 hours'`);
      const counts = queue.rows[0];
      writeJson(response, 200, {
        ok: true,
        service: "kestrel-mcp-service",
        sessions: { active: sessions.size },
        discovery: {
          ...discoveryWorker.getStatus(),
          queued: Number.parseInt(counts?.queued ?? "0", 10),
          running: Number.parseInt(counts?.running ?? "0", 10),
          failedLast24Hours: Number.parseInt(counts?.failed ?? "0", 10),
        },
      });
    } catch {
      writeJson(response, 503, {
        ok: false,
        service: "kestrel-mcp-service",
        code: "DATABASE_UNAVAILABLE",
      });
    }
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://mcp.internal").pathname;
  if (pathname !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  if (
    !isAllowedOrigin({
      origin: readHeader(request.headers.origin),
      allowedOrigins,
    })
  ) {
    writeJson(response, 403, { error: { code: "MCP_ORIGIN_FORBIDDEN" } });
    return;
  }
  const authorization = await authorizeMcpRequest({
    headers: request.headers,
    publicKey,
    grantStore,
  });
  if (!authorization.ok) {
    writeJson(response, authorization.status, {
      error: { code: authorization.code },
    });
    return;
  }
  const requestedSessionId = readHeader(request.headers["mcp-session-id"]);
  let session = requestedSessionId
    ? sessions.get(requestedSessionId)
    : undefined;
  if (session && session.grantId !== authorization.grant.id) {
    writeJson(response, 403, { error: { code: "MCP_SESSION_FORBIDDEN" } });
    return;
  }
  if (!session) {
    if (requestedSessionId) {
      writeJson(response, 404, { error: { code: "MCP_SESSION_NOT_FOUND" } });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, {
          grantId: authorization.grant.id,
          transport,
          server,
          upstreams,
          expiresAt: authorization.grant.expiresAt,
          lastSeenAt: new Date(),
        });
      },
    });
    const upstreams = new GrantUpstreamManager(authorization.grant, {
      workspaceBasePath: process.env.KESTREL_MCP_WORKSPACE_ROOT,
      credentialStore,
      interactionCoordinator,
    });
    const server = createGrantMcpServer({
      grant: authorization.grant,
      upstreams,
      audit: invocationAudit,
      approvalAuthorizer,
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
      void upstreams.close();
    };
    await server.connect(transport);
    session = {
      grantId: authorization.grant.id,
      transport,
      server,
      upstreams,
      expiresAt: authorization.grant.expiresAt,
      lastSeenAt: new Date(),
    };
  }
  session.lastSeenAt = new Date();
  await session.transport.handleRequest(request, response);
}

void discoveryWorker.pollOnce().catch(() => {});
setInterval(() => {
  void discoveryWorker.pollOnce().catch(() => {});
}, 2000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    const idleFor = now - session.lastSeenAt.getTime();
    if (session.expiresAt.getTime() > now && idleFor < 10 * 60_000) {
      continue;
    }
    sessions.delete(sessionId);
    void session.transport.close().catch(() => {});
    void session.upstreams.close().catch(() => {});
  }
}, 30_000).unref();

function readAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => new URL(entry).origin)
  );
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readPort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "8090", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  return parsed;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}
