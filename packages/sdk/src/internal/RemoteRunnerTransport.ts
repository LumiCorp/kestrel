import {
  isRunnerEventAllowedForCommand,
  isRunnerExpectedResponseEvent,
  isRunnerStreamingCommandType,
  isRunnerTerminalResponseEvent,
  parseRunnerCommandV2,
} from "@kestrel-agents/protocol";

import type {
  KestrelTransportEvent,
  RunnerCommand,
  RunnerErrorEventPayload,
  RunnerEvent,
} from "../contracts.js";
import { KestrelProtocolError } from "../errors.js";
import type { ProtocolTransport } from "./ProtocolClient.js";
import { consumeSseEventPayloads, parseRunnerEvent } from "./runnerSse.js";

export interface RemoteRunnerTransportOptions {
  baseUrl: string;
  authToken?: string | undefined;
  authTokenProvider?: (() => Promise<string | undefined>) | undefined;
  onTransportEvent?: ((event: KestrelTransportEvent) => void) | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class RemoteRunnerTransport implements ProtocolTransport {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly authTokenProvider: (() => Promise<string | undefined>) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onTransportEvent: ((event: KestrelTransportEvent) => void) | undefined;
  private readonly controllers = new Map<string, AbortController>();
  private handlers:
    | {
        onLine: (line: string) => void;
        onExit: (code: number | null) => void;
        onTransportError?: ((commandId: string, error: Error) => void) | undefined;
      }
    | undefined;
  private closed = false;

  constructor(options: RemoteRunnerTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.authToken = options.authToken;
    this.authTokenProvider = options.authTokenProvider;
    this.onTransportEvent = options.onTransportEvent;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onTransportError?: ((commandId: string, error: Error) => void) | undefined;
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
      command = parseRunnerCommandV2(JSON.parse(line));
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const controller = new AbortController();
    this.controllers.set(command.id, controller);
    void this.dispatch(command, controller).finally(() => {
      this.controllers.delete(command.id);
    });
  }

  abort(commandId: string): void {
    this.controllers.get(commandId)?.abort();
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
      const streaming = isRunnerStreamingCommandType(command.type);
      const authToken = await this.resolveAuthToken();
      const response = await this.fetchImpl(`${this.baseUrl}${streaming ? "/commands/stream" : "/commands"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: streaming ? "text/event-stream, application/json" : "application/json",
          ...(authToken !== undefined ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        await this.consumeSseResponse(response, command, controller);
        return;
      }

      const body = await response.text();
      if (response.ok === false) {
        let event: RunnerEvent | undefined;
        try {
          event = parseRunnerEvent(body);
        } catch {
          // Router and proxy errors are valid HTTP responses, not runner events.
        }
        if (event === undefined) {
          this.emitEvent(makeSyntheticRunnerError(command.id, {
            code: "RUNNER_HTTP_ERROR",
            message: `Remote runner returned an unreadable response (${response.status}).`,
            details: {
              status: response.status,
              ...(body.length > 0 ? { body } : {}),
            },
          }));
          return;
        }
      }
      const event = parseRunnerEvent(body);
      if (event !== undefined) {
        if (
          event.commandId !== command.id
          || isRunnerExpectedResponseEvent(command.type, event) === false
        ) {
          this.emitEvent(makeSyntheticRunnerError(command.id, {
            code: "RUNNER_PROTOCOL_ERROR",
            message: "Remote runner returned an event for an unexpected command or response type.",
            details: {
              status: response.status,
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
      if (error instanceof KestrelProtocolError) {
        this.emitEvent(makeSyntheticRunnerError(command.id, {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        }));
        return;
      }
      this.emitTransportError(
        command.id,
        new KestrelProtocolError(
          error instanceof Error ? error.message : String(error),
          { code: "RUNNER_TRANSPORT_ERROR" },
        ),
      );
    }
  }

  private async consumeSseResponse(
    response: Response,
    command: RunnerCommand,
    controller: AbortController,
  ): Promise<void> {
    const commandId = command.id;
    let streamSettled = false;
    const acceptedEventIds = new Set<string>();
    let runId: string | undefined;
    let sessionId: string | undefined;
    let cursor: string | undefined;
    try {
      await consumeSseEventPayloads(response, (eventType, data) => {
        const event = parseRunnerEvent(data);
        if (event !== undefined) {
          if (
            event.commandId !== commandId
            || isRunnerEventAllowedForCommand(command.type, event) === false
          ) {
            streamSettled = true;
            this.emitEvent(makeSyntheticRunnerError(commandId, {
              code: "RUNNER_PROTOCOL_ERROR",
              message: "Remote runner emitted an SSE event for an unexpected command or response type.",
              details: {
                status: response.status,
                eventType: event.type,
                expectedCommandId: commandId,
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
          acceptedEventIds.add(event.id);
          cursor = event.id;
          runId = event.runId ?? runId;
          sessionId = event.sessionId ?? sessionId;
          this.emitEvent(event);
          return ;
        }
        streamSettled = true;
        this.emitEvent(makeSyntheticRunnerError(commandId, {
          code: "RUNNER_PROTOCOL_ERROR",
          message: `Remote runner emitted invalid SSE payload for '${eventType || "message"}'.`,
          details: {
            status: response.status,
            body: data,
          },
        }));
        return false;
      });
      if (streamSettled === false) {
        if (
          command.type === "run.start" &&
          command.metadata?.durability === "continue_on_disconnect" &&
          runId !== undefined &&
          sessionId !== undefined &&
          cursor !== undefined
        ) {
          await this.reattachRun(command, controller, {
            runId,
            sessionId,
            cursor,
            acceptedEventIds,
          });
          return;
        }
        this.emitTransportError(
          commandId,
          new KestrelProtocolError(
            "Remote runner SSE stream ended before a terminal event.",
            {
              code: "RUNNER_TRANSPORT_INTERRUPTED",
              details: { status: response.status },
            },
          ),
        );
      }
    } catch (error) {
      if (streamSettled) {
        return;
      }
      if (controller.signal.aborted || isAbortError(error)) {
        return;
      }
      if (
        command.type === "run.start" &&
        command.metadata?.durability === "continue_on_disconnect" &&
        runId !== undefined &&
        sessionId !== undefined &&
        cursor !== undefined &&
        !(error instanceof KestrelProtocolError)
      ) {
        await this.reattachRun(command, controller, {
          runId,
          sessionId,
          cursor,
          acceptedEventIds,
        });
        return;
      }
      if (error instanceof KestrelProtocolError) {
        this.emitEvent(makeSyntheticRunnerError(commandId, {
          code: error.code,
          message: error.message,
          details: {
            ...(error.details ?? {}),
            status: response.status,
          },
        }));
        return;
      }
      this.emitTransportError(
        commandId,
        new KestrelProtocolError(
          error instanceof Error ? error.message : String(error),
          {
            code: "RUNNER_TRANSPORT_INTERRUPTED",
            details: { status: response.status },
          },
        ),
      );
    }
  }

  private async reattachRun(
    command: RunnerCommand,
    controller: AbortController,
    scope: {
      runId: string;
      sessionId: string;
      cursor: string;
      acceptedEventIds: Set<string>;
    },
  ): Promise<void> {
    let attempt = 0;
    while (!controller.signal.aborted) {
      const delayMs = reconnectDelay(attempt);
      this.notifyTransportEvent({
        type: "reconnect.attempt",
        attempt: attempt + 1,
        delayMs,
      });
      await waitForReconnect(delayMs, controller.signal);
      attempt += 1;
      try {
        const authToken = await this.resolveAuthToken();
        const response = await this.fetchImpl(`${this.baseUrl}/events/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream, application/json",
            ...(authToken !== undefined
              ? { Authorization: `Bearer ${authToken}` }
              : {}),
          },
          body: JSON.stringify({
            filter: {
              sessionId: scope.sessionId,
              runId: scope.runId,
              sinceEventId: scope.cursor,
            },
            metadata: command.metadata,
          }),
          signal: controller.signal,
        });
        this.notifyCursorStatus(response);
        if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
          const body = await response.text();
          let event: RunnerEvent | undefined;
          try {
            event = parseRunnerEvent(body);
          } catch {
            if (response.status >= 500) {
              this.notifyTransportEvent({
                type: "reconnect.failed",
                attempt,
                code: "RUNNER_HTTP_ERROR",
              });
              continue;
            }
          }
          if (event?.type === "runner.error") {
            if (event.payload.code === "RUNNER_EVENT_CURSOR_EXPIRED") {
              this.notifyTransportEvent({ type: "cursor.expired", code: event.payload.code });
            } else if (event.payload.code === "RUNNER_EVENT_CURSOR_UNKNOWN") {
              this.notifyTransportEvent({ type: "cursor.unknown", code: event.payload.code });
            }
            this.notifyTransportEvent({
              type: "reconnect.failed",
              attempt,
              code: event.payload.code,
            });
            this.emitEvent({ ...event, commandId: command.id });
            return;
          }
          if (response.status >= 500) {
            this.notifyTransportEvent({
              type: "reconnect.failed",
              attempt,
              code: "RUNNER_HTTP_ERROR",
            });
            continue;
          }
          this.emitEvent(makeSyntheticRunnerError(command.id, {
            code: "RUNNER_HTTP_ERROR",
            message: `Remote runner reattachment returned HTTP ${response.status}.`,
            details: { status: response.status },
          }));
          return;
        }
        let terminal = false;
        await consumeSseEventPayloads(response, (eventType, data) => {
          const event = parseRunnerEvent(data);
          if (event === undefined) {
            throw new KestrelProtocolError(
              `Remote runner emitted invalid SSE payload for '${eventType || "message"}'.`,
              { code: "RUNNER_PROTOCOL_ERROR" },
            );
          }
          if (
            event.runId !== scope.runId ||
            (event.sessionId !== undefined && event.sessionId !== scope.sessionId) ||
            scope.acceptedEventIds.has(event.id)
          ) {
            return;
          }
          if (isRunnerEventAllowedForCommand(command.type, event) === false) {
            throw new KestrelProtocolError(
              "Remote runner reattachment crossed its expected run scope.",
              { code: "RUNNER_PROTOCOL_ERROR" },
            );
          }
          scope.acceptedEventIds.add(event.id);
          scope.cursor = event.id;
          this.emitEvent({ ...event, commandId: command.id });
          if (isRunnerTerminalResponseEvent(event.type)) {
            terminal = true;
            return false;
          }
        });
        if (terminal) {
          this.notifyTransportEvent({ type: "reconnect.succeeded", attempt });
          return;
        }
        this.notifyTransportEvent({
          type: "reconnect.failed",
          attempt,
          code: "RUNNER_TRANSPORT_INTERRUPTED",
        });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (error instanceof KestrelProtocolError) {
          this.notifyTransportEvent({
            type: "reconnect.failed",
            attempt,
            code: error.code,
          });
          this.emitEvent(makeSyntheticRunnerError(command.id, {
            code: error.code,
            message: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
          }));
          return;
        }
        this.notifyTransportEvent({
          type: "reconnect.failed",
          attempt,
          code: "RUNNER_TRANSPORT_ERROR",
        });
      }
    }
  }

  private emitEvent(event: RunnerEvent): void {
    this.handlers?.onLine(JSON.stringify(event));
  }

  private emitTransportError(commandId: string, error: Error): void {
    this.handlers?.onTransportError?.(commandId, error);
  }

  private async resolveAuthToken(): Promise<string | undefined> {
    const token = this.authTokenProvider !== undefined
      ? await this.authTokenProvider()
      : this.authToken;
    const normalized = token?.trim();
    return normalized ? normalized : undefined;
  }

  private notifyTransportEvent(event: KestrelTransportEvent) {
    try {
      this.onTransportEvent?.(event);
    } catch {
      // Transport instrumentation must never affect execution.
    }
  }

  private notifyCursorStatus(response: Response) {
    const status = response.headers.get("x-kestrel-event-cursor-status");
    if (status === "expired") {
      this.notifyTransportEvent({
        type: "cursor.expired",
        code: "RUNNER_EVENT_CURSOR_EXPIRED",
      });
    } else if (status === "unknown") {
      this.notifyTransportEvent({
        type: "cursor.unknown",
        code: "RUNNER_EVENT_CURSOR_UNKNOWN",
      });
    }
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
  return error instanceof Error && error.name === "AbortError";
}

function reconnectDelay(attempt: number) {
  return [250, 500, 1_000][attempt] ?? 2_000;
}

function waitForReconnect(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abortHandler);
      resolve();
    }, delayMs);
    const abortHandler = () => {
      clearTimeout(timeout);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}
