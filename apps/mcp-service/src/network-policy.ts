import { promises as dns } from "node:dns";
import {
  assertPublicMcpResolvedAddresses,
  normalizeMcpResolutionHostname,
  type McpResolvedAddress,
} from "@kestrel/mcp-security";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Agent, fetch as undiciFetch } from "undici";

type ResolvedAddress = McpResolvedAddress;
type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export async function createPinnedMcpFetch(input: {
  endpoint: URL;
  resolve?: AddressResolver | undefined;
}): Promise<{ fetch: FetchLike; close: () => Promise<void> }> {
  if (input.endpoint.protocol !== "https:") {
    throw new Error("Remote MCP endpoint must use HTTPS.");
  }
  const resolve = input.resolve ?? resolveAddresses;
  const addresses = await resolve(
    normalizeMcpResolutionHostname(input.endpoint.hostname),
  );
  assertPublicResolvedAddresses(addresses);
  const pinned = addresses[0];
  if (!pinned) {
    throw new Error("Remote MCP endpoint did not resolve to an address.");
  }
  const dispatcher = new Agent({
    maxRedirections: 0,
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, pinned.address, pinned.family);
      },
    },
  });
  const endpointOrigin = input.endpoint.origin;
  const pinnedFetch: FetchLike = async (request, init) => {
    const url = toRequestUrl(request);
    if (url.origin !== endpointOrigin) {
      throw new Error("Remote MCP request escaped its approved origin.");
    }
    const response = await undiciFetch(url, {
      ...(init as import("undici").RequestInit | undefined),
      dispatcher,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Remote MCP redirects are not allowed.");
    }
    return response as unknown as Response;
  };
  return {
    fetch: pinnedFetch,
    close: () => dispatcher.close(),
  };
}

export function assertPublicResolvedAddresses(
  addresses: readonly ResolvedAddress[],
): void {
  assertPublicMcpResolvedAddresses(addresses);
}

async function resolveAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => {
    if (entry.family !== 4 && entry.family !== 6) {
      throw new Error(
        "Remote MCP endpoint resolved to an unsupported address.",
      );
    }
    return { address: entry.address, family: entry.family };
  });
}

function toRequestUrl(request: string | URL | Request): URL {
  if (request instanceof URL) {
    return request;
  }
  if (typeof request === "string") {
    return new URL(request);
  }
  return new URL(request.url);
}
