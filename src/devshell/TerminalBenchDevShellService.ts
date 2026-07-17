import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  DevProcessReadInput,
  DevProcessReadResult,
  DevProcessStartInput,
  DevProcessStartResult,
  DevProcessStopInput,
  DevProcessStopResult,
  DevProcessWriteAndReadInput,
  DevProcessWriteAndReadResult,
  DevProcessWriteInput,
  DevProcessWriteResult,
  DevShellServicePort,
  DevShellRunInput,
  DevShellRunResult,
} from "./contracts.js";
import { DEV_SHELL_BRIDGE_URL_ENV } from "./contracts.js";

export class TerminalBenchDevShellService implements DevShellServicePort {
  private readonly baseUrl: URL;

  constructor(baseUrl: string) {
    const trimmed = baseUrl.trim();
    if (trimmed.length === 0) {
      throw createRuntimeFailure(
        "TBENCH_DEV_SHELL_BRIDGE_INVALID_URL",
        `${DEV_SHELL_BRIDGE_URL_ENV} must be a non-empty URL.`,
        {
          subsystem: "dev_shell",
          classification: "configuration",
          recoverable: false,
        },
      );
    }

    this.baseUrl = new URL(trimmed.endsWith("/") ? trimmed : `${trimmed}/`);
  }

  async runCommand(input: DevShellRunInput): Promise<DevShellRunResult> {
    return this.request("POST", "shell/run", input);
  }

  async startProcess(input: DevProcessStartInput): Promise<DevProcessStartResult> {
    return this.request("POST", "processes/start", input);
  }

  async writeProcess(input: DevProcessWriteInput): Promise<DevProcessWriteResult> {
    return this.request(
      "POST",
      `processes/${encodeURIComponent(input.processId)}/write`,
      input,
    );
  }

  async writeAndReadProcess(input: DevProcessWriteAndReadInput): Promise<DevProcessWriteAndReadResult> {
    return this.request(
      "POST",
      `processes/${encodeURIComponent(input.processId)}/write_and_read`,
      input,
    );
  }

  async readProcess(input: DevProcessReadInput): Promise<DevProcessReadResult> {
    const query = new URLSearchParams();
    if (input.waitMs !== undefined) {
      query.set("waitMs", String(input.waitMs));
    }
    if (input.maxBytes !== undefined) {
      query.set("maxBytes", String(input.maxBytes));
    }
    if (input.cursor !== undefined) {
      query.set("cursor", String(input.cursor));
    }
    return this.request(
      "GET",
      `processes/${encodeURIComponent(input.processId)}/read?${query.toString()}`,
    );
  }

  async stopProcess(input: DevProcessStopInput): Promise<DevProcessStopResult> {
    return this.request(
      "POST",
      `processes/${encodeURIComponent(input.processId)}/stop`,
      input,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    pathname: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(pathname, this.baseUrl);
    const requestInit: RequestInit = { method };
    if (method === "POST") {
      requestInit.headers = { "content-type": "application/json" };
    }
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(url, requestInit);
    } catch (error) {
      return this.bridgeFailureResult<T>(
        pathname,
        `Terminal-Bench dev shell bridge request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const raw = await response.text();
    let parsed: unknown;
    if (raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return this.bridgeFailureResult<T>(
          pathname,
          `Terminal-Bench dev shell bridge returned invalid JSON. ${raw.slice(0, 500)}`,
        );
      }
    }

    if (response.ok === false) {
      const errorRecord =
        typeof parsed === "object" && parsed !== null && Array.isArray(parsed) === false
          ? parsed as Record<string, unknown>
          : {};
      return this.bridgeFailureResult<T>(
        pathname,
        typeof errorRecord.message === "string"
          ? errorRecord.message
          : `Terminal-Bench dev shell bridge returned HTTP ${response.status}.`,
      );
    }

    return parsed as T;
  }

  private bridgeFailureResult<T>(pathname: string, message: string): T {
    const failureReason = message;
    const text = `${message}\n`;
    const processId = readProcessIdFromPathname(pathname);

    if (pathname.endsWith("/write")) {
      return {
        processId: processId ?? "",
        status: "FAILED",
        bytesWritten: 0,
        message,
      } as T;
    }

    if (pathname.endsWith("/write_and_read")) {
      return {
        ...(processId !== undefined ? { processId } : {}),
        status: "LOST",
        text,
        truncated: false,
        cursor: 0,
        nextCursor: 0,
        bytesWritten: 0,
        failureReason,
      } as T;
    }

    if (pathname === "shell/run") {
      return {
        status: "LOST",
        stdout: "",
        text,
        truncated: false,
        failureReason,
      } as T;
    }

    return {
      ...(processId !== undefined ? { processId } : {}),
      status: "LOST",
      text,
      truncated: false,
      cursor: 0,
      nextCursor: 0,
      failureReason,
    } as T;
  }
}

function readProcessIdFromPathname(pathname: string): string | undefined {
  const match = /^processes\/([^/]+)\//u.exec(pathname);
  return match?.[1] !== undefined ? decodeURIComponent(match[1]) : undefined;
}

export function createTerminalBenchDevShellServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TerminalBenchDevShellService | undefined {
  const bridgeUrl = env[DEV_SHELL_BRIDGE_URL_ENV]?.trim();
  if (bridgeUrl === undefined || bridgeUrl.length === 0) {
    return ;
  }
  return new TerminalBenchDevShellService(bridgeUrl);
}
