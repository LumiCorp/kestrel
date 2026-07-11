import { randomUUID } from "node:crypto";

import type { TuiProfile } from "../contracts.js";
import {
  ProtocolClient,
  type ProtocolTransport,
} from "../client/ProtocolClient.js";
import { RemoteRunnerTransport } from "../client/RemoteRunnerTransport.js";
import type {
  RunnerActorMetadata,
  RunnerCommandMetadata,
  RunnerCommandPayloadByType,
  RunnerCommandType,
  RunnerEvent,
  SessionDescribedEventPayload,
} from "../protocol/contracts.js";
import type { RunTurnInput } from "../runtime/KestrelChatRuntime.js";

export interface NativeRunnerClientOptions {
  transport?: ProtocolTransport | undefined;
  baseUrl?: string | undefined;
  authToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface NativeRunnerRequestContext {
  actor: RunnerActorMetadata;
  tenantId?: string | undefined;
  profile?: TuiProfile | undefined;
}

export class NativeRunnerClient {
  private readonly client: ProtocolClient;

  constructor(options: NativeRunnerClientOptions = {}) {
    const transport =
      options.transport ??
      new RemoteRunnerTransport({
        baseUrl: options.baseUrl ?? resolveBaseUrlFromEnv(),
        authToken: options.authToken,
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      });
    this.client = new ProtocolClient(transport);
  }

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    return this.client.onEvent(listener);
  }

  async run(
    input: {
      profile: TuiProfile;
      turn: RunTurnInput;
    },
    context: NativeRunnerRequestContext,
  ): Promise<Extract<RunnerEvent, { type: "run.completed" | "run.failed" }>> {
    const response = await this.client.sendCommand("run.start", input, toCommandMetadata(context));
    if (response.type !== "run.completed" && response.type !== "run.failed") {
      throw new Error(`Unexpected run response '${response.type}'.`);
    }
    return response;
  }

  async streamRun(
    input: {
      profile: TuiProfile;
      turn: RunTurnInput;
      onEvent: (event: Extract<RunnerEvent, { type: `run.${string}` }>) => void;
      signal?: AbortSignal | undefined;
    },
    context: NativeRunnerRequestContext,
  ): Promise<Extract<RunnerEvent, { type: "run.completed" | "run.failed" }>> {
    const commandId = randomUUID();
    const unsubscribe = this.client.onEvent((event) => {
      if (event.commandId !== commandId || event.type.startsWith("run.") === false) {
        return;
      }
      input.onEvent(event as Extract<RunnerEvent, { type: `run.${string}` }>);
    });
    const abortHandler = () => {
      void this.client.sendCommand("run.cancel", { sessionId: input.turn.sessionId }, toCommandMetadata(context)).catch(() => {
        // Best-effort cancellation.
      });
    };

    input.signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      const response = await this.client.sendCommandWithId(
        commandId,
        "run.start",
        {
          profile: input.profile,
          turn: input.turn,
        },
        toCommandMetadata(context),
      );
      if (response.type !== "run.completed" && response.type !== "run.failed") {
        throw new Error(`Unexpected run response '${response.type}'.`);
      }
      return response;
    } finally {
      unsubscribe();
      input.signal?.removeEventListener("abort", abortHandler);
    }
  }

  async describeSession(
    sessionId: string,
    context: NativeRunnerRequestContext,
  ): Promise<SessionDescribedEventPayload> {
    const response = await this.client.sendCommand(
      "session.describe",
      { sessionId },
      toCommandMetadata(context),
    );
    if (response.type !== "session.described") {
      throw new Error(`Unexpected session response '${response.type}'.`);
    }
    return response.payload;
  }

  async sendCommand<TType extends RunnerCommandType>(
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    context: NativeRunnerRequestContext,
  ): Promise<RunnerEvent> {
    return this.client.sendCommand(type, payload, toCommandMetadata(context));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function toCommandMetadata(context: NativeRunnerRequestContext): RunnerCommandMetadata {
  return {
    actor: context.actor,
    ...(context.tenantId !== undefined ? { tenantId: context.tenantId } : {}),
    ...(context.profile !== undefined ? { profile: context.profile } : {}),
  };
}

function resolveBaseUrlFromEnv(): string {
  const baseUrl = process.env.KESTREL_RUNNER_SERVICE_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("NativeRunnerClient requires baseUrl or KESTREL_RUNNER_SERVICE_URL.");
  }
  return baseUrl;
}
