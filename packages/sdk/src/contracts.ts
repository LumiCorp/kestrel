import type {
  RunnerActorMetadata,
  RunnerDurability,
  RunnerEvent,
  RunnerEventEnvelope,
  RunnerProfile,
  RunnerJobStreamEventType,
  RunnerResultV2,
  RunnerRunOutput,
  RunnerTurnInput,
  SessionDescribedEventPayload,
  SessionStateEventPayload,
} from "@kestrel-agents/protocol";

// Execution Protocol v2 owns every command, event, envelope, and wire payload.
// Re-export those names so existing SDK imports remain source-compatible.
export type * from "@kestrel-agents/protocol";

export interface KestrelRequestContext {
  actor: RunnerActorMetadata;
  tenantId?: string | undefined;
  profile?: RunnerProfile | undefined;
  durability?: RunnerDurability | undefined;
}

export interface KestrelRemoteTarget {
  kind: "remote";
  baseUrl: string;
  authToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface KestrelLocalTarget {
  kind: "local";
  socketPath: string;
  authToken: string;
}

export type KestrelClientTarget = KestrelRemoteTarget | KestrelLocalTarget;

export interface KestrelClientOptions {
  /** Explicit local or remote execution authority. */
  target: KestrelClientTarget;
}

export interface KestrelRunRequest {
  profileId: string;
  turn: RunnerTurnInput;
}

export type RunnerRunResult = RunnerResultV2<RunnerRunOutput>;
export type RunnerSessionDescription = SessionDescribedEventPayload;
export type RunnerSessionState = SessionStateEventPayload;
export type RunnerDelegationTask = Record<string, unknown>;
export type RunnerStreamEvent = RunnerEvent;
export type RunnerJobTerminalEvent =
  | RunnerEventEnvelope<"job.completed">
  | RunnerEventEnvelope<"job.failed">;
export type RunnerJobStreamEvent = Extract<
  RunnerEvent,
  { type: RunnerJobStreamEventType }
>;

export interface RunnerStream<TEvent, TTerminal> extends AsyncIterable<TEvent> {
  result: Promise<TTerminal>;
  cancel(): Promise<void>;
}
