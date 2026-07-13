import { promises as dns } from "node:dns";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import {
  assertPublicMcpResolvedAddresses,
  normalizeMcpResolutionHostname,
} from "@kestrel/mcp-security";

export function createOciEgressBroker(input: { allowlist: string[] }): Server {
  const allowedOrigins = new Set(
    input.allowlist.map((entry) => normalizeHttpsOrigin(entry)),
  );
  const server = createServer((_request, response) => {
    response.writeHead(405).end();
  });
  server.on("connect", (request, clientSocket, head) => {
    void (async () => {
      const endpoint = parseConnectTarget(request.url);
      if (!allowedOrigins.has(endpoint.origin)) {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      const resolved = await dns.lookup(
        normalizeMcpResolutionHostname(endpoint.hostname),
        {
          all: true,
          verbatim: true,
        },
      );
      const addresses = resolved.map((entry) => {
        if (entry.family !== 4 && entry.family !== 6) {
          throw new Error("OCI egress destination resolved unexpectedly.");
        }
        return { address: entry.address, family: entry.family as 4 | 6 };
      });
      assertPublicMcpResolvedAddresses(addresses);
      const pinned = addresses[0];
      if (!pinned) throw new Error("OCI egress destination did not resolve.");
      const upstream = connect({
        host: pinned.address,
        port: Number(endpoint.port || 443),
        family: pinned.family,
      });
      upstream.once("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once("error", () => clientSocket.destroy());
      clientSocket.once("error", () => upstream.destroy());
    })().catch(() => {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    });
  });
  return server;
}

export function normalizeHttpsOrigin(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("OCI MCP egress allowlist entries must be HTTPS origins.");
  }
  return endpoint.origin;
}

function parseConnectTarget(value: string | undefined): URL {
  if (!value) throw new Error("OCI egress CONNECT target is required.");
  const endpoint = new URL(`https://${value}`);
  if (endpoint.pathname !== "/") {
    throw new Error("OCI egress CONNECT target is invalid.");
  }
  return endpoint;
}
