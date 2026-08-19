import { readFile } from "node:fs/promises";
import https from "node:https";
import type { ConnectorConfig } from "./config.js";

const kubernetesName = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/u;

export class KubernetesApiError extends Error {
  constructor(
    readonly status: number,
    readonly phase: string,
    readonly auditId: string | null,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "KubernetesApiError";
  }
}

export class KubernetesWaitTimeoutError extends Error {
  constructor(readonly phase: string) {
    super(`Kubernetes wait timed out for ${phase}.`);
    this.name = "KubernetesWaitTimeoutError";
  }
}

export class KubernetesClient {
  private constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly agent: https.Agent,
  ) {}

  static async inCluster(config: ConnectorConfig) {
    const [token, ca] = await Promise.all([
      readFile(config.serviceAccountTokenPath, "utf8"),
      readFile(config.serviceAccountCaPath),
    ]);
    return new KubernetesClient(
      `https://${config.kubernetesHost}:${config.kubernetesPort}`,
      token.trim(),
      new https.Agent({ ca, keepAlive: true, maxSockets: 16 }),
    );
  }

  async get(
    path: string,
    options: { allowNotFound?: boolean; signal?: AbortSignal } = {},
  ) {
    return this.request("GET", path, {
      allowNotFound: options.allowNotFound,
      signal: options.signal,
    });
  }

  async create(path: string, body: unknown, options: { signal?: AbortSignal } = {}) {
    return this.request("POST", path, { body, signal: options.signal });
  }

  async replace(path: string, body: unknown, options: { signal?: AbortSignal } = {}) {
    return this.request("PUT", path, { body, signal: options.signal });
  }

  async apply(
    path: string,
    body: unknown,
    fieldManager: string,
    options: { signal?: AbortSignal } = {},
  ) {
    const separator = path.includes("?") ? "&" : "?";
    return this.request(
      "PATCH",
      `${path}${separator}fieldManager=${encodeURIComponent(fieldManager)}&force=false`,
      {
        body,
        contentType: "application/apply-patch+yaml",
        signal: options.signal,
      },
    );
  }

  async strategicMergePatch(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request("PATCH", path, {
      body,
      contentType: "application/strategic-merge-patch+json",
      signal: options.signal,
    });
  }

  async delete(
    path: string,
    options: { allowNotFound?: boolean; signal?: AbortSignal } = {},
  ) {
    return this.request("DELETE", path, {
      allowNotFound: options.allowNotFound,
      body: {
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy: "Foreground",
      },
      signal: options.signal,
    });
  }

  async waitFor(
    path: string,
    predicate: (value: unknown | null) => boolean,
    input: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
  ) {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      input.signal?.throwIfAborted();
      const value = await this.get(path, {
        allowNotFound: true,
        signal: input.signal,
      });
      if (predicate(value)) return value;
      await wait(input.intervalMs ?? 2_000, input.signal);
    }
    throw new KubernetesWaitTimeoutError(safePath(path));
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: {
      body?: unknown;
      contentType?: string;
      allowNotFound?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<unknown | null> {
    assertKubernetesPath(path);
    const bodyText =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await new Promise<{
      status: number;
      headers: httpHeaders;
      body: string;
    }>((resolve, reject) => {
      options.signal?.throwIfAborted();
      const request = https.request(
        new URL(path, this.origin),
        {
          method,
          agent: this.agent,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.token}`,
            ...(bodyText === undefined
              ? {}
              : {
                  "content-type": options.contentType ?? "application/json",
                  "content-length": Buffer.byteLength(bodyText),
                }),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("end", () =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.once("error", reject);
      const abort = () => request.destroy(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      request.once("close", () =>
        options.signal?.removeEventListener("abort", abort),
      );
      if (bodyText !== undefined) request.write(bodyText);
      request.end();
    });
    if (response.status === 404 && options.allowNotFound) return null;
    let parsed: unknown = null;
    if (response.body) {
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new KubernetesApiError(
          response.status,
          `${method} ${safePath(path)}`,
          header(response.headers, "audit-id"),
          "Kubernetes API returned invalid JSON.",
          retryAfterSeconds(response.headers),
        );
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new KubernetesApiError(
        response.status,
        `${method} ${safePath(path)}`,
        header(response.headers, "audit-id"),
        `Kubernetes API rejected the request (${response.status}).`,
        retryAfterSeconds(response.headers),
      );
    }
    return parsed;
  }
}

type httpHeaders = Record<string, string | string[] | undefined>;

function header(headers: httpHeaders, name: string) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function retryAfterSeconds(headers: httpHeaders) {
  const value = Number(header(headers, "retry-after"));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function assertKubernetesName(value: string, label = "Kubernetes name") {
  if (value.length > 253 || !kubernetesName.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function assertOwnedNamespace(value: string, prefix: string) {
  assertKubernetesName(value, "Kubernetes namespace");
  if (!(value.startsWith(`${prefix}-`) || value === prefix)) {
    throw new Error("Kubernetes namespace is outside the configured Kestrel prefix.");
  }
  return value;
}

function assertKubernetesPath(path: string) {
  if (!path.startsWith("/") || path.includes("..") || /[\r\n]/u.test(path)) {
    throw new Error("Kubernetes API path is invalid.");
  }
}

function safePath(path: string) {
  return path.split("?")[0]!.slice(0, 300);
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
