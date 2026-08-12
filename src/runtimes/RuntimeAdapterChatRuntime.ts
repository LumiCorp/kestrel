import { createHash } from "node:crypto";

import type { RuntimeTurnInput, RuntimeTurnResult } from "../runtime/RuntimeTurn.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  RuntimeAdapterV1,
  RuntimeBindingV1,
  RuntimeDescriptorV1,
  RuntimeId,
} from "./contracts.js";
import type { RuntimeReleaseCommandPayload } from "@kestrel-agents/protocol";
import type { RuntimeBindingReleaseCoordinator } from "./RuntimeBindingReleaseCoordinator.js";

export class RuntimeAdapterChatRuntime {
  private readonly bindings = new Map<string, RuntimeBindingV1>();
  private readonly unregisterBindings = new Map<string, () => void>();

  constructor(
    private readonly runtimeId: Exclude<RuntimeId, "kestrel">,
    private readonly adapter: RuntimeAdapterV1,
    private readonly releaseCoordinator?: RuntimeBindingReleaseCoordinator,
  ) {}

  async describeRuntime(): Promise<RuntimeDescriptorV1> {
    return await this.adapter.describe();
  }

  async runTurn(
    turn: RuntimeTurnInput,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<RuntimeTurnResult> {
    const binding = await this.bindingFor(turn);
    const continuation = turn.resumeBlockedRun === true;
    if (
      binding.status === "released" ||
      binding.nativeSessionState === "released" ||
      (!continuation &&
        (binding.status === "degraded" ||
          binding.nativeSessionState === "degraded"))
    ) {
      throw createRuntimeFailure(
        "RUNTIME_BINDING_DEGRADED",
        "This Runtime binding is read-only and must be recovered into a new Thread.",
      );
    }
    return await this.adapter.execute(
      {
        kind: continuation ? "continue" : "start",
        binding,
        turn,
      },
      options,
    );
  }

  async cancelActiveRun(sessionId: string): Promise<{ runId?: string }> {
    const binding = this.bindings.get(sessionId);
    if (binding !== undefined) {
      await this.adapter.cancel({ binding, sessionId });
    }
    return {};
  }

  async releaseRuntimeBinding(input: RuntimeReleaseCommandPayload): Promise<void> {
    if (input.runtimeId !== this.runtimeId) {
      throw new Error("Runtime release was routed to the wrong adapter.");
    }
    const binding = this.bindings.get(input.threadId) ?? {
      version: "runtime_binding_v1" as const,
      bindingId: input.bindingId,
      threadId: input.threadId,
      participantId: input.participantId,
      runtimeId: this.runtimeId,
      environmentId: input.environmentId,
      adapterContractVersion: 1 as const,
      capabilityDigest: "",
      status: "ready" as const,
      nativeSessionState: "ready" as const,
    };
    if (
      binding.bindingId !== input.bindingId ||
      binding.participantId !== input.participantId ||
      binding.environmentId !== input.environmentId
    ) {
      throw new Error("Runtime release correlation does not match the binding.");
    }
    await this.adapter.release(binding);
    applyBindingTransition(binding, "released", "released");
    this.unregisterBindings.get(input.threadId)?.();
    this.unregisterBindings.delete(input.threadId);
    this.bindings.delete(input.threadId);
  }

  async close(): Promise<void> {
    for (const unregister of this.unregisterBindings.values()) unregister();
    this.unregisterBindings.clear();
    this.bindings.clear();
    await this.adapter.dispose();
  }

  private async bindingFor(turn: RuntimeTurnInput): Promise<RuntimeBindingV1> {
    const existing = this.bindings.get(turn.sessionId);
    if (existing !== undefined) {
      if (
        (turn.runtimeBindingId !== undefined &&
          turn.runtimeBindingId !== existing.bindingId) ||
        (turn.participantId !== undefined &&
          turn.participantId !== existing.participantId)
      ) {
        throw new Error(
          "The Runtime binding for this Thread cannot change after execution starts.",
        );
      }
      applyBindingTransition(
        existing,
        turn.runtimeBindingStatus ?? existing.status,
        turn.runtimeNativeSessionState ?? existing.nativeSessionState,
      );
      return existing;
    }

    const environmentId =
      turn.runtimeEnvironmentId ??
      turn.mcpContext?.environmentId ??
      readString(turn.workspace, "workspaceId") ??
      "local";
    const participantId = turn.participantId ?? `runtime:${this.runtimeId}`;
    const binding: RuntimeBindingV1 = {
      version: "runtime_binding_v1",
      bindingId:
        turn.runtimeBindingId ??
        stableId("binding", this.runtimeId, turn.sessionId, environmentId),
      threadId: turn.sessionId,
      participantId,
      runtimeId: this.runtimeId,
      environmentId,
      adapterContractVersion: 1,
      capabilityDigest: "",
      status: "ready",
      nativeSessionState: "uninitialized",
      ...(turn.runtimeNativeSessionState
        ? { nativeSessionState: turn.runtimeNativeSessionState }
        : {}),
      ...(turn.runtimeBindingStatus ? { status: turn.runtimeBindingStatus } : {}),
    };
    await this.releaseCoordinator?.record(binding);
    const descriptor = await this.adapter.describe();
    if (descriptor.availability !== "ready") {
      throw new Error(
        descriptor.unavailableReason ??
          `${descriptor.displayName} Runtime is ${descriptor.availability}.`,
      );
    }
    binding.capabilityDigest = createHash("sha256")
      .update(JSON.stringify(descriptor.capabilities))
      .digest("hex");
    let unregister: (() => void) | undefined;
    if (this.releaseCoordinator !== undefined) {
      unregister = await this.releaseCoordinator.register(binding, async () => {
          await this.releaseRuntimeBinding({
            runtimeId: this.runtimeId,
            bindingId: binding.bindingId,
            participantId: binding.participantId,
            threadId: binding.threadId,
            environmentId: binding.environmentId,
          });
        });
    }
    this.bindings.set(turn.sessionId, binding);
    if (unregister !== undefined) {
      this.unregisterBindings.set(turn.sessionId, unregister);
    }
    return binding;
  }
}

function applyBindingTransition(
  binding: RuntimeBindingV1,
  nextStatus: RuntimeBindingV1["status"],
  nextNativeState: RuntimeBindingV1["nativeSessionState"],
): void {
  const bindingRank = { ready: 0, degraded: 1, released: 2 } as const;
  const nativeRank = {
    uninitialized: 0,
    ready: 1,
    degraded: 2,
    released: 3,
  } as const;
  if (
    bindingRank[nextStatus] < bindingRank[binding.status] ||
    nativeRank[nextNativeState] < nativeRank[binding.nativeSessionState]
  ) {
    throw createRuntimeFailure(
      "RUNTIME_BINDING_DEGRADED",
      "Stale Runtime binding state cannot replace a newer lifecycle state.",
    );
  }
  binding.status = nextStatus;
  binding.nativeSessionState = nextNativeState;
  if (nextNativeState === "degraded" || nextNativeState === "released") {
    binding.status = nextNativeState;
  }
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}
