import test from "node:test";
import assert from "node:assert/strict";

import { InlineEffectRunner } from "../../src/effects/EffectRunner.js";
import { EffectRegistry } from "../../src/effects/EffectRegistry.js";
import { createExecuteToolCallHandler } from "../../src/effects/handlers/executeToolCall.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { UnifiedToolRegistry } from "../../tools/runtime/UnifiedToolRegistry.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";

test("Effect runner reports compiled tool activity", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  registry.register("execute_tool_call", async () => buildAgentToolSuccessResult({
    toolName: "fs.write_text",
    input: { path: "result.txt", text: "done" },
    output: { changedFiles: ["result.txt"] },
  }));
  const activities: Array<Record<string, unknown>> = [];
  const runner = new InlineEffectRunner(store, registry);

  const outcome = await runner.runEffects(
    [{
      runId: "run-tool-activity",
      sessionId: "session-tool-activity",
      stepIndex: 2,
      type: "execute_tool_call",
      payload: {
        toolName: "fs.write_text",
        toolInput: { path: "result.txt", text: "done" },
      },
      idempotencyKey: "tool-activity-1",
      failurePolicy: "STOP",
      status: "PENDING",
      createdAt: new Date().toISOString(),
    }],
    {
      runId: "run-tool-activity",
      sessionId: "session-tool-activity",
      stepIndex: 2,
      onToolActivity: async (activity) => {
        activities.push(activity);
      },
    },
  );

  assert.equal(outcome.stop, false);
  assert.deepEqual(activities.map((activity) => ({
    phase: activity.phase,
    toolCallId: activity.toolCallId,
    toolName: activity.toolName,
  })), [
    { phase: "started", toolCallId: "tool-activity-1", toolName: "fs.write_text" },
    { phase: "completed", toolCallId: "tool-activity-1", toolName: "fs.write_text" },
  ]);
  assert.equal((activities[1]?.output as { status?: string }).status, "OK");
});

test("Effect runner STOP policy halts on failure", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  registry.register("explode", async () => {
    throw new Error("boom");
  });

  const runner = new InlineEffectRunner(store, registry);

  const outcome = await runner.runEffects(
    [
      {
        runId: "run-1",
        sessionId: "s1",
        stepIndex: 0,
        type: "explode",
        payload: {},
        idempotencyKey: "k1",
        failurePolicy: "STOP",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-1",
      sessionId: "s1",
      stepIndex: 0,
    },
  );

  assert.equal(outcome.stop, true);
  assert.equal(outcome.terminalStatus, "FAILED");
  assert.equal(outcome.errors.length, 1);
});

test("Effect runner CONTINUE policy keeps running", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();

  registry.register("explode", async () => {
    throw new Error("boom");
  });
  registry.register("ok", async () => ({ ok: true }));

  const runner = new InlineEffectRunner(store, registry);

  const outcome = await runner.runEffects(
    [
      {
        runId: "run-1",
        sessionId: "s1",
        stepIndex: 0,
        type: "explode",
        payload: {},
        idempotencyKey: "k1",
        failurePolicy: "CONTINUE",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
      {
        runId: "run-1",
        sessionId: "s1",
        stepIndex: 0,
        type: "ok",
        payload: {},
        idempotencyKey: "k2",
        failurePolicy: "STOP",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-1",
      sessionId: "s1",
      stepIndex: 0,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(outcome.errors.length, 1);

  const results = store.getEffectResults();
  assert.equal(results.length, 2);
  assert.equal(results.find((result) => result.idempotencyKey === "k2")?.status, "DONE");
});

test("Effect runner honors existing FAILED result and WAIT policy", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  registry.register("ok", async () => ({ ok: true }));

  await store.saveEffectResult("run-1", "s1", {
    idempotencyKey: "k-existing",
    status: "FAILED",
    error: {
      code: "EFFECT_EXECUTION_FAILED",
      message: "already failed",
    },
    timestamp: new Date().toISOString(),
  });

  const runner = new InlineEffectRunner(store, registry);
  const outcome = await runner.runEffects(
    [
      {
        runId: "run-1",
        sessionId: "s1",
        stepIndex: 0,
        type: "ok",
        payload: {},
        idempotencyKey: "k-existing",
        failurePolicy: "WAIT",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-1",
      sessionId: "s1",
      stepIndex: 0,
    },
  );

  assert.equal(outcome.stop, true);
  assert.equal(outcome.terminalStatus, "WAITING");
  assert.equal(outcome.errors.length, 1);
});

test("Effect runner re-enters tool preRun context for persisted managed worktree tool effects", async () => {
  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("s-managed", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "s-managed",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        exec: {
          managedWorktreeBinding: {
            status: "bound",
            sessionId: "s-managed",
            runId: "run-managed",
            worktreeRoot: "/trusted-worktree",
            leaseId: "lease-1",
          },
        },
      },
    },
  });

  const execInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          execInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "ok\n",
            text: "ok\n",
            truncated: false,
          };
        },
      } as never,
    },
    mcpManager: {
      refresh: async () => ({
        healthy: true,
        checkedAt: new Date().toISOString(),
        servers: [],
        tools: [],
      }),
      assertHealthy: async () => {},
      callTool: async () => {
        throw new Error("unexpected MCP tool call");
      },
      close: async () => {},
    },
  });
  await registry.refresh();

  const registryEffects = new EffectRegistry();
  registryEffects.register("execute_tool_call", createExecuteToolCallHandler(registry));
  const runner = new InlineEffectRunner(store, registryEffects);

  const outcome = await runner.runEffects(
    [
      {
        runId: "run-managed",
        sessionId: "s-managed",
        stepIndex: 0,
        type: "execute_tool_call",
        payload: {
          toolName: "dev.shell.run",
          toolInput: {
            command: "echo ok",
            workspaceRoot: ".",
          },
          runtimePayload: {
            workspace: {
              managedWorktree: true,
              workspaceRoot: "/trusted-worktree",
              leaseId: "lease-1",
            },
          },
        },
        idempotencyKey: "managed-effect-1",
        failurePolicy: "STOP",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-managed",
      sessionId: "s-managed",
      stepIndex: 0,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(execInputs.length, 1);
  assert.equal(execInputs[0]?.sourceWriteAuthority, "source_write");
  assert.deepEqual(execInputs[0]?.sourceWriteGuard, {
    enabled: true,
    managedWorktree: true,
    approvalGrants: [],
  });
});

test("Effect runner clamps durable dev.shell.run timeout against runtime budget", async () => {
  const store = new InMemorySessionStore();
  const calls: Array<Record<string, unknown>> = [];
  const registryEffects = new EffectRegistry();
  registryEffects.register("execute_tool_call", createExecuteToolCallHandler({
    validateInput: async (_name, input) => input,
    call: async (name: string, input: unknown) => {
      calls.push(input as Record<string, unknown>);
      return buildAgentToolSuccessResult({
        toolName: name,
        input,
        output: {
        status: "COMPLETED",
        stdout: "ok\n",
        text: "ok\n",
        truncated: false,
        },
      });
    },
  }));
  const runner = new InlineEffectRunner(store, registryEffects);

  const outcome = await runner.runEffects(
    [
      {
        runId: "run-budget",
        sessionId: "s-budget",
        stepIndex: 0,
        type: "execute_tool_call",
        payload: {
          toolName: "dev.shell.run",
          toolInput: {
            command: "python3 train.py",
            workspaceRoot: "/app",
            timeoutMs: 240_000,
          },
          runtimePayload: {},
        },
        idempotencyKey: "budget-effect-1",
        failurePolicy: "STOP",
        status: "PENDING",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      runId: "run-budget",
      sessionId: "s-budget",
      stepIndex: 0,
      runtimeBudgetRemainingMs: 95_000,
    },
  );

  assert.equal(outcome.stop, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "python3 train.py");
  assert.equal(typeof calls[0]?.timeoutMs, "number");
  assert.ok((calls[0]?.timeoutMs as number) <= 35_000);
  assert.ok((calls[0]?.timeoutMs as number) > 30_000);
});
