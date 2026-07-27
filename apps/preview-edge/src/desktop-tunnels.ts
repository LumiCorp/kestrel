import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const MAX_HTTP_BODY_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REVALIDATE_MS = 30_000;

type PendingHttp = {
  resolve(value: DesktopHttpResponse): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

type DesktopHttpResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
};

export type DesktopPreviewTunnelAuthorization = {
  expiresAtMs: number;
  revalidate?:
    | (() => Promise<DesktopPreviewTunnelAuthorization | false>)
    | undefined;
};

type ActiveConnector = {
  previewId: string;
  socket: WebSocket;
  expiresAtMs: number;
  expiryTimer?: NodeJS.Timeout | undefined;
  revalidateTimer?: NodeJS.Timeout | undefined;
  revalidating: boolean;
  revalidate?:
    | (() => Promise<DesktopPreviewTunnelAuthorization | false>)
    | undefined;
};

export class DesktopPreviewTunnelRegistry {
  readonly #connectors = new Map<string, ActiveConnector>();
  readonly #pendingHttp = new Map<string, PendingHttp>();
  readonly #publicSockets = new Map<
    string,
    { previewId: string; socket: WebSocket }
  >();
  readonly #publicServer = new WebSocketServer({ noServer: true });
  readonly #revalidateMs: number;

  constructor(input: { revalidateMs?: number | undefined } = {}) {
    this.#revalidateMs = input.revalidateMs ?? DEFAULT_REVALIDATE_MS;
  }

  attachConnector(
    previewId: string,
    socket: WebSocket,
    authorization: DesktopPreviewTunnelAuthorization = {
      expiresAtMs: Number.POSITIVE_INFINITY,
    },
  ) {
    const prior = this.#connectors.get(previewId);
    const connector: ActiveConnector = {
      previewId,
      socket,
      expiresAtMs: authorization.expiresAtMs,
      revalidate: authorization.revalidate,
      revalidating: false,
    };
    this.#connectors.set(previewId, connector);
    if (prior) {
      this.#clearConnectorTimers(prior);
      this.#failPreviewTraffic(
        previewId,
        "Desktop preview tunnel was replaced.",
      );
      prior.socket.close(4001, "replaced");
    }
    this.#scheduleConnectorExpiry(connector);
    this.#scheduleConnectorRevalidation(connector);
    socket.on("message", (data) =>
      this.#handleConnectorMessage(previewId, data),
    );
    socket.once("close", () => {
      if (this.#connectors.get(previewId) !== connector) return;
      this.#clearConnectorTimers(connector);
      this.#connectors.delete(previewId);
      this.#failPreviewTraffic(
        previewId,
        "Desktop preview tunnel disconnected.",
      );
    });
  }

  isConnected(previewId: string) {
    const connector = this.#connectors.get(previewId);
    if (!connector) return false;
    if (connector.expiresAtMs <= Date.now()) {
      this.#expireConnector(connector, "Desktop preview tunnel expired.");
      return false;
    }
    return connector.socket.readyState === WebSocket.OPEN;
  }

  async proxyHttp(input: {
    previewId: string;
    request: IncomingMessage;
    response: ServerResponse;
    path: string;
  }) {
    const connector = this.#requireConnector(input.previewId);
    const body = await readRequestBody(input.request);
    const requestId = randomUUID();
    const key = `${input.previewId}:${requestId}`;
    const result = await new Promise<DesktopHttpResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingHttp.delete(key);
        reject(new Error("Desktop preview request timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.#pendingHttp.set(key, { resolve, reject, timeout });
      connector.socket.send(
        JSON.stringify({
          type: "http.request",
          id: requestId,
          method: input.request.method ?? "GET",
          path: input.path,
          headers: sanitizeHeaders(input.request.headers),
          body: body.toString("base64"),
        }),
      );
    });
    input.response.writeHead(result.status, result.headers);
    input.response.end(result.body);
  }

  proxyWebSocket(input: {
    previewId: string;
    request: IncomingMessage;
    socket: Duplex;
    head: Buffer;
    path: string;
  }) {
    const connector = this.#requireConnector(input.previewId);
    this.#publicServer.handleUpgrade(
      input.request,
      input.socket,
      input.head,
      (publicSocket) => {
        const channelId = randomUUID();
        this.#publicSockets.set(channelId, {
          previewId: input.previewId,
          socket: publicSocket,
        });
        connector.socket.send(
          JSON.stringify({
            type: "websocket.open",
            id: channelId,
            path: input.path,
            headers: sanitizeHeaders(input.request.headers),
          }),
        );
        publicSocket.on("message", (data, isBinary) => {
          if (connector.socket.readyState === WebSocket.OPEN) {
            connector.socket.send(
              JSON.stringify({
                type: "websocket.data",
                id: channelId,
                binary: isBinary,
                data: rawDataBuffer(data).toString("base64"),
              }),
            );
          }
        });
        publicSocket.once("close", (code, reason) => {
          this.#publicSockets.delete(channelId);
          if (connector.socket.readyState === WebSocket.OPEN) {
            connector.socket.send(
              JSON.stringify({
                type: "websocket.close",
                id: channelId,
                code,
                reason: reason.toString(),
              }),
            );
          }
        });
      },
    );
  }

  close() {
    for (const connector of this.#connectors.values()) {
      this.#clearConnectorTimers(connector);
      connector.socket.close(1001);
    }
    for (const { socket } of this.#publicSockets.values()) socket.close(1001);
  }

  #requireConnector(previewId: string) {
    const connector = this.#connectors.get(previewId);
    if (connector && connector.expiresAtMs <= Date.now()) {
      this.#expireConnector(connector, "Desktop preview tunnel expired.");
      throw new Error("Desktop preview tunnel is unavailable.");
    }
    if (connector?.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Desktop preview tunnel is unavailable.");
    }
    return connector;
  }

  #scheduleConnectorExpiry(connector: ActiveConnector) {
    if (!Number.isFinite(connector.expiresAtMs)) return;
    const delay = Math.max(1, connector.expiresAtMs - Date.now());
    connector.expiryTimer = setTimeout(() => {
      this.#expireConnector(connector, "Desktop preview tunnel expired.");
    }, delay);
    connector.expiryTimer.unref();
  }

  #scheduleConnectorRevalidation(connector: ActiveConnector) {
    if (!connector.revalidate) return;
    connector.revalidateTimer = setInterval(() => {
      if (connector.revalidating) return;
      connector.revalidating = true;
      connector.revalidate!()
        .then((authorization) => {
          if (this.#connectors.get(connector.previewId) !== connector) return;
          if (!authorization) {
            this.#expireConnector(
              connector,
              "Desktop preview tunnel was revoked.",
            );
            return;
          }
          connector.expiresAtMs = authorization.expiresAtMs;
          connector.revalidate =
            authorization.revalidate ?? connector.revalidate;
          if (connector.expiryTimer) clearTimeout(connector.expiryTimer);
          connector.expiryTimer = undefined;
          this.#scheduleConnectorExpiry(connector);
        })
        .catch(() => {
          if (this.#connectors.get(connector.previewId) === connector) {
            this.#expireConnector(
              connector,
              "Desktop preview tunnel could not be revalidated.",
            );
          }
        })
        .finally(() => {
          connector.revalidating = false;
        });
    }, this.#revalidateMs);
    connector.revalidateTimer.unref();
  }

  #expireConnector(connector: ActiveConnector, message: string) {
    if (this.#connectors.get(connector.previewId) !== connector) return;
    this.#clearConnectorTimers(connector);
    this.#connectors.delete(connector.previewId);
    this.#failPreviewTraffic(connector.previewId, message);
    connector.socket.close(4003, message.slice(0, 123));
  }

  #clearConnectorTimers(connector: ActiveConnector) {
    if (connector.expiryTimer) clearTimeout(connector.expiryTimer);
    if (connector.revalidateTimer) clearInterval(connector.revalidateTimer);
    connector.expiryTimer = undefined;
    connector.revalidateTimer = undefined;
  }

  #failPreviewTraffic(previewId: string, message: string) {
    for (const [id, pending] of this.#pendingHttp) {
      if (id.startsWith(`${previewId}:`)) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(message));
        this.#pendingHttp.delete(id);
      }
    }
    for (const [id, publicConnection] of this.#publicSockets) {
      if (publicConnection.previewId === previewId) {
        publicConnection.socket.close(1012, message.slice(0, 123));
        this.#publicSockets.delete(id);
      }
    }
  }

  #handleConnectorMessage(previewId: string, raw: WebSocket.RawData) {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawDataBuffer(raw).toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "http.response" && typeof message.id === "string") {
      const key = `${previewId}:${message.id}`;
      const pending = this.#pendingHttp.get(key);
      if (!pending) return;
      this.#pendingHttp.delete(key);
      clearTimeout(pending.timeout);
      try {
        const status = requireStatus(message.status);
        const headers = parseResponseHeaders(message.headers);
        const body = parseBase64(message.body, MAX_HTTP_BODY_BYTES);
        pending.resolve({ status, headers, body });
      } catch (error) {
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return;
    }
    if (typeof message.id !== "string") return;
    const publicConnection = this.#publicSockets.get(message.id);
    if (!publicConnection || publicConnection.previewId !== previewId) return;
    const publicSocket = publicConnection.socket;
    if (message.type === "websocket.data") {
      try {
        publicSocket.send(parseBase64(message.data, MAX_HTTP_BODY_BYTES), {
          binary: message.binary === true,
        });
      } catch {
        publicSocket.close(1011);
      }
    } else if (message.type === "websocket.close") {
      publicSocket.close(
        typeof message.code === "number" ? message.code : 1000,
        typeof message.reason === "string" ? message.reason.slice(0, 123) : "",
      );
    } else if (message.type === "websocket.error") {
      publicSocket.close(1011);
    }
  }
}

function sanitizeHeaders(headers: IncomingHttpHeaders) {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      [
        "connection",
        "upgrade",
        "proxy-authorization",
        "x-kestrel-preview-access",
      ].includes(name.toLowerCase())
    ) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_HTTP_BODY_BYTES)
      throw new Error("Preview request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseResponseHeaders(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string | string[]> = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (
      ["connection", "transfer-encoding", "content-length", "upgrade"].includes(
        name.toLowerCase(),
      )
    ) {
      continue;
    }
    if (typeof candidate === "string") result[name] = candidate;
    else if (
      Array.isArray(candidate) &&
      candidate.every((item) => typeof item === "string")
    ) {
      result[name] = candidate;
    }
  }
  return result;
}

function parseBase64(value: unknown, maximum: number) {
  if (typeof value !== "string") throw new Error("Tunnel body is invalid.");
  const body = Buffer.from(value, "base64");
  if (body.length > maximum) throw new Error("Tunnel body is too large.");
  return body;
}

function requireStatus(value: unknown) {
  if (
    !Number.isInteger(value) ||
    (value as number) < 100 ||
    (value as number) > 599
  ) {
    throw new Error("Tunnel response status is invalid.");
  }
  return value as number;
}

function rawDataBuffer(value: WebSocket.RawData) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(new Uint8Array(value));
}
