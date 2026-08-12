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

// Execution Protocol v3 owns every command, event, envelope, and wire payload.
// Re-export those names so existing SDK imports remain source-compatible.
export type * from "@kestrel-agents/protocol";

export interface KestrelRequestContext {
  actor: RunnerActorMetadata;
  tenantId?: string | undefined;
  /**
   * @deprecated Managed runners resolve immutable execution profiles and pass
   * profileId on commands. Inline context profiles are for unmanaged/custom
   * runner compatibility only.
   */
  profile?: RunnerProfile | undefined;
  durability?: RunnerDurability | undefined;
}

type KestrelRemoteTargetBase = {
  kind: "remote";
  baseUrl: string;
  onTransportEvent?: ((event: KestrelTransportEvent) => void) | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export type KestrelRemoteTarget = KestrelRemoteTargetBase & (
  | { authToken: string; authTokenProvider?: never }
  | {
      authToken?: never;
      authTokenProvider: () => Promise<string | undefined>;
    }
  | { authToken?: undefined; authTokenProvider?: undefined }
);

export type KestrelTransportEvent =
  | { type: "reconnect.attempt"; attempt: number; delayMs: number }
  | { type: "reconnect.succeeded"; attempt: number }
  | { type: "reconnect.failed"; attempt: number; code: string }
  | { type: "cursor.expired" | "cursor.unknown"; code: string };

export interface KestrelRunAttachment {
  sessionId: string;
  runId: string;
  sinceEventId: string;
  signal?: AbortSignal | undefined;
  abortBehavior?: "cancel" | "detach" | undefined;
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
  readonly ready: Promise<void>;
  result: Promise<TTerminal>;
  cancel(): Promise<void>;
}
