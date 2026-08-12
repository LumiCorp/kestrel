import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import readline from "node:readline";
import type { RuntimeEnvironmentMap } from "../contracts.js";

import type {
  CodexRequestId,
  CodexAnyServerRequest,
  CodexServerNotification,
  CodexServerRequest,
} from "./protocol.js";

const require = createRequire(import.meta.url);

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface CodexAppServerClientOptions {
  env?: RuntimeEnvironmentMap | undefined;
  onNotification?: ((notification: CodexServerNotification) => void) | undefined;
  onServerRequest?: ((request: CodexAnyServerRequest) => void) | undefined;
  onExit?: ((error: Error) => void) | undefined;
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private initialized = false;
  private closing = false;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  async start(): Promise<void> {
    if (this.initialized) return;
    this.closing = false;
    const bin = require.resolve("@openai/codex/bin/codex.js");
    const child = spawn(process.execPath, [bin, "app-server", "--stdio"], {
      env: {
        ...this.options.env,
        NODE_ENV: normalizeNodeEnvironment(
          this.options.env?.NODE_ENV ?? process.env.NODE_ENV,
        ),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    child.stderr.on("data", () => {
      // App-server stderr is diagnostic-only and may contain local paths.
    });
    child.once("exit", (code, signal) => {
      const error = new Error(
        `Codex app-server exited before disposal (code=${String(code)}, signal=${String(signal)}).`,
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.initialized = false;
      this.process = undefined;
      if (!this.closing) this.options.onExit?.(error);
    });
    child.once("error", (error) => {
      if (!this.closing) this.options.onExit?.(error);
    });
    await this.request("initialize", {
      clientInfo: { name: "kestrel-hydra", title: "Kestrel", version: "0.7.0" },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        extensions: {},
      },
    });
    this.notify("initialized");
    this.initialized = true;
  }

  async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return (await promise) as TResult;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  respond(id: CodexRequestId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: CodexRequestId, error: JsonRpcError): void {
    this.write({ jsonrpc: "2.0", id, error });
  }

  close(): void {
    this.closing = true;
    const child = this.process;
    this.process = undefined;
    this.initialized = false;
    child?.kill("SIGTERM");
  }

  private write(message: Record<string, unknown>): void {
    if (this.process === undefined) {
      throw new Error("Codex app-server is not running.");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        pending.reject(
          new Error(
            typeof message.error.message === "string"
              ? message.error.message
              : "Codex app-server request failed.",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if ("id" in message) {
      this.options.onServerRequest?.(message as unknown as CodexAnyServerRequest);
    } else {
      this.options.onNotification?.(message as unknown as CodexServerNotification);
    }
  }
}

function normalizeNodeEnvironment(
  value: string | undefined,
): "development" | "production" | "test" {
  return value === "development" || value === "test" ? value : "production";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
