import type { RunnerCommand, RunnerErrorEventPayload, RunnerEvent } from "../contracts.js";
import type { ProtocolTransport } from "./ProtocolClient.js";
import { consumeSseEventPayloads, parseRunnerEvent } from "./runnerSse.js";

export interface RemoteRunnerTransportOptions {
  baseUrl: string;
  authToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class RemoteRunnerTransport implements ProtocolTransport {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly controllers = new Map<string, AbortController>();
  private handlers:
    | {
        onLine: (line: string) => void;
        onExit: (code: number | null) => void;
      }
    | undefined;
  private closed = false;

  constructor(options: RemoteRunnerTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
  }): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    if (this.closed) {
      throw new Error("Remote runner transport is closed.");
    }
    if (this.handlers === undefined) {
      throw new Error("Remote runner transport is not started.");
    }

    let command: RunnerCommand;
    try {
      command = JSON.parse(line) as RunnerCommand;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const controller = new AbortController();
    this.controllers.set(command.id, controller);
    void this.dispatch(command, controller).finally(() => {
      this.controllers.delete(command.id);
    });
  }

  async stop(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.handlers?.onExit(0);
  }

  private async dispatch(command: RunnerCommand, controller: AbortController): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${isStreamingCommand(command.type) ? "/commands/stream" : "/commands"}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: isStreamingCommand(command.type) ? "text/event-stream, application/json" : "application/json",
          ...(this.authToken !== undefined ? { authorization: `Bearer ${this.authToken}` } : {}),
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        await this.consumeSseResponse(response, command.id, controller);
        return;
      }

      const body = await response.text();
      const event = parseRunnerEvent(body);
      if (event !== undefined) {
        this.emitEvent(event);
        return;
      }

      if (response.ok === false) {
        this.emitEvent(makeSyntheticRunnerError(command.id, {
          code: "RUNNER_HTTP_ERROR",
          message: `Remote runner returned HTTP ${response.status}.`,
          details: {
            status: response.status,
            ...(body.length > 0 ? { body } : {}),
          },
        }));
        return;
      }

      this.emitEvent(makeSyntheticRunnerError(command.id, {
        code: "RUNNER_PROTOCOL_ERROR",
        message: "Remote runner returned an unreadable response.",
        details: {
          status: response.status,
          ...(body.length > 0 ? { body } : {}),
        },
      }));
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      this.emitEvent(makeSyntheticRunnerError(command.id, {
        code: "RUNNER_TRANSPORT_ERROR",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async consumeSseResponse(
    response: Response,
    commandId: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      await consumeSseEventPayloads(response, (eventType, data) => {
        const event = parseRunnerEvent(data);
        if (event !== undefined) {
          this.emitEvent(event);
          return;
        }
        this.emitEvent(makeSyntheticRunnerError(commandId, {
          code: "RUNNER_PROTOCOL_ERROR",
          message: `Remote runner emitted invalid SSE payload for '${eventType || "message"}'.`,
          details: {
            status: response.status,
            body: data,
          },
        }));
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return;
      }
      this.emitEvent(makeSyntheticRunnerError(commandId, {
        code: "RUNNER_PROTOCOL_ERROR",
        message: error instanceof Error ? error.message : String(error),
        details: {
          status: response.status,
        },
      }));
    }
  }

  private emitEvent(event: RunnerEvent): void {
    this.handlers?.onLine(JSON.stringify(event));
  }
}

function isStreamingCommand(type: RunnerCommand["type"]): boolean {
  return type === "run.start";
}

function makeSyntheticRunnerError(commandId: string, payload: RunnerErrorEventPayload): RunnerEvent {
  return {
    id: `runner-error-${commandId}`,
    type: "runner.error",
    ts: new Date().toISOString(),
    commandId,
    payload,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
