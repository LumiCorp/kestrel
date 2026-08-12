import type {
  ModelReasoningUpdateV1,
  ProgressUpdateV1,
  ReasoningUpdateV1,
  RunConsoleUpdateV1,
  RunEvent,
  RunLogEntry,
} from "../kestrel/contracts/events.js";
import type { RuntimeTurnInput, RuntimeTurnResult } from "../runtime/RuntimeTurn.js";

export const RUNTIME_IDS = ["kestrel", "codex", "claude"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];
export type RuntimeEnvironmentMap = Record<string, string | undefined>;

export type RuntimeInteractionStrategy =
  | "live_connection"
  | "live_callback"
  | "deferred_session";

export interface RuntimeDescriptorV1 {
  version: "runtime_descriptor_v1";
  runtimeId: RuntimeId;
  displayName: string;
  adapterContractVersion: 1;
  nativeVersion: string;
  availability:
    | "ready"
    | "auth_required"
    | "version_mismatch"
    | "unavailable";
  interactionStrategies: RuntimeInteractionStrategy[];
  capabilities: {
    modes: Array<"chat" | "plan" | "build">;
    continuation: boolean;
    cancellation: boolean;
    usage: boolean;
    attachments: Array<"image" | "text">;
    conversationPersistence: "native_resume" | "none";
    interactionRecovery: "connection_bound" | "durable_resume";
  };
  unavailableReason?: string | undefined;
}

export interface RuntimeNativeSessionV1 {
  version: "runtime_native_session_v1";
  bindingId: string;
  runtimeId: Exclude<RuntimeId, "kestrel">;
  nativeSessionId: string;
  nativeVersion: string;
  status: "ready" | "degraded" | "released";
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeNativeSessionStore {
  load(bindingId: string): Promise<RuntimeNativeSessionV1 | undefined>;
  save(session: RuntimeNativeSessionV1): Promise<void>;
  release(bindingId: string): Promise<void>;
}

export interface RuntimeEnvironmentSnapshot {
  env: RuntimeEnvironmentMap;
  credentialFingerprint: string;
  expiresAt?: string | undefined;
}

export type RuntimeEnvironmentResolver = (
  runtimeId: Exclude<RuntimeId, "kestrel">,
) => Promise<RuntimeEnvironmentSnapshot>;

export class InMemoryRuntimeNativeSessionStore
  implements RuntimeNativeSessionStore
{
  private readonly sessions = new Map<string, RuntimeNativeSessionV1>();

  async load(bindingId: string): Promise<RuntimeNativeSessionV1 | undefined> {
    return this.sessions.get(bindingId);
  }

  async save(session: RuntimeNativeSessionV1): Promise<void> {
    this.sessions.set(session.bindingId, { ...session });
  }

  async release(bindingId: string): Promise<void> {
    this.sessions.delete(bindingId);
  }
}

export interface RuntimeBindingV1 {
  version: "runtime_binding_v1";
  bindingId: string;
  threadId: string;
  participantId: string;
  runtimeId: RuntimeId;
  environmentId: string;
  adapterContractVersion: 1;
  capabilityDigest: string;
  status: "ready" | "degraded" | "released";
  nativeSessionState: "uninitialized" | "ready" | "degraded" | "released";
}

export interface RuntimeNativeSessionEstablishedV1 {
  version: "runtime_native_session_established_v1";
  sessionId: string;
  runId: string;
  bindingId: string;
  participantId: string;
  runtimeId: Exclude<RuntimeId, "kestrel">;
}

export interface RuntimeInteractionDeliveredV1 {
  version: "runtime_interaction_delivered_v1";
  sessionId: string;
  runId: string;
  bindingId: string;
  participantId: string;
  requestId: string;
}

export interface RuntimeAdapterCallbacksV1 {
  onRunLog?: ((entry: RunLogEntry) => void) | undefined;
  onProgress?: ((update: ProgressUpdateV1) => void) | undefined;
  onConsole?: ((update: RunConsoleUpdateV1) => void) | undefined;
  onReasoning?:
    | ((update: ReasoningUpdateV1 | ModelReasoningUpdateV1) => void)
    | undefined;
  onRunEvent?: ((event: RunEvent) => void) | undefined;
  onInteractionDelivered?:
    | ((event: RuntimeInteractionDeliveredV1) => void)
    | undefined;
  onNativeSessionEstablished?:
    | ((event: RuntimeNativeSessionEstablishedV1) => void)
    | undefined;
}

export interface RuntimeAdapterV1 {
  describe(): Promise<RuntimeDescriptorV1>;
  execute(
    input:
      | { kind: "start"; binding: RuntimeBindingV1; turn: RuntimeTurnInput }
      | { kind: "continue"; binding: RuntimeBindingV1; turn: RuntimeTurnInput },
    options?: { signal?: AbortSignal | undefined },
  ): Promise<RuntimeTurnResult>;
  cancel(input: {
    binding: RuntimeBindingV1;
    sessionId: string;
  }): Promise<void>;
  release(binding: RuntimeBindingV1): Promise<void>;
  dispose(): Promise<void>;
}

export function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === "string" && RUNTIME_IDS.includes(value as RuntimeId);
}

export function runtimeIdOrDefault(value: unknown): RuntimeId {
  return isRuntimeId(value) ? value : "kestrel";
}
