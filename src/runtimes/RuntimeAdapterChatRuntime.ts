import { createHash } from "node:crypto";

import type { RuntimeTurnInput, RuntimeTurnResult } from "../runtime/RuntimeTurn.js";
import type {
  RuntimeAdapterV1,
  RuntimeBindingV1,
  RuntimeDescriptorV1,
  RuntimeId,
} from "./contracts.js";

export class RuntimeAdapterChatRuntime {
  private readonly bindings = new Map<string, RuntimeBindingV1>();

  constructor(
    private readonly runtimeId: Exclude<RuntimeId, "kestrel">,
    private readonly adapter: RuntimeAdapterV1,
  ) {}

  async describeRuntime(): Promise<RuntimeDescriptorV1> {
    return await this.adapter.describe();
  }

  async runTurn(
    turn: RuntimeTurnInput,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<RuntimeTurnResult> {
    const binding = await this.bindingFor(turn);
    return await this.adapter.execute(
      {
        kind: turn.resumeBlockedRun === true ? "continue" : "start",
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

  async close(): Promise<void> {
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
      return existing;
    }

    const descriptor = await this.adapter.describe();
    if (descriptor.availability !== "ready") {
      throw new Error(
        descriptor.unavailableReason ??
          `${descriptor.displayName} Runtime is ${descriptor.availability}.`,
      );
    }
    const environmentId =
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
      capabilityDigest: createHash("sha256")
        .update(JSON.stringify(descriptor))
        .digest("hex"),
      status: "ready",
      nativeSessionState: "uninitialized",
      ...(turn.runtimeNativeSessionState
        ? { nativeSessionState: turn.runtimeNativeSessionState }
        : {}),
    };
    this.bindings.set(turn.sessionId, binding);
    return binding;
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
