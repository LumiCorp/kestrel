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

interface RuntimeNativeSessionBaseV1 {
  version: "runtime_native_session_v1";
  bindingId: string;
  runtimeId: Exclude<RuntimeId, "kestrel">;
  /** Optional only while reading pre-Hydra-correlation legacy records. */
  threadId?: string | undefined;
  /** Optional only while reading pre-Hydra-correlation legacy records. */
  participantId?: string | undefined;
  /** Optional only while reading pre-Hydra-correlation legacy records. */
  environmentId?: string | undefined;
  nativeVersion: string;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeNativeSessionV1 = RuntimeNativeSessionBaseV1 &
  (
    | {
        status: "ready" | "degraded";
        nativeSessionId: string;
      }
    | {
        status: "released";
        nativeSessionId?: never;
      }
  );

export interface RuntimeNativeSessionStore {
  load(bindingId: string): Promise<RuntimeNativeSessionV1 | undefined>;
  save(session: RuntimeNativeSessionV1): Promise<void>;
  release(bindingId: string): Promise<void>;
}

export interface RuntimeBindingCorrelationV1 {
  version: "runtime_binding_correlation_v1";
  bindingId: string;
  runtimeId: Exclude<RuntimeId, "kestrel">;
  threadId: string;
  participantId: string;
  environmentId: string;
  status: "active" | "released";
  createdAt: string;
  updatedAt: string;
}

/** Private environment-owned identity proof used only for exact release routing. */
export interface RuntimeBindingCorrelationStore {
  load(bindingId: string): Promise<RuntimeBindingCorrelationV1 | undefined>;
  register(binding: RuntimeBindingV1): Promise<void>;
  release(binding: RuntimeBindingV1): Promise<void>;
}

export interface CodexRolloutCheckpointStore {
  capture(input: {
    bindingId: string;
    codexHome: string;
    rolloutPath: string;
  }): Promise<void>;
  materialize(input: {
    bindingId: string;
    codexHome: string;
  }): Promise<"materialized" | "same_root" | "missing">;
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
    const existing = this.sessions.get(session.bindingId);
    assertNativeSessionTransition(existing, session);
    this.sessions.set(session.bindingId, { ...session });
  }

  async release(bindingId: string): Promise<void> {
    const existing = this.sessions.get(bindingId);
    if (existing === undefined || existing.status === "released") return;
    this.sessions.set(bindingId, releasedNativeSession(existing));
  }
}

export class InMemoryRuntimeBindingCorrelationStore
  implements RuntimeBindingCorrelationStore
{
  private readonly bindings = new Map<string, RuntimeBindingCorrelationV1>();

  async load(bindingId: string): Promise<RuntimeBindingCorrelationV1 | undefined> {
    const binding = this.bindings.get(bindingId);
    return binding === undefined ? undefined : { ...binding };
  }

  async register(binding: RuntimeBindingV1): Promise<void> {
    if (binding.runtimeId === "kestrel") return;
    const existing = this.bindings.get(binding.bindingId);
    if (existing !== undefined) {
      assertBindingCorrelationTransition(existing, binding, "active");
      return;
    }
    const now = new Date().toISOString();
    this.bindings.set(binding.bindingId, {
      version: "runtime_binding_correlation_v1",
      bindingId: binding.bindingId,
      runtimeId: binding.runtimeId,
      threadId: binding.threadId,
      participantId: binding.participantId,
      environmentId: binding.environmentId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  async release(binding: RuntimeBindingV1): Promise<void> {
    if (binding.runtimeId === "kestrel") return;
    const existing = this.bindings.get(binding.bindingId);
    if (existing === undefined) {
      throw new Error("Runtime binding correlation was not registered.");
    }
    assertBindingCorrelationTransition(existing, binding, "released");
    if (existing.status === "released") return;
    this.bindings.set(binding.bindingId, {
      ...existing,
      status: "released",
      updatedAt: new Date().toISOString(),
    });
  }
}

export function assertBindingCorrelationTransition(
  existing: RuntimeBindingCorrelationV1,
  binding: RuntimeBindingV1,
  nextStatus: RuntimeBindingCorrelationV1["status"],
): void {
  if (
    existing.bindingId !== binding.bindingId ||
    existing.runtimeId !== binding.runtimeId ||
    existing.threadId !== binding.threadId ||
    existing.participantId !== binding.participantId ||
    existing.environmentId !== binding.environmentId
  ) {
    throw new Error("Runtime binding correlation cannot change.");
  }
  if (existing.status === "released" && nextStatus === "active") {
    throw new Error("A released Runtime binding cannot become active.");
  }
}

export function assertNativeSessionTransition(
  existing: RuntimeNativeSessionV1 | undefined,
  next: RuntimeNativeSessionV1,
): void {
  if (existing === undefined) {
    if (next.status === "released") {
      throw new Error("A native Runtime session cannot begin in released state.");
    }
    return;
  }
  if (
    existing.bindingId !== next.bindingId ||
    existing.runtimeId !== next.runtimeId ||
    existing.nativeVersion !== next.nativeVersion ||
    existing.createdAt !== next.createdAt
  ) {
    throw new Error("Native Runtime session identity cannot change.");
  }
  for (const field of ["threadId", "participantId", "environmentId"] as const) {
    if (
      existing[field] !== undefined &&
      existing[field] !== next[field]
    ) {
      throw new Error("Native Runtime binding correlation cannot change.");
    }
  }
  if (
    existing.status !== "released" &&
    next.status !== "released" &&
    existing.nativeSessionId !== next.nativeSessionId
  ) {
    throw new Error("Native Runtime session correlation cannot change.");
  }
  const rank = { ready: 0, degraded: 1, released: 2 } as const;
  if (rank[next.status] < rank[existing.status]) {
    throw new Error(
      `Native Runtime session state cannot move from ${existing.status} to ${next.status}.`,
    );
  }
}

export function releasedNativeSession(
  existing: Exclude<RuntimeNativeSessionV1, { status: "released" }>,
): RuntimeNativeSessionV1 {
  return {
    version: existing.version,
    bindingId: existing.bindingId,
    runtimeId: existing.runtimeId,
    ...(existing.threadId !== undefined ? { threadId: existing.threadId } : {}),
    ...(existing.participantId !== undefined
      ? { participantId: existing.participantId }
      : {}),
    ...(existing.environmentId !== undefined
      ? { environmentId: existing.environmentId }
      : {}),
    nativeVersion: existing.nativeVersion,
    status: "released",
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
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
