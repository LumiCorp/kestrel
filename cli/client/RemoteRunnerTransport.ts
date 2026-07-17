import {
  isRunnerEventAllowedForCommand,
  isRunnerExpectedResponseEvent,
  isRunnerStreamingCommandType,
  isRunnerTerminalResponseEvent,
  parseRunnerCommandV2,
  parseRunnerEventV2,
} from "@kestrel-agents/protocol";

import type { RunnerCommand, RunnerEvent } from "../protocol/contracts.js";
import type { ProtocolTransport } from "./ProtocolClient.js";

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
        onErrorOutput?: ((line: string) => void) | undefined;
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
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    if (this.closed) {
      throw new Error("Remote runner transport is closed");
    }
    if (this.handlers === undefined) {
      throw new Error("Remote runner transport is not started");
    }

    let command: RunnerCommand;
    try {
      command = parseRunnerCommandV2(JSON.parse(line)) as unknown as RunnerCommand;
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
    const onExit = this.handlers?.onExit;
    this.handlers = undefined;
    onExit?.(0);
  }

  private async dispatch(command: RunnerCommand, controller: AbortController): Promise<void> {
    try {
      const stream = isRunnerStreamingCommandType(command.type);
      const response = await this.fetchImpl(`${this.baseUrl}${stream ? "/commands/stream" : "/commands"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream, application/json" : "application/json",
          ...(this.authToken !== undefined ? { Authorization: `Bearer ${this.authToken}` } : {}),
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        await this.consumeSseResponse(response, command);
        return;
      }

      const payload = await response.text();
      const event = parseRunnerEvent(payload);
      if (event !== undefined) {
        if (
          event.commandId !== command.id
          || isRunnerExpectedResponseEvent(command.type, event) === false
        ) {
          this.emitEvent(makeSyntheticRunnerError(
            command.id,
            "Remote runner returned an event for an unexpected command or response type.",
          ));
          return;
        }
        this.emitEvent(event);
        return;
      }

      this.emitEvent(makeSyntheticRunnerError(command.id, `Remote runner returned an unreadable response (${response.status}).`));
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      this.emitEvent(makeSyntheticRunnerError(
        command.id,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  private async consumeSseResponse(response: Response, command: RunnerCommand): Promise<void> {
    const commandId = command.id;
    if (response.body === null) {
      this.emitEvent(makeSyntheticRunnerError(commandId, "Remote runner stream body is empty."));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";
    let data = "";
    let streamSettled = false;

    const emitStreamEvent = (event: RunnerEvent): boolean => {
      if (
        event.commandId !== commandId
        || isRunnerEventAllowedForCommand(command.type, event) === false
      ) {
        streamSettled = true;
        this.emitEvent(makeSyntheticRunnerError(
          commandId,
          "Remote runner emitted an SSE event for an unexpected command or response type.",
        ));
        return false;
      }
      if (isRunnerTerminalResponseEvent(event.type) === false) {
        this.emitEvent(event);
        return true;
      }
      streamSettled = true;
      this.emitEvent(event);
      return false;
    };

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n");
      while (boundary >= 0) {
        const rawLine = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0) {
          const event = parseRunnerEvent(data);
          if (event !== undefined) {
            if (emitStreamEvent(event) === false) {
              await reader.cancel();
              return;
            }
          } else if (data.length > 0) {
            this.emitEvent(makeSyntheticRunnerError(commandId, `Remote runner emitted invalid SSE payload for '${eventType || "message"}'.`));
            await reader.cancel();
            return;
          }
          eventType = "";
          data = "";
        } else if (line.startsWith("event:")) {
          eventType = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          const next = line.slice("data:".length).trim();
          data = data.length === 0 ? next : `${data}\n${next}`;
        }
        boundary = buffer.indexOf("\n");
      }
    }

    const trailing = buffer.trim();
    if (trailing.length > 0) {
      const event = parseRunnerEvent(trailing);
      if (event !== undefined) {
        emitStreamEvent(event);
      }
    }
    if (streamSettled === false) {
      this.emitEvent(makeSyntheticRunnerError(
        commandId,
        "Remote runner SSE stream ended before a terminal event.",
      ));
    }
  }

  private emitEvent(event: RunnerEvent): void {
    this.handlers?.onLine(JSON.stringify(event));
  }
}

function parseRunnerEvent(value: string): RunnerEvent | undefined {
  if (value.trim().length === 0) {
    return ;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return ;
  }
  return parseRunnerEventV2(parsed) as unknown as RunnerEvent;
}

function makeSyntheticRunnerError(commandId: string, message: string): RunnerEvent {
  return {
    id: `runner-error-${commandId}`,
    type: "runner.error",
    ts: new Date().toISOString(),
    commandId,
    payload: {
      code: "RUNNER_RUNTIME_ERROR",
      message,
    },
  };
}
