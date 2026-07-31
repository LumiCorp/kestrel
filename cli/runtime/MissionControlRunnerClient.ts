import { randomUUID } from "node:crypto";

import type {
  RunnerCommandMetadata,
  RunnerCommandPayloadByType,
  RunnerCommandType,
  RunnerEvent,
} from "@kestrel-agents/protocol";

import type { MissionControlRunnerCommandClient } from "../../src/missionControl/executionRuntime.js";
import type { RunTurnResult } from "./KestrelChatRuntime.js";

interface AcceptedOperatorControl {
  accepted: {
    sessionId?: string | undefined;
    threadId: string;
    disposition: "accepted" | "completed";
    runId?: string | undefined;
    inbox?: unknown;
    view?: unknown;
    result?: RunTurnResult | undefined;
  };
  completion: Promise<RunTurnResult>;
}

export interface InProcessMissionControlRunnerClientOptions {
  runStart(
    payload: RunnerCommandPayloadByType["run.start"],
  ): Promise<RunTurnResult>;
  operatorControl(
    payload: RunnerCommandPayloadByType["operator.control"],
  ): Promise<AcceptedOperatorControl>;
  cancel(
    payload: RunnerCommandPayloadByType["run.cancel"],
  ): Promise<{ sessionId: string; runId: string; threadId?: string | undefined }>;
  inspectRun(
    payload: RunnerCommandPayloadByType["operator.run"],
  ): Promise<{
    sessionId: string;
    threadId: string;
    runId: string;
    view: unknown;
  }>;
  now?: (() => string) | undefined;
}

export class InProcessMissionControlRunnerClient
  implements MissionControlRunnerCommandClient
{
  private readonly listeners = new Set<(event: RunnerEvent) => void>();

  constructor(
    private readonly options: InProcessMissionControlRunnerClientOptions,
  ) {}

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendCommandWithId<TType extends RunnerCommandType>(
    commandId: string,
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    _metadata?: RunnerCommandMetadata,
  ): Promise<RunnerEvent> {
    if (type === "run.start") {
      return this.runStart(
        commandId,
        payload as RunnerCommandPayloadByType["run.start"],
      );
    }
    if (type === "operator.control") {
      return this.operatorControl(
        commandId,
        payload as RunnerCommandPayloadByType["operator.control"],
      );
    }
    if (type === "run.cancel") {
      return this.cancel(
        commandId,
        payload as RunnerCommandPayloadByType["run.cancel"],
      );
    }
    if (type === "operator.run") {
      return this.inspectRun(
        commandId,
        payload as RunnerCommandPayloadByType["operator.run"],
      );
    }
    throw new Error(`Unsupported in-process Mission Control command: ${type}.`);
  }

  private async runStart(
    commandId: string,
    payload: RunnerCommandPayloadByType["run.start"],
  ): Promise<RunnerEvent> {
    const sessionId = payload.turn.sessionId;
    const runId = payload.turn.runId ?? commandId;
    const completion = this.options.runStart(payload);
    this.emit({
      id: randomUUID(),
      type: "run.started",
      ts: this.now(),
      commandId,
      sessionId,
      threadId: sessionId,
      runId,
      payload: {
        sessionId,
        runId,
        eventType: payload.turn.eventType,
      },
    } as RunnerEvent);
    try {
      const result = await completion;
      const terminal =
        result.output.status === "FAILED"
          ? ({
              id: randomUUID(),
              type: "run.failed",
              ts: this.now(),
              commandId,
              sessionId,
              threadId: sessionId,
              runId: result.output.runId,
              payload: {
                result,
                error: {
                  code: result.output.errors[0]?.code ?? "RUN_FAILED",
                  message: result.output.errors[0]?.message ?? "Run failed.",
                },
              },
            } as unknown as RunnerEvent)
          : ({
              id: randomUUID(),
              type: "run.completed",
              ts: this.now(),
              commandId,
              sessionId,
              threadId: sessionId,
              runId: result.output.runId,
              payload: { result },
            } as unknown as RunnerEvent);
      this.emit(terminal);
      return terminal;
    } catch (error) {
      const terminal = failureEvent({
        commandId,
        sessionId,
        threadId: sessionId,
        runId,
        error,
        ts: this.now(),
      });
      this.emit(terminal);
      return terminal;
    }
  }

  private async operatorControl(
    commandId: string,
    payload: RunnerCommandPayloadByType["operator.control"],
  ): Promise<RunnerEvent> {
    const execution = await this.options.operatorControl(payload);
    const accepted = execution.accepted;
    const response = {
      id: randomUUID(),
      type: "operator.controlled",
      ts: this.now(),
      commandId,
      ...(accepted.sessionId === undefined
        ? {}
        : { sessionId: accepted.sessionId }),
      threadId: accepted.threadId,
      ...(accepted.runId === undefined ? {} : { runId: accepted.runId }),
      payload: accepted,
    } as RunnerEvent;
    void execution.completion
      .then((result) => {
        const terminal =
          result.output.status === "FAILED"
            ? ({
                id: randomUUID(),
                type: "run.failed",
                ts: this.now(),
                commandId,
                sessionId: result.output.sessionId,
                threadId: accepted.threadId,
                runId: result.output.runId,
                payload: {
                  result,
                  error: {
                    code: result.output.errors[0]?.code ?? "RUN_FAILED",
                    message:
                      result.output.errors[0]?.message ?? "Run failed.",
                  },
                },
              } as unknown as RunnerEvent)
            : ({
                id: randomUUID(),
                type: "run.completed",
                ts: this.now(),
                commandId,
                sessionId: result.output.sessionId,
                threadId: accepted.threadId,
                runId: result.output.runId,
                payload: { result },
              } as unknown as RunnerEvent);
        this.emit(terminal);
      })
      .catch((error) => {
        this.emit(
          failureEvent({
            commandId,
            sessionId: accepted.sessionId ?? payload.threadId,
            threadId: accepted.threadId,
            runId: accepted.runId ?? commandId,
            error,
            ts: this.now(),
          }),
        );
      });
    return response;
  }

  private async cancel(
    commandId: string,
    payload: RunnerCommandPayloadByType["run.cancel"],
  ): Promise<RunnerEvent> {
    const cancelled = await this.options.cancel(payload);
    return {
      id: randomUUID(),
      type: "run.cancelled",
      ts: this.now(),
      commandId,
      sessionId: cancelled.sessionId,
      ...(cancelled.threadId === undefined
        ? {}
        : { threadId: cancelled.threadId }),
      runId: cancelled.runId,
      payload: {
        sessionId: cancelled.sessionId,
        runId: cancelled.runId,
        result: terminalResult(
          cancelled.sessionId,
          cancelled.runId,
          "CANCELLED",
        ),
      },
    } as RunnerEvent;
  }

  private async inspectRun(
    commandId: string,
    payload: RunnerCommandPayloadByType["operator.run"],
  ): Promise<RunnerEvent> {
    const inspected = await this.options.inspectRun(payload);
    return {
      id: randomUUID(),
      type: "operator.run",
      ts: this.now(),
      commandId,
      sessionId: inspected.sessionId,
      threadId: inspected.threadId,
      runId: inspected.runId,
      payload: { view: inspected.view },
    } as RunnerEvent;
  }

  private emit(event: RunnerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function failureEvent(input: {
  commandId: string;
  sessionId: string;
  threadId: string;
  runId: string;
  error: unknown;
  ts: string;
}): RunnerEvent {
  const failure = normalizeError(input.error);
  return {
    id: randomUUID(),
    type: "run.failed",
    ts: input.ts,
    commandId: input.commandId,
    sessionId: input.sessionId,
    threadId: input.threadId,
    runId: input.runId,
    payload: {
      result: terminalResult(input.sessionId, input.runId, "FAILED", failure),
      error: failure,
    },
  } as RunnerEvent;
}

function terminalResult(
  sessionId: string,
  runId: string,
  status: "FAILED" | "CANCELLED",
  error?: { code: string; message: string },
) {
  return {
    assistantText: null,
    output: {
      status,
      sessionId,
      runId,
      errors: error === undefined ? [] : [error],
      quality: {
        citationCoverage: 1,
        unresolvedClaims: 0,
        reworkRate: 0,
        thrashIndex: 0,
      },
      telemetry: {
        stepsExecuted: 0,
        toolCalls: 0,
        modelCalls: 0,
        durationMs: 0,
      },
    },
  };
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; message?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : "RUN_FAILED",
      message:
        typeof value.message === "string"
          ? value.message
          : "Mission Control run failed.",
    };
  }
  return { code: "RUN_FAILED", message: String(error) };
}
