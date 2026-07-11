---
id: runtime-turn-coordinator-shell-parity-2026-05-22
domain: runtime
status: historical
owner: kestrel-runtime
last_verified_at: 2026-07-10
---

# Runtime Turn Coordinator Shell Parity Implementation Plan

See also: [Docs index](../../index.md).

This plan has been implemented in
[`RuntimeTurnCoordinator`](../../../src/runtime/RuntimeTurnCoordinator.ts) and
its `KestrelChatRuntime` integration. It remains as historical implementation
context.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the remaining top-level turn orchestration and runner actor metadata handling out of shell code and behind a concrete runtime-owned `RuntimeTurnCoordinator`.

**Architecture:** Add a source-owned coordinator service that compiles turns, selects thread/direct execution, performs exactly one supported recovery continuation, and returns the same `RuntimeTurnResult` shape currently returned by `KestrelChatRuntime`. Keep `KestrelChatRuntime` as the construction root and compatibility facade, and make runner/web shells pass validated actor metadata into canonical turn input.

**Tech Stack:** TypeScript, Node test runner, existing `Kestrel`, `ThreadRuntime`, runner protocol, web adapter, runtime unit/integration tests.

---

## File Map

- Create: `src/runtime/RuntimeTurnCoordinator.ts`
  - Concrete coordinator implementation and dependency interface.
  - Owns `runTurn`, direct kernel fallback, threaded submit/resume, recovery continuation, finalized payload fallback hook, and operator affordance hook.

- Modify: `src/runtime/RuntimeTurn.ts`
  - Keep pure types/compiler/recovery helpers.
  - Export any small types needed by the coordinator.

- Modify: `src/index.ts`
  - Export `RuntimeTurnCoordinatorService` and related coordinator dependency types.

- Modify: `cli/runtime/KestrelChatRuntime.ts`
  - Construct the coordinator and delegate `runTurn`.
  - Keep bootstrap/store/tool construction, project/workspace service construction, and compatibility API methods.
  - Remove duplicated run-turn flow from the shell.

- Modify: `cli/runner/CommandRouter.ts`
  - Pass command metadata into `RunnerHost.runStart`.

- Modify: `cli/runner/RunnerHost.ts`
  - Convert `RunnerCommandMetadata.actor` into `RuntimeTurnInput.actor` for `run.start`.
  - Preserve command metadata for protocol events.

- Modify: `src/web/adapter.ts`
  - Continue emitting actor metadata in command metadata.
  - Add parity assertion tests only if the turn payload is expected to carry actor metadata before transport; otherwise keep adapter unchanged.

- Test: `tests/unit/runtime-turn-coordinator.test.ts`
  - Coordinator unit coverage for ordinary turn, blocked resume, direct fallback, and recovery continuation.

- Modify: `tests/integration/runner-protocol.test.ts`
  - Assert `run.start` forwards actor metadata into runtime turn input.

- Modify: `tests/integration/cli-chat-runtime.test.ts`
  - Reduce shell tests to delegation and compatibility behavior, not payload construction internals.

---

### Task 1: Failing Tests for Runner Actor Propagation

**Files:**
- Modify: `tests/integration/runner-protocol.test.ts`

- [ ] **Step 1: Add a runner protocol test that captures `run.start` actor on runtime input**

Add this test near the existing `run.start emits started/log/completed protocol events` test:

```ts
test("run.start forwards actor metadata into runtime turn input", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let capturedActor: unknown;
  const host = new RunnerHost(writer, () => ({
    runTurn: async (input) => {
      capturedActor = input.actor;
      return {
        output: {
          status: "COMPLETED",
          sessionId: input.sessionId,
          runId: input.runId ?? "run-actor",
          errors: [],
          quality: {
            citationCoverage: 1,
            unresolvedClaims: 0,
            reworkRate: 0,
            thrashIndex: 0,
          },
          telemetry: {
            stepsExecuted: 1,
            toolCalls: 0,
            modelCalls: 0,
            durationMs: 1,
          },
        },
      };
    },
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  await router.acceptLine(JSON.stringify({
    id: "cmd-run-actor",
    type: "run.start",
    metadata: {
      profile,
      actor: {
        actorId: "alice",
        actorType: "end_user",
        displayName: "Alice",
        tenantId: "tenant-1",
      },
      tenantId: "tenant-1",
    },
    payload: {
      profile,
      turn: {
        sessionId: "session-actor",
        message: "hello",
        eventType: "user.message",
      },
    },
  }));

  assert.deepEqual(capturedActor, {
    actorId: "alice",
    actorType: "end_user",
    displayName: "Alice",
    tenantId: "tenant-1",
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --import tsx --test tests/integration/runner-protocol.test.ts
```

Expected: the new actor-on-turn assertions fail because `CommandRouter`/`RunnerHost` validate command metadata but do not inject it into `turn.actor`.

---

### Task 2: Implement Runner Actor Injection

**Files:**
- Modify: `cli/runner/CommandRouter.ts`
- Modify: `cli/runner/RunnerHost.ts`

- [ ] **Step 1: Change `RunnerHost.runStart` signature**

Change:

```ts
async runStart(commandId: string, payload: { profile?: TuiProfile | undefined; profileId?: string | undefined; turn: RunTurnInput }): Promise<void> {
```

to:

```ts
async runStart(
  commandId: string,
  payload: { profile?: TuiProfile | undefined; profileId?: string | undefined; turn: RunTurnInput },
  metadata?: RunnerCommandMetadata | undefined,
): Promise<void> {
```

- [ ] **Step 2: Inject actor metadata into the turn before runtime execution**

Immediately after `const turn = payload.turn;`, add:

```ts
const runtimeTurn: RunTurnInput = {
  ...turn,
  ...(metadata?.actor !== undefined ? { actor: metadata.actor } : {}),
};
```

Then replace run-start uses that should execute or track the runtime turn:

```ts
const requestedRunId = typeof runtimeTurn.runId === "string" && runtimeTurn.runId.trim().length > 0
  ? runtimeTurn.runId.trim()
  : undefined;
const existing = this.activeRuns.get(runtimeTurn.sessionId);
```

Use `runtimeTurn` in `run.started` payload, `commandBySession`, `activeRuns`, `runtime.runTurn(runtimeTurn, ...)`, diagnostics, and emitted terminal events. Keep command metadata unchanged for event metadata.

- [ ] **Step 3: Pass metadata from `CommandRouter`**

In `CommandRouter.dispatch`, change:

```ts
await this.host.runStart(command.id, payload);
```

to:

```ts
await this.host.runStart(command.id, payload, command.metadata);
```

- [ ] **Step 4: Run actor tests**

Run:

```bash
node --import tsx --test tests/integration/runner-protocol.test.ts
```

Expected: both actor propagation tests pass.

---

### Task 3: Failing Tests for Concrete Coordinator

**Files:**
- Create: `tests/unit/runtime-turn-coordinator.test.ts`

- [ ] **Step 1: Create coordinator test scaffold**

Create `tests/unit/runtime-turn-coordinator.test.ts` with local fakes:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  RuntimeTurnCoordinatorService,
  type RuntimeTurnInput,
} from "../../src/index.js";
import type { NormalizedOutput } from "../../src/kestrel/contracts.js";

function output(status: NormalizedOutput["status"], overrides: Partial<NormalizedOutput> = {}): NormalizedOutput {
  return {
    status,
    sessionId: "session-coordinator",
    runId: "run-coordinator",
    errors: [],
    quality: {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
    telemetry: {
      stepsExecuted: 1,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 1,
    },
    ...overrides,
  };
}
```

- [ ] **Step 2: Add ordinary thread turn test**

Add:

```ts
test("RuntimeTurnCoordinatorService compiles and submits ordinary thread turns", async () => {
  const submitted: unknown[] = [];
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      forceModeSystemV2: true,
      toolBatchCheckpointSize: 5,
    },
    ensureMainThread: async () => ({ threadId: "thread-main", sessionId: "session-coordinator" }),
    threadRuntime: {
      submitTurn: async (input) => {
        submitted.push(input);
        return {
          thread: { threadId: input.threadId, sessionId: "session-coordinator", title: "Main", status: "COMPLETED", createdAt: "2026-05-22T00:00:00.000Z", updatedAt: "2026-05-22T00:00:00.000Z" },
          output: output("COMPLETED"),
        };
      },
      resumeBlockedTurn: async () => { throw new Error("not used"); },
      getThreadStatus: async () => null,
    },
    directRun: async () => { throw new Error("not used"); },
    getSession: async () => undefined,
    buildOperatorAffordance: () => undefined,
  });

  const result = await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "hello",
    eventType: "user.message",
    actor: { actorId: "alice", actorType: "end_user" },
  });

  assert.equal(result.output.status, "COMPLETED");
  assert.equal((submitted[0] as { threadId?: string }).threadId, "thread-main");
});
```

- [ ] **Step 3: Add blocked resume test**

Add:

```ts
test("RuntimeTurnCoordinatorService delegates blocked resumes to ThreadRuntime resume API", async () => {
  let resumedActor: unknown;
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    ensureMainThread: async () => ({ threadId: "thread-main", sessionId: "session-coordinator" }),
    threadRuntime: {
      submitTurn: async () => { throw new Error("not used"); },
      resumeBlockedTurn: async (input) => {
        resumedActor = input.actor;
        return {
          thread: { threadId: input.threadId, sessionId: "session-coordinator", title: "Main", status: "COMPLETED", createdAt: "2026-05-22T00:00:00.000Z", updatedAt: "2026-05-22T00:00:00.000Z" },
          output: output("COMPLETED"),
        };
      },
      getThreadStatus: async () => null,
    },
    directRun: async () => { throw new Error("not used"); },
    getSession: async () => undefined,
    buildOperatorAffordance: () => undefined,
  });

  await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "approved",
    eventType: "user.message",
    resumeBlockedRun: true,
    actor: { actorId: "service-1", actorType: "service", displayName: "Resume Worker" },
  });

  assert.deepEqual(resumedActor, {
    actorId: "service-1",
    actorType: "service",
    displayName: "Resume Worker",
  });
});
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
node --import tsx --test tests/unit/runtime-turn-coordinator.test.ts
```

Expected: fails because `RuntimeTurnCoordinatorService` does not exist.

---

### Task 4: Implement `RuntimeTurnCoordinatorService`

**Files:**
- Create: `src/runtime/RuntimeTurnCoordinator.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create coordinator dependencies and class**

Create `src/runtime/RuntimeTurnCoordinator.ts`:

```ts
import { randomUUID } from "node:crypto";

import type { Kestrel, NormalizedOutput } from "../kestrel/contracts.js";
import type { ThreadRuntimePort, ThreadRecord, ThreadStatusSnapshot, SubmitTurnResult } from "../orchestration/contracts.js";
import { createRuntimeFailure } from "./RuntimeFailure.js";
import {
  compileRuntimeTurn,
  resolveRuntimeRecoveryContinuation,
  type CompileRuntimeTurnDefaults,
  type RuntimeTurnCoordinator,
  type RuntimeTurnInput,
  type RuntimeTurnResult,
} from "./RuntimeTurn.js";

export interface RuntimeTurnCoordinatorDependencies {
  defaults: CompileRuntimeTurnDefaults;
  ensureMainThread(input: { sessionId: string }): Promise<ThreadRecord | undefined>;
  threadRuntime?: Pick<ThreadRuntimePort, "submitTurn" | "resumeBlockedTurn" | "getThreadStatus"> | undefined;
  directRun(input: { id: string; type: string; sessionId: string; stepAgent?: string | undefined; payload: Record<string, unknown> }, options?: { signal?: AbortSignal | undefined }): Promise<NormalizedOutput>;
  getSession(sessionId: string): Promise<{ state: Record<string, unknown> } | undefined>;
  readFinalizedPayload?: ((sessionId: string) => Promise<unknown | undefined>) | undefined;
  readPersistedResumeStepAgent?: ((sessionId: string) => Promise<string | undefined>) | undefined;
  buildOperatorAffordance(input: { sessionState?: Record<string, unknown> | undefined; turn: RuntimeTurnInput; output: NormalizedOutput; threadStatus?: ThreadStatusSnapshot | null | undefined }): unknown | undefined;
}

export class RuntimeTurnCoordinatorService implements RuntimeTurnCoordinator {
  private readonly deps: RuntimeTurnCoordinatorDependencies;

  constructor(deps: RuntimeTurnCoordinatorDependencies) {
    this.deps = deps;
  }

  async runTurn(input: RuntimeTurnInput, options: { signal?: AbortSignal | undefined } = {}): Promise<RuntimeTurnResult> {
    const compiled = compileRuntimeTurn(input, this.deps.defaults);
    const first = await this.runCompiledTurn(compiled.input, compiled.payload, options);
    const recovery = await resolveRuntimeRecoveryContinuation({
      output: first.output,
      readPersistedResumeStepAgent: async () => this.deps.readPersistedResumeStepAgent?.(input.sessionId),
    });
    if (recovery === undefined) {
      return this.finalizeResult(compiled.input, first, options);
    }

    const recoveryCompiled = compileRuntimeTurn({
      ...compiled.input,
      eventType: recovery.eventType,
      stepAgent: recovery.stepAgent,
      manualCompaction: recovery.manualCompaction,
      resumeBlockedRun: recovery.resumeBlockedRun,
    }, this.deps.defaults);
    const second = await this.runCompiledTurn(recoveryCompiled.input, recoveryCompiled.payload, options);
    return this.finalizeResult(recoveryCompiled.input, second, options);
  }

  private async runCompiledTurn(
    input: RuntimeTurnInput,
    payload: Record<string, unknown>,
    options: { signal?: AbortSignal | undefined },
  ): Promise<{ output: NormalizedOutput; threadResult?: SubmitTurnResult | undefined }> {
    const threadRuntime = this.deps.threadRuntime;
    if (threadRuntime === undefined) {
      return {
        output: await this.deps.directRun({
          id: input.runId ?? randomUUID(),
          type: input.eventType,
          sessionId: input.sessionId,
          ...(input.stepAgent !== undefined ? { stepAgent: input.stepAgent } : {}),
          payload,
        }, options),
      };
    }

    const mainThread = await this.deps.ensureMainThread({ sessionId: input.sessionId });
    if (mainThread === undefined) {
      throw createRuntimeFailure("THREAD_MAIN_RESOLUTION_FAILED", `Session '${input.sessionId}' does not have a canonical main thread.`, {
        sessionId: input.sessionId,
      });
    }

    const result = input.resumeBlockedRun === true
      ? await threadRuntime.resumeBlockedTurn({
          threadId: mainThread.threadId,
          message: input.message,
          interactionMode: input.interactionMode === "auto" || input.interactionMode === "work" ? undefined : input.interactionMode,
          actSubmode: input.actSubmode,
          executionPolicy: input.executionPolicy,
          signal: options.signal,
          actor: input.actor,
          attachments: input.attachments,
        })
      : await threadRuntime.submitTurn({
          threadId: mainThread.threadId,
          message: input.message,
          eventType: input.eventType,
          ...(input.stepAgent !== undefined ? { stepAgent: input.stepAgent } : {}),
          ...(input.executionPolicy !== undefined ? { executionPolicy: input.executionPolicy } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...(input.manualCompaction === true ? { manualCompaction: true } : {}),
          ...(input.autoCompaction !== undefined ? { autoCompaction: input.autoCompaction } : {}),
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
          metadata: input.metadata ?? {},
        });

    return { output: result.output, threadResult: result };
  }

  private async finalizeResult(
    turn: RuntimeTurnInput,
    result: { output: NormalizedOutput; threadResult?: SubmitTurnResult | undefined },
    _options: { signal?: AbortSignal | undefined },
  ): Promise<RuntimeTurnResult> {
    const session = result.threadResult?.session ?? await this.deps.getSession(turn.sessionId);
    const threadStatus = result.threadResult?.thread.threadId !== undefined && this.deps.threadRuntime !== undefined
      ? await this.deps.threadRuntime.getThreadStatus(result.threadResult.thread.threadId)
      : undefined;
    const finalizedPayload = result.threadResult?.finalizedPayload ??
      (result.output.status === "COMPLETED" ? await this.deps.readFinalizedPayload?.(turn.sessionId) : undefined);
    const operatorAffordance = result.threadResult?.operatorAffordance ?? this.deps.buildOperatorAffordance({
      sessionState: session?.state,
      turn,
      output: result.output,
      threadStatus,
    });
    return {
      output: result.output,
      ...(finalizedPayload !== undefined ? { finalizedPayload } : {}),
      ...(operatorAffordance !== undefined ? { operatorAffordance } : {}),
    };
  }
}
```

- [ ] **Step 2: Export the coordinator**

In `src/index.ts`, add:

```ts
export * from "./runtime/RuntimeTurnCoordinator.js";
```

- [ ] **Step 3: Run coordinator tests**

Run:

```bash
node --import tsx --test tests/unit/runtime-turn-coordinator.test.ts
```

Expected: coordinator tests pass, or fail only on type mismatches that should be fixed without changing behavior.

---

### Task 5: Delegate `KestrelChatRuntime.runTurn` to Coordinator

**Files:**
- Modify: `cli/runtime/KestrelChatRuntime.ts`
- Modify: `tests/integration/cli-chat-runtime.test.ts`

- [ ] **Step 1: Add coordinator field and construct it**

Add a private field:

```ts
private readonly turnCoordinator: RuntimeTurnCoordinatorService;
```

Construct it after bootstrap dependencies are assigned:

```ts
this.turnCoordinator = new RuntimeTurnCoordinatorService({
  defaults: {
    defaultInteractionMode: this.defaultInteractionMode,
    defaultActSubmode: this.defaultActSubmode,
    modeSystemV2Enabled: this.modeSystemV2Enabled,
    forceModeSystemV2: this.forceModeSystemV2,
    defaultExecutionPolicy: this.defaultExecutionPolicy,
    toolBatchCheckpointSize: this.toolBatchCheckpointSize,
  },
  ensureMainThread: async ({ sessionId }) => this.ensureMainThread(sessionId),
  threadRuntime: this.threadRuntime,
  directRun: async (event, runOptions) => this.kestrel.run(event, runOptions),
  getSession: async (sessionId) => await this.kestrel.getSession(sessionId) ?? undefined,
  readFinalizedPayload: this.readFinalizedPayload,
  readPersistedResumeStepAgent: async (sessionId) => {
    const session = await this.kestrel.getSession(sessionId);
    return readResumeStepAgentFromSession(session?.state);
  },
  buildOperatorAffordance: ({ sessionState, turn, output, threadStatus }) =>
    buildRuntimeOperatorAffordance({
      reactState: asRecord(sessionState?.agent),
      turn: turn as RunTurnInput,
      output,
      ...(threadStatus !== null && threadStatus !== undefined ? { activeAssembly: toOperatorAssemblySummary(threadStatus) } : {}),
    }),
});
```

- [ ] **Step 2: Replace `runTurn` body**

Keep input validation and active task metadata, then delegate:

```ts
async runTurn(input: RunTurnInput, options: { signal?: AbortSignal | undefined } = {}): Promise<RunTurnResult> {
  const normalizedInput: RunTurnInput = {
    ...input,
    message: requireRunTurnMessage(input.message),
  };
  const effectiveInput = await this.withActiveTaskRuntimeMetadata(normalizedInput);
  const result = await this.turnCoordinator.runTurn(effectiveInput, options);
  return result as RunTurnResult;
}
```

Remove shell-local direct run, recovery continuation, and `runThreadTurn`.

- [ ] **Step 3: Run shell integration tests**

Run:

```bash
node --import tsx --test tests/integration/cli-chat-runtime.test.ts tests/unit/runtime-turn-coordinator.test.ts
```

Expected: tests pass, with CLI tests asserting delegation/compatibility rather than compiler internals.

---

### Task 6: Validation and Generated Resources

**Files:**
- Generated resources may update under `apps/desktop/resources/kestrel-repo`.

- [ ] **Step 1: Typecheck**

Run:

```bash
pnpm run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run focused seam tests**

Run:

```bash
node --import tsx --test tests/unit/runtime-turn-compiler.test.ts tests/unit/runtime-turn-coordinator.test.ts tests/unit/orchestration-thread-runtime.test.ts tests/integration/runner-protocol.test.ts tests/integration/cli-chat-runtime.test.ts
```

Expected: all pass.

- [ ] **Step 3: Regenerate desktop resources if governance reports stale files**

Run:

```bash
pnpm --filter @kestrel/desktop prepare:resources
```

Expected: generated runtime resources update cleanly.

- [ ] **Step 4: Run required gates**

Run:

```bash
pnpm run governance:check
pnpm run test
pnpm run prompt-suite
pnpm run evals:release-check
```

Expected: all pass. If `pnpm run test` hits the known transient `DevShellSupervisor returns completed command output without a processId` failure, rerun `node --import tsx --test tests/unit/dev-shell-supervisor.test.ts` to classify whether it is flaky or repeatable before changing code.

---

## Review Checklist

- [ ] `KestrelChatRuntime` no longer imports `compileRuntimeTurn` or `resolveRuntimeRecoveryContinuation` directly.
- [ ] `KestrelChatRuntime` no longer has a private `runThreadTurn` method.
- [ ] `RuntimeTurnCoordinatorService` is the only owner of one-shot recovery continuation after a supported `WAITING` result.
- [ ] `RunnerHost.runStart` passes command actor metadata into `RuntimeTurnInput.actor`.
- [ ] Blocked resume actor identity is recorded through `ThreadRuntime.resumeBlockedTurn`.
- [ ] `createTurnExecutor(...)` and external run submissions both use the runtime compiler path.
- [ ] No heuristic runtime decision logic was introduced.
