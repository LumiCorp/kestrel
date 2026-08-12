import type { RuntimeReleaseCommandPayload } from "@kestrel-agents/protocol";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";

import type {
  CodexRolloutCheckpointStore,
  RuntimeBindingCorrelationStore,
  RuntimeBindingV1,
  RuntimeNativeSessionStore,
} from "./contracts.js";
import { InMemoryRuntimeBindingCorrelationStore } from "./contracts.js";

type ReleasableClaudeSessionStore = SessionStore & {
  releaseSession?(sessionId: string): Promise<void>;
};

interface ActiveBindingHandle {
  binding: RuntimeBindingV1;
  release(): Promise<void>;
}

/**
 * Environment-owned release routing. This deliberately outlives any one
 * credential/profile-scoped adapter instance.
 */
export class RuntimeBindingReleaseCoordinator {
  private readonly active = new Map<string, ActiveBindingHandle>();

  constructor(
    private readonly nativeSessions: RuntimeNativeSessionStore,
    private readonly claudeSessions?: ReleasableClaudeSessionStore,
    private readonly codexCheckpoints?: CodexRolloutCheckpointStore,
    private readonly correlations: RuntimeBindingCorrelationStore =
      new InMemoryRuntimeBindingCorrelationStore(),
  ) {}

  async record(binding: RuntimeBindingV1): Promise<void> {
    await this.correlations.register(binding);
  }

  async register(
    binding: RuntimeBindingV1,
    release: () => Promise<void>,
  ): Promise<() => void> {
    await this.record(binding);
    const key = bindingKey(binding.runtimeId, binding.bindingId);
    const existing = this.active.get(key);
    if (existing !== undefined) {
      assertBindingCorrelation(existing.binding, binding);
    }
    const handle = { binding: { ...binding }, release };
    this.active.set(key, handle);
    return () => {
      if (this.active.get(key) === handle) this.active.delete(key);
    };
  }

  async release(input: RuntimeReleaseCommandPayload): Promise<void> {
    if (input.runtimeId === "kestrel") return;
    const binding = bindingFromRelease(input);
    const key = bindingKey(input.runtimeId, input.bindingId);
    const active = this.active.get(key);
    if (active !== undefined) {
      assertReleaseCorrelation(active.binding, input);
    }

    let persisted = await this.nativeSessions.load(input.bindingId);
    let correlation = await this.correlations.load(input.bindingId);
    if (correlation === undefined && persisted !== undefined) {
      assertPersistedCorrelation(persisted, input);
      await this.correlations.register(binding);
      correlation = await this.correlations.load(input.bindingId);
    }
    if (correlation === undefined) {
      throw new Error("Runtime release binding correlation was not found.");
    }
    assertReleaseCorrelation(bindingFromCorrelation(correlation), input);

    if (active !== undefined) {
      await active.release();
      this.active.delete(key);
      persisted = await this.nativeSessions.load(input.bindingId);
    }
    if (persisted !== undefined) {
      assertPersistedCorrelation(persisted, input);
    }
    if (
      input.runtimeId === "claude" &&
      persisted !== undefined &&
      persisted.status !== "released"
    ) {
      await this.claudeSessions?.releaseSession?.(persisted.nativeSessionId);
    }
    if (input.runtimeId === "codex") {
      await this.codexCheckpoints?.release(input.bindingId);
    }
    await this.nativeSessions.release(input.bindingId);
    await this.correlations.release(binding);
  }
}

function bindingKey(runtimeId: string, bindingId: string): string {
  return `${runtimeId}\0${bindingId}`;
}

function assertBindingCorrelation(
  existing: RuntimeBindingV1,
  next: RuntimeBindingV1,
): void {
  if (
    existing.runtimeId !== next.runtimeId ||
    existing.bindingId !== next.bindingId ||
    existing.threadId !== next.threadId ||
    existing.participantId !== next.participantId ||
    existing.environmentId !== next.environmentId
  ) {
    throw new Error("Runtime binding identity cannot change between profiles.");
  }
}

function assertReleaseCorrelation(
  binding: RuntimeBindingV1,
  input: RuntimeReleaseCommandPayload,
): void {
  if (
    binding.runtimeId !== input.runtimeId ||
    binding.bindingId !== input.bindingId ||
    binding.threadId !== input.threadId ||
    binding.participantId !== input.participantId ||
    binding.environmentId !== input.environmentId
  ) {
    throw new Error("Runtime release correlation does not match the binding.");
  }
}

function assertPersistedCorrelation(
  persisted: Awaited<ReturnType<RuntimeNativeSessionStore["load"]>> & {},
  input: RuntimeReleaseCommandPayload,
): void {
  if (persisted.runtimeId !== input.runtimeId) {
    throw new Error("Runtime release does not match persisted native state.");
  }
  if (
    persisted.threadId === undefined ||
    persisted.participantId === undefined ||
    persisted.environmentId === undefined
  ) {
    throw new Error(
      "Legacy native state lacks the correlation required for inactive release.",
    );
  }
  if (
    persisted.threadId !== input.threadId ||
    persisted.participantId !== input.participantId ||
    persisted.environmentId !== input.environmentId
  ) {
    throw new Error("Runtime release does not match persisted binding correlation.");
  }
}

function bindingFromRelease(input: RuntimeReleaseCommandPayload): RuntimeBindingV1 {
  return {
    version: "runtime_binding_v1",
    bindingId: input.bindingId,
    threadId: input.threadId,
    participantId: input.participantId,
    runtimeId: input.runtimeId,
    environmentId: input.environmentId,
    adapterContractVersion: 1,
    capabilityDigest: "",
    status: "ready",
    nativeSessionState: "uninitialized",
  };
}

function bindingFromCorrelation(
  correlation: NonNullable<
    Awaited<ReturnType<RuntimeBindingCorrelationStore["load"]>>
  >,
): RuntimeBindingV1 {
  return {
    version: "runtime_binding_v1",
    bindingId: correlation.bindingId,
    threadId: correlation.threadId,
    participantId: correlation.participantId,
    runtimeId: correlation.runtimeId,
    environmentId: correlation.environmentId,
    adapterContractVersion: 1,
    capabilityDigest: "",
    status: correlation.status === "released" ? "released" : "ready",
    nativeSessionState:
      correlation.status === "released" ? "released" : "uninitialized",
  };
}
