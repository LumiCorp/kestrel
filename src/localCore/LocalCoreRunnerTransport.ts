import { request } from "node:http";
import { Readable } from "node:stream";

import { RemoteRunnerTransport } from "../../cli/client/RemoteRunnerTransport.js";
import type { LocalCoreConnectionDescriptor } from "./connection.js";

const LOCAL_CORE_RUNTIME_BASE_URL = "http://kestrel.local/runtime/v2";

export type LocalCoreRunnerTransportOptions = LocalCoreConnectionDescriptor;

/**
 * Execution Protocol v2 transport over Local Core's user-only Unix socket.
 *
 * The protocol behavior stays in RemoteRunnerTransport; this adapter only
 * supplies the HTTP connection primitive for a Unix-domain socket.
 */
export class LocalCoreRunnerTransport extends RemoteRunnerTransport {
  constructor(options: LocalCoreRunnerTransportOptions) {
    const socketPath = requireNonEmpty(options.socketPath, "Local Core socket path");
    const authToken = requireNonEmpty(options.authToken, "Local Core auth token");
    super({
      baseUrl: LOCAL_CORE_RUNTIME_BASE_URL,
      authToken,
      fetchImpl: createUnixSocketFetch(socketPath),
    });
  }
}

function createUnixSocketFetch(socketPath: string): typeof fetch {
  const unixSocketFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = readRequestUrl(input);
    const headers = new Headers(init?.headers);
    const body = readRequestBody(init?.body);
    const outgoingHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      outgoingHeaders[name] = value;
    });

    return await new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        {
          socketPath,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers: outgoingHeaders,
          ...(init?.signal !== undefined && init.signal !== null
            ? { signal: init.signal }
            : {}),
        },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(name, entry);
              }
            } else if (value !== undefined) {
              responseHeaders.set(name, value);
            }
          }
          resolve(new Response(
            Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
            {
              status: incoming.statusCode ?? 500,
              ...(incoming.statusMessage !== undefined
                ? { statusText: incoming.statusMessage }
                : {}),
              headers: responseHeaders,
            },
          ));
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  };

  return unixSocketFetch as typeof fetch;
}

function readRequestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function readRequestBody(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body !== "string") {
    throw new Error("Local Core runner transport only accepts serialized JSON request bodies.");
  }
  return body;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must be non-empty.`);
  }
  return normalized;
}
