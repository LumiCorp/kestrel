import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeAdapterChatRuntime } from "../../src/runtimes/RuntimeAdapterChatRuntime.js";
import type {
  RuntimeAdapterV1,
  RuntimeBindingV1,
  RuntimeDescriptorV1,
} from "../../src/runtimes/contracts.js";
import type { RuntimeTurnInput, RuntimeTurnResult } from "../../src/runtime/RuntimeTurn.js";

function descriptor(
  availability: RuntimeDescriptorV1["availability"] = "ready",
): RuntimeDescriptorV1 {
  return {
    version: "runtime_descriptor_v1",
    runtimeId: "codex",
    displayName: "Codex",
    adapterContractVersion: 1,
    nativeVersion: "0.147.0",
    availability,
    interactionStrategies: ["live_connection"],
    capabilities: {
      modes: ["chat", "plan", "build"],
      continuation: true,
      cancellation: true,
      usage: true,
      attachments: ["image", "text"],
      conversationPersistence: "native_resume",
      interactionRecovery: "connection_bound",
    },
    ...(availability === "ready" ? {} : { unavailableReason: "Sign in first." }),
  };
}

function turn(input: Partial<RuntimeTurnInput> = {}): RuntimeTurnInput {
  return {
    sessionId: "thread-1",
    message: "hello",
    eventType: "user.message",
    ...input,
  };
}

test("foreign Runtime bindings are stable per Thread and continuation is explicit", async () => {
  const executions: Array<Parameters<RuntimeAdapterV1["execute"]>[0]> = [];
  const cancelled: RuntimeBindingV1[] = [];
  let describeCount = 0;
  const adapter: RuntimeAdapterV1 = {
    async describe() {
      describeCount += 1;
      return descriptor();
    },
    async execute(input) {
      executions.push(input);
      return {} as RuntimeTurnResult;
    },
    async cancel(input) {
      cancelled.push(input.binding);
    },
    async release() {},
    async dispose() {},
  };
  const runtime = new RuntimeAdapterChatRuntime("codex", adapter);

  await runtime.runTurn(turn({
    runtimeBindingId: "binding:persisted",
    participantId: "runtime:org-1:codex",
  }));
  await runtime.runTurn(turn({
    runtimeBindingId: "binding:persisted",
    participantId: "runtime:org-1:codex",
    resumeBlockedRun: true,
    resumeRequestId: "approval-1",
  }));
  await runtime.cancelActiveRun("thread-1");

  assert.equal(describeCount, 1);
  assert.equal(executions[0]?.kind, "start");
  assert.equal(executions[1]?.kind, "continue");
  assert.equal(executions[0]?.binding.bindingId, executions[1]?.binding.bindingId);
  assert.equal(executions[0]?.binding.bindingId, "binding:persisted");
  assert.equal(executions[0]?.binding.participantId, "runtime:org-1:codex");
  assert.equal(cancelled[0]?.bindingId, executions[0]?.binding.bindingId);
});

test("foreign Runtime execution fails before dispatch when capability negotiation is not ready", async () => {
  let executed = false;
  const adapter: RuntimeAdapterV1 = {
    async describe() {
      return descriptor("auth_required");
    },
    async execute() {
      executed = true;
      return {} as RuntimeTurnResult;
    },
    async cancel() {},
    async release() {},
    async dispose() {},
  };
  const runtime = new RuntimeAdapterChatRuntime("codex", adapter);

  await assert.rejects(() => runtime.runTurn(turn()), /Sign in first/u);
  assert.equal(executed, false);
});

test("foreign Runtime readiness is re-probed after authentication becomes available", async () => {
  let describeCount = 0;
  const adapter: RuntimeAdapterV1 = {
    async describe() {
      describeCount += 1;
      return descriptor(describeCount === 1 ? "auth_required" : "ready");
    },
    async execute() {
      return {} as RuntimeTurnResult;
    },
    async cancel() {},
    async release() {},
    async dispose() {},
  };
  const runtime = new RuntimeAdapterChatRuntime("codex", adapter);

  await assert.rejects(() => runtime.runTurn(turn()), /Sign in first/u);
  await runtime.runTurn(turn());

  assert.equal(describeCount, 2);
});

test("foreign Runtime execution fails closed for degraded and released bindings", async () => {
  let executed = false;
  const adapter: RuntimeAdapterV1 = {
    async describe() {
      return descriptor();
    },
    async execute() {
      executed = true;
      return {} as RuntimeTurnResult;
    },
    async cancel() {},
    async release() {},
    async dispose() {},
  };

  for (const status of ["degraded", "released"] as const) {
    const runtime = new RuntimeAdapterChatRuntime("codex", adapter);
    await assert.rejects(
      () => runtime.runTurn(turn({ runtimeBindingStatus: status })),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "RUNTIME_BINDING_DEGRADED",
    );
  }
  assert.equal(executed, false);
});

test("foreign Runtime lifecycle rejects a stale ready state after degradation", async () => {
  const adapter: RuntimeAdapterV1 = {
    async describe() { return descriptor(); },
    async execute() { return {} as RuntimeTurnResult; },
    async cancel() {},
    async release() {},
    async dispose() {},
  };
  const runtime = new RuntimeAdapterChatRuntime("codex", adapter);
  await runtime.runTurn(turn({
    runtimeBindingId: "binding:stable",
    runtimeBindingStatus: "ready",
    runtimeNativeSessionState: "ready",
  }));
  await assert.rejects(
    () => runtime.runTurn(turn({
      runtimeBindingId: "binding:stable",
      runtimeBindingStatus: "degraded",
      runtimeNativeSessionState: "degraded",
    })),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "RUNTIME_BINDING_DEGRADED",
  );
  await assert.rejects(
    () => runtime.runTurn(turn({
      runtimeBindingId: "binding:stable",
      runtimeBindingStatus: "ready",
      runtimeNativeSessionState: "ready",
    })),
    /Stale Runtime binding state/u,
  );
});

test("a degraded binding still dispatches its obsolete live-wait continuation", async () => {
  let calls = 0;
  const adapter: RuntimeAdapterV1 = {
    async describe() { return descriptor(); },
    async execute(input) {
      calls += 1;
      if (calls === 1) {
        input.binding.status = "degraded";
        input.binding.nativeSessionState = "degraded";
      }
      return {} as RuntimeTurnResult;
    },
    async cancel() {},
    async release() {},
    async dispose() {},
  };
  const runtime = new RuntimeAdapterChatRuntime("codex", adapter);
  await runtime.runTurn(turn({ runtimeBindingId: "binding:wait" }));
  await runtime.runTurn(turn({
    runtimeBindingId: "binding:wait",
    runtimeBindingStatus: "degraded",
    runtimeNativeSessionState: "degraded",
    resumeBlockedRun: true,
    resumeRequestId: "lost-request",
  }));
  assert.equal(calls, 2);
});
