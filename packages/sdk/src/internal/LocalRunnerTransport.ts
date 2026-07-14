import { request, type IncomingMessage } from "node:http";

import {
  isRunnerEventAllowedForCommand,
  isRunnerExpectedResponseEvent,
  isRunnerStreamingCommandType,
  isRunnerTerminalResponseEvent,
  parseRunnerCommandV2,
} from "@kestrel-agents/protocol";

import type {
  RunnerCommand,
  RunnerCommandMetadata,
  RunnerErrorEventPayload,
  RunnerEvent,
  RunnerEventSubscriptionFilter,
} from "../contracts.js";
import {
  KestrelHttpError,
  KestrelProtocolError,
  toKestrelError,
} from "../errors.js";
import type { ProtocolTransport } from "./ProtocolClient.js";
import { parseRunnerEvent, RunnerSseParser } from "./runnerSse.js";

const LOCAL_CORE_RUNTIME_V2_PREFIX = "/runtime/v2";

export interface LocalRunnerTransportOptions {
  socketPath: string;
  authToken: string;
}

export interface LocalRunnerTextResponse {
  status: number;
  body: string;
}

export class LocalRunnerTransport implements ProtocolTransport {
  private readonly socketPath: string;
  private readonly authToken: string;
  private readonly controllers = new Map<string, AbortController>();
  private handlers:
    | {
        onLine: (line: string) => void;
        onExit: (code: number | null) => void;
      }
    | undefined;
  private closed = false;

  constructor(options: LocalRunnerTransportOptions) {
    this.socketPath = options.socketPath;
    this.authToken = options.authToken;
  }

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
  }): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    if (this.closed) {
      throw new Error("Local Core transport is closed.");
    }
    if (this.handlers === undefined) {
      throw new Error("Local Core transport is not started.");
    }

    let command: RunnerCommand;
    try {
      command = parseRunnerCommandV2(JSON.parse(line));
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const controller = new AbortController();
    this.controllers.set(command.id, controller);
    void this.dispatch(command, controller).finally(() => {
      this.releaseController(command.id, controller);
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

  async getHealth(signal?: AbortSignal): Promise<LocalRunnerTextResponse> {
    const response = await this.openRequest({
      method: "GET",
      path: `${LOCAL_CORE_RUNTIME_V2_PREFIX}/health`,
      accept: "application/json",
      ...(signal !== undefined ? { signal } : {}),
    });
    return {
      status: response.statusCode ?? 0,
      body: await readResponseBody(response),
    };
  }

  async subscribe(
    filter: RunnerEventSubscriptionFilter,
    metadata: RunnerCommandMetadata,
    controller: AbortController,
    onEvent: (event: RunnerEvent) => void,
  ): Promise<void> {
    const response = await this.openRequest({
      method: "POST",
      path: `${LOCAL_CORE_RUNTIME_V2_PREFIX}/events/stream`,
      accept: "text/event-stream, application/json",
      body: JSON.stringify({ filter, metadata }),
      signal: controller.signal,
    });
    const status = response.statusCode ?? 0;
    const contentType = response.headers["content-type"] ?? "";

    if (contentType.includes("text/event-stream") === false) {
      const body = await readResponseBody(response);
      const event = parseRunnerEvent(body);
      if (event?.type === "runner.error") {
        throw toKestrelError(event.payload);
      }
      if (status < 200 || status >= 300) {
        throw new KestrelHttpError(`Local Core returned HTTP ${status}.`, {
          status,
          body,
        });
      }
      throw new KestrelProtocolError("Local Core returned an unreadable subscription response.", {
        details: {
          status,
          ...(body.length > 0 ? { body } : {}),
        },
      });
    }

    await consumeIncomingSse(response, (eventType, data) => {
      const event = parseRunnerEvent(data);
      if (event === undefined) {
        throw new KestrelProtocolError(
          `Local Core emitted invalid SSE payload for '${eventType || "message"}'.`,
          {
            details: { status, body: data },
          },
        );
      }
      if (event.type === "runner.error") {
        throw toKestrelError(event.payload);
      }
      onEvent(event);
    });
  }

  private async dispatch(command: RunnerCommand, controller: AbortController): Promise<void> {
    try {
      const streaming = isRunnerStreamingCommandType(command.type);
      const response = await this.openRequest({
        method: "POST",
        path: `${LOCAL_CORE_RUNTIME_V2_PREFIX}${streaming ? "/commands/stream" : "/commands"}`,
        accept: streaming ? "text/event-stream, application/json" : "application/json",
        body: JSON.stringify(command),
        signal: controller.signal,
      });
      const status = response.statusCode ?? 0;
      const contentType = response.headers["content-type"] ?? "";
      if (contentType.includes("text/event-stream")) {
        let streamSettled = false;
        await consumeIncomingSse(response, (eventType, data) => {
          const event = parseRunnerEvent(data);
          if (event !== undefined) {
            if (
              event.commandId !== command.id
              || isRunnerEventAllowedForCommand(command.type, event) === false
            ) {
              streamSettled = true;
              this.emitEvent(makeSyntheticRunnerError(command.id, {
                code: "RUNNER_PROTOCOL_ERROR",
                message: "Local Core emitted an SSE event for an unexpected command or response type.",
                details: {
                  status,
                  eventType: event.type,
                  expectedCommandId: command.id,
                  receivedCommandId: event.commandId ?? null,
                },
              }));
              return false;
            }
            if (isRunnerTerminalResponseEvent(event.type)) {
              streamSettled = true;
              this.emitEvent(event);
              return false;
            }
            this.emitEvent(event);
            return undefined;
          }
          streamSettled = true;
          this.emitEvent(makeSyntheticRunnerError(command.id, {
            code: "RUNNER_PROTOCOL_ERROR",
            message: `Local Core emitted invalid SSE payload for '${eventType || "message"}'.`,
            details: { status, body: data },
          }));
          return false;
        });
        if (streamSettled === false) {
          this.emitEvent(makeSyntheticRunnerError(command.id, {
            code: "RUNNER_PROTOCOL_ERROR",
            message: "Local Core SSE stream ended before a terminal event.",
            details: { status },
          }));
        }
        return;
      }

      const body = await readResponseBody(response);
      this.releaseController(command.id, controller);
      const event = parseRunnerEvent(body);
      if (event !== undefined) {
        if (
          event.commandId !== command.id
          || isRunnerExpectedResponseEvent(command.type, event) === false
        ) {
          this.emitEvent(makeSyntheticRunnerError(command.id, {
            code: "RUNNER_PROTOCOL_ERROR",
            message: "Local Core returned an event for an unexpected command or response type.",
            details: {
              status,
              eventType: event.type,
              expectedCommandId: command.id,
              receivedCommandId: event.commandId ?? null,
            },
          }));
          return;
        }
        this.emitEvent(event);
        return;
      }
      if (status < 200 || status >= 300) {
        this.emitEvent(makeSyntheticRunnerError(command.id, {
          code: "RUNNER_HTTP_ERROR",
          message: `Local Core returned HTTP ${status}.`,
          details: {
            status,
            ...(body.length > 0 ? { body } : {}),
          },
        }));
        return;
      }
      this.emitEvent(makeSyntheticRunnerError(command.id, {
        code: "RUNNER_PROTOCOL_ERROR",
        message: "Local Core returned an unreadable response.",
        details: {
          status,
          ...(body.length > 0 ? { body } : {}),
        },
      }));
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return;
      }
      if (error instanceof KestrelProtocolError) {
        this.releaseController(command.id, controller);
        this.emitEvent(makeSyntheticRunnerError(command.id, {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        }));
        return;
      }
      this.releaseController(command.id, controller);
      this.emitEvent(makeSyntheticRunnerError(command.id, {
        code: "RUNNER_TRANSPORT_ERROR",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private openRequest(input: {
    method: "GET" | "POST";
    path: string;
    accept: string;
    body?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const bodyLength = input.body === undefined ? undefined : Buffer.byteLength(input.body);
      const outgoing = request(
        {
          socketPath: this.socketPath,
          path: input.path,
          method: input.method,
          headers: {
            accept: input.accept,
            authorization: `Bearer ${this.authToken}`,
            ...(input.body !== undefined
              ? {
                  "content-type": "application/json",
                  "content-length": String(bodyLength),
                }
              : {}),
          },
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
        resolve,
      );
      outgoing.once("error", reject);
      outgoing.end(input.body);
    });
  }

  private emitEvent(event: RunnerEvent): void {
    this.handlers?.onLine(JSON.stringify(event));
  }

  private releaseController(commandId: string, controller: AbortController): void {
    if (this.controllers.get(commandId) === controller) {
      this.controllers.delete(commandId);
    }
  }
}

async function readResponseBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function consumeIncomingSse(
  response: IncomingMessage,
  onMessage: (eventType: string, data: string) => void | boolean,
): Promise<void> {
  const decoder = new TextDecoder();
  const parser = new RunnerSseParser(onMessage);
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      if (parser.push(decoder.decode(bytes, { stream: true })) === false) {
        response.destroy();
        return;
      }
    }
    if (parser.push(decoder.decode()) === false || parser.finish() === false) {
      response.destroy();
    }
  } catch (error) {
    response.destroy();
    throw error;
  }
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
  return error instanceof Error && (
    error.name === "AbortError" ||
    ("code" in error && error.code === "ABORT_ERR")
  );
}
