---
id: runtime-native-subagents-plan-2026-05-19
domain: runtime
status: draft
owner: kestrel-runtime
last_verified_at: 2026-07-03
depends_on:
  - ../specs/2026-05-19-runtime-native-subagents-design.md
---

# Runtime-Native Sub-Agents Implementation Plan

See also: [Docs index](../../index.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal `agent.spawn({ task })` capability that lets Kestrel agents spawn runtime-native child agents through the existing delegation/orchestration stack.

**Architecture:** Reuse existing delegation records, child threads, `DelegationSupervisor`, task graph projections, managed worktrees, and operator notifications. Add a small agent-facing tool, derive parent/task/depth context in runtime, store a tiny child result envelope, and keep Kanban as task aggregation rather than one card per child.

**Tech Stack:** TypeScript, Node test runner, Kestrel shared tool catalog, `UnifiedToolRegistry`, `ThreadRuntime`, `DelegationSupervisor`, `ProductTaskGraphStore`, managed task worktrees.

---

## File Structure

- Create `tools/runtime/agentSpawn.ts`
  - Owns the agent-facing `agent.spawn` tool and its tiny `{ task: string }` schema.
- Modify `tools/contracts.ts`
  - Adds shared runtime context available to runtime tools during a run.
  - Adds lightweight sub-agent result and metadata types.
- Modify `tools/catalog.ts`, `tools/index.ts`, `tools/runtime/builtInToolInputContracts.ts`
  - Registers and exports `agent.spawn`.
- Modify `tools/runtime/UnifiedToolRegistry.ts`
  - Carries current run/thread/task context into tool calls.
  - Exposes `agent.spawn` to the model while keeping legacy runtime-only `delegate.*` hidden.
- Modify `cli/contracts.ts`, `cli/config/ProfileStore.ts`
  - Adds profile delegation depth policy.
  - Includes `agent.spawn` in the delegation-enabled allowlist.
- Modify `src/orchestration/contracts.ts`, `src/orchestration/Supervision.ts`, `src/orchestration/DelegationSupervisor.ts`, `src/orchestration/ThreadRuntime.ts`
  - Carries task linkage and delegation depth metadata through child creation.
  - Enforces max depth.
  - Normalizes and stores child result envelopes.
- Create `src/orchestration/subAgentResult.ts`
  - Owns parsing and storing the child result envelope.
- Modify `src/taskGraph/contracts.ts`, `src/taskGraph/state.ts`, `src/taskGraph/store.ts`
  - Aggregates child activity under an active task/card instead of always creating a delegation card.
- Modify `cli/runtime/KestrelChatRuntime.ts`
  - Passes active task linkage into runtime context and task graph updates.
- Modify focused tests:
  - `tests/unit/unified-tool-registry.test.ts`
  - `tests/unit/orchestration-thread-runtime.test.ts`
  - `tests/taskGraphStore.test.ts`
  - `tests/unit/runtime-assembly.test.ts`

## Task 1: Add `agent.spawn` as a Minimal Model-Visible Runtime Tool

**Files:**
- Create: `tools/runtime/agentSpawn.ts`
- Modify: `tools/contracts.ts`
- Modify: `tools/catalog.ts`
- Modify: `tools/index.ts`
- Modify: `tools/runtime/builtInToolInputContracts.ts`
- Modify: `tools/runtime/UnifiedToolRegistry.ts`
- Modify: `cli/config/ProfileStore.ts`
- Test: `tests/unit/unified-tool-registry.test.ts`

- [ ] **Step 1: Write failing registry tests for `agent.spawn` visibility and schema**

Add this test near the existing runtime built-in tests in `tests/unit/unified-tool-registry.test.ts`:

```ts
test("UnifiedToolRegistry exposes agent.spawn as the model-facing runtime spawn tool", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["agent.spawn", "delegate.spawn_child", "FinalizeAnswer"],
    context: {
      onFinalize: (payload) => payload,
      delegationService: {
        async spawnTask(input) {
          return {
            taskId: "task-child",
            parentSessionId: input.parentSessionId,
            title: input.title,
            status: "RUNNING",
            childSessionId: "thread-child",
            childSessionName: "task:child",
            profileId: "reference",
            provider: "openrouter",
            model: "mock",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
        async listTasks() {
          return [];
        },
        async getTaskResult() {
          return null;
        },
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  const tools = registry.getModelTools().map((tool) => tool.name);
  assert.deepEqual(tools, ["agent.spawn"]);
});

test("agent.spawn accepts only a task string", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["agent.spawn"],
    context: {
      delegationService: {
        async spawnTask(input) {
          return {
            taskId: "task-child",
            parentSessionId: input.parentSessionId,
            title: input.title,
            status: "RUNNING",
            childSessionId: "thread-child",
            childSessionName: "task:child",
            profileId: "reference",
            provider: "openrouter",
            model: "mock",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
        async listTasks() {
          return [];
        },
        async getTaskResult() {
          return null;
        },
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await registry.validateInput("agent.spawn", { task: "Investigate failing tests" });
  await assert.rejects(
    () => registry.validateInput("agent.spawn", {
      task: "Investigate failing tests",
      parentSessionId: "session-root",
    }),
    /must NOT have additional properties/u,
  );
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --import tsx --test tests/unit/unified-tool-registry.test.ts
```

Expected: fails because `agent.spawn` is not registered and not visible in `getModelTools()`.

- [ ] **Step 3: Add runtime context and the `agent.spawn` tool**

In `tools/contracts.ts`, add this interface near the delegation types:

```ts
export interface RuntimeToolRunContext {
  runId: string;
  sessionId: string;
  threadId?: string | undefined;
  activeTaskId?: string | undefined;
  delegationId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
}
```

Add the runtime context to `SharedToolContext`:

```ts
  runtime?: RuntimeToolRunContext | undefined;
```

Update `DelegationTaskSpawnRequest` so `agent.spawn` can pass runtime-derived metadata without widening the agent-facing schema:

```ts
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
```

Create `tools/runtime/agentSpawn.ts`:

```ts
import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const agentSpawnTool: SharedToolModule = {
  definition: {
    name: "agent.spawn",
    description: "Spawn a child Kestrel agent for one bounded task. Input must contain only a task string.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
      },
      required: ["task"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "low",
      costClass: "free",
      executionClass: "sandboxed_only",
      capabilityClasses: ["runtime.agent.spawn"],
    },
    presentation: {
      displayName: "Spawn Agent",
      aliases: ["spawn agent", "subagent", "child agent"],
      keywords: ["agent", "subagent", "spawn", "parallel"],
      provider: "kestrel",
      toolFamily: "runtime",
    },
  },
  createHandler(context) {
    if (context.delegationService === undefined) {
      throw createRuntimeFailure(
        "TOOL_CONTEXT_INVALID",
        "agent.spawn requires tool context.delegationService.",
        {
          subsystem: "tooling",
          toolName: "agent.spawn",
          classification: "configuration",
          recoverable: false,
        },
      );
    }
    if (context.runtime === undefined) {
      throw createRuntimeFailure(
        "TOOL_CONTEXT_INVALID",
        "agent.spawn requires active runtime context.",
        {
          subsystem: "tooling",
          toolName: "agent.spawn",
          classification: "configuration",
          recoverable: false,
        },
      );
    }

    return async (input: unknown) => {
      const body = parseObjectInput("agent.spawn", input);
      const task = requireStringField("agent.spawn", body, "task").trim();
      if (task.length === 0) {
        throw createRuntimeFailure(
          "AGENT_SPAWN_INPUT_INVALID",
          "agent.spawn input.task must be a non-empty string.",
          {
            subsystem: "tooling",
            toolName: "agent.spawn",
            classification: "schema",
            recoverable: true,
          },
        );
      }
      const runtime = context.runtime!;
      const title = task.length > 72 ? `${task.slice(0, 69)}...` : task;
      return context.delegationService!.spawnTask({
        parentSessionId: runtime.threadId ?? runtime.sessionId,
        parentRunId: runtime.runId,
        title,
        prompt: task,
        launchedBy: "agent",
        taskId: runtime.activeTaskId,
        parentTaskId: runtime.activeTaskId,
        delegationDepth: runtime.delegationDepth,
        rootDelegationId: runtime.rootDelegationId,
      });
    };
  },
};
```

- [ ] **Step 4: Register and export `agent.spawn`**

In `tools/catalog.ts`, import and insert the module near existing delegation tools:

```ts
import { agentSpawnTool } from "./runtime/agentSpawn.js";
```

Add it before the legacy delegate tools in `DEFAULT_MODULES`:

```ts
  agentSpawnTool,
  delegateSpawnChildTool,
  delegateListChildrenTool,
  delegateGetChildResultTool,
```

In `tools/index.ts`, export it:

```ts
export { agentSpawnTool } from "./runtime/agentSpawn.js";
```

In `tools/runtime/builtInToolInputContracts.ts`, add:

```ts
  "agent.spawn": { mode: "schema-only" },
```

- [ ] **Step 5: Expose only `agent.spawn` among runtime delegation tools**

In `tools/runtime/UnifiedToolRegistry.ts`, add:

```ts
const MODEL_VISIBLE_RUNTIME_TOOL_NAMES = new Set(["agent.spawn"]);
```

Replace runtime-hidden checks in `getModelTools()`, `getCapabilityManifest()`, and `listAvailableToolNames()` with:

```ts
        if (isRuntimeBuiltInTool(name, this.builtInCapabilities) && MODEL_VISIBLE_RUNTIME_TOOL_NAMES.has(name) === false) {
          continue;
        }
```

Keep `resolveAvailableAllowlist()` unchanged so runtime-only tools can still remain valid internal allowlist entries.

- [ ] **Step 6: Include `agent.spawn` when delegation is enabled**

In `cli/config/ProfileStore.ts`, update `DELEGATION_TOOL_NAMES`:

```ts
const DELEGATION_TOOL_NAMES = [
  "agent.spawn",
  "delegate.spawn_child",
  "delegate.list_children",
  "delegate.get_child_result",
] as const;
```

- [ ] **Step 7: Run tests and commit**

Run:

```bash
node --import tsx --test tests/unit/unified-tool-registry.test.ts
```

Expected: passes.

Commit:

```bash
git add tools/runtime/agentSpawn.ts tools/contracts.ts tools/catalog.ts tools/index.ts tools/runtime/builtInToolInputContracts.ts tools/runtime/UnifiedToolRegistry.ts cli/config/ProfileStore.ts tests/unit/unified-tool-registry.test.ts
git commit -m "feat(runtime): add agent spawn tool"
```

## Task 2: Derive Parent Runtime Context For `agent.spawn`

**Files:**
- Modify: `tools/runtime/UnifiedToolRegistry.ts`
- Modify: `cli/runtime/KestrelChatRuntime.ts`
- Test: `tests/unit/unified-tool-registry.test.ts`

- [ ] **Step 1: Write failing test for derived runtime context**

Add this test in `tests/unit/unified-tool-registry.test.ts`:

```ts
test("agent.spawn derives parent run and thread context from preRun", async () => {
  const spawned: unknown[] = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["agent.spawn"],
    context: {
      delegationService: {
        async spawnTask(input) {
          spawned.push(input);
          return {
            taskId: "task-child",
            parentSessionId: input.parentSessionId,
            parentRunId: input.parentRunId,
            title: input.title,
            status: "RUNNING",
            childSessionId: "thread-child",
            childSessionName: "task:child",
            profileId: "reference",
            provider: "openrouter",
            model: "mock",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
        async listTasks() {
          return [];
        },
        async getTaskResult() {
          return null;
        },
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();
  await registry.preRun({
    runId: "run-parent",
    event: {
      id: "event-parent",
      type: "user.message",
      sessionId: "session-parent",
      payload: {
        threadId: "thread-parent",
        activeTaskId: "task-active",
      },
    },
    session: {
      sessionId: "session-parent",
      version: 0,
      state: {},
      updatedAt: new Date().toISOString(),
    },
  });

  await registry.call("agent.spawn", { task: "Check the API contract" });

  assert.deepEqual(spawned[0], {
    parentSessionId: "thread-parent",
    parentRunId: "run-parent",
    title: "Check the API contract",
    prompt: "Check the API contract",
    launchedBy: "agent",
    taskId: "task-active",
    parentTaskId: "task-active",
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --import tsx --test tests/unit/unified-tool-registry.test.ts
```

Expected: fails because `preRun()` does not populate `context.runtime`.

- [ ] **Step 3: Add runtime context derivation**

In `tools/runtime/UnifiedToolRegistry.ts`, add:

```ts
function resolveRuntimeToolRunContext(context: ToolGatewayPreRunContext): RuntimeToolRunContext {
  const payload = context.event.payload;
  return {
    runId: context.runId,
    sessionId: context.session.sessionId,
    threadId: asNonEmptyString(payload.threadId),
    activeTaskId: asNonEmptyString(payload.activeTaskId),
    delegationId: asNonEmptyString(payload.delegationId),
    delegationDepth: asInteger(payload.delegationDepth),
    rootDelegationId: asNonEmptyString(payload.rootDelegationId),
  };
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
```

Then update `preRun()` so the scoped built-in context includes it:

```ts
const baseContext = resolveScopedRunContext(
  _context.event.payload,
  this.defaultAllowlist,
  this.builtInContext,
  hasTrustedManagedWorktreeBinding(
    _context.runId,
    _context.session.state,
    _context.event.payload,
    _context.session.sessionId,
  ),
);
this.scopedRunContext.enterWith({
  ...baseContext,
  builtInContext: {
    ...baseContext.builtInContext,
    runtime: resolveRuntimeToolRunContext(_context),
  },
});
```

- [ ] **Step 4: Make `activeTaskId` available from the chat runtime**

In `cli/runtime/KestrelChatRuntime.ts`, when constructing `RunTurnInput` for thread turns, add `activeTaskId` to the event payload only when the task graph store has an active task.

Use this helper near other local helpers:

```ts
async function readActiveTaskId(
  taskGraphStore: ProductTaskGraphStore | undefined,
  sessionId: string,
): Promise<string | undefined> {
  if (taskGraphStore === undefined) {
    return undefined;
  }
  const graph = await taskGraphStore.getGraph({ sessionId });
  return graph.activeTaskId;
}
```

Before submitting the runtime turn, merge:

```ts
...(activeTaskId !== undefined ? { activeTaskId } : {}),
```

into the existing event payload object passed to the engine.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --import tsx --test tests/unit/unified-tool-registry.test.ts
pnpm exec tsc --noEmit --pretty false
```

Expected: both pass.

Commit:

```bash
git add tools/runtime/UnifiedToolRegistry.ts cli/runtime/KestrelChatRuntime.ts tests/unit/unified-tool-registry.test.ts
git commit -m "feat(runtime): derive agent spawn context"
```

## Task 3: Enforce Delegation Depth And Store Lineage Metadata

**Files:**
- Modify: `cli/contracts.ts`
- Modify: `cli/config/ProfileStore.ts`
- Modify: `tools/contracts.ts`
- Modify: `src/orchestration/contracts.ts`
- Modify: `src/orchestration/Supervision.ts`
- Modify: `src/orchestration/DelegationSupervisor.ts`
- Test: `tests/unit/orchestration-thread-runtime.test.ts`

- [ ] **Step 1: Write failing depth-limit test**

Add this test near the delegation tests in `tests/unit/orchestration-thread-runtime.test.ts`:

```ts
test("ThreadRuntime rejects child spawn beyond profile delegation depth", async () => {
  const sessionStore = new InMemorySessionStore();
  const runtime = new ThreadRuntime({
    sessionStore,
    executor: new QueueTurnExecutor(sessionStore, []),
    profile: buildProfile({
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 2,
        maxDepth: 1,
      },
    }),
  });

  await runtime.startThread({
    threadId: "thread-depth-root",
    title: "Depth root",
  });

  await assert.rejects(
    () =>
      runtime.spawnDelegation({
        parentThreadId: "thread-depth-root",
        parentRunId: "run-depth-root",
        title: "Nested child",
        prompt: "Should be rejected",
        launchedBy: "agent",
        policy: {
          depth: 1,
          maxDepth: 1,
        },
      }),
    /Delegation depth limit reached/u,
  );
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --import tsx --test tests/unit/orchestration-thread-runtime.test.ts --test-name-pattern "depth"
```

Expected: fails because `maxDepth` and `depth` are not modeled.

- [ ] **Step 3: Add depth fields to policy contracts**

In `cli/contracts.ts`, update `DelegationPolicyConfig`:

```ts
export interface DelegationPolicyConfig {
  allowAgentSpawn?: boolean | undefined;
  maxConcurrentChildSessions?: number | undefined;
  maxDepth?: number | undefined;
}
```

In `cli/config/ProfileStore.ts`, update the default:

```ts
const DEFAULT_DELEGATION_POLICY = {
  allowAgentSpawn: false,
  maxConcurrentChildSessions: 2,
  maxDepth: 2,
};
```

And parse `maxDepth` alongside `maxConcurrentChildSessions`:

```ts
const maxDepth =
  typeof record.maxDepth === "number" &&
  Number.isFinite(record.maxDepth)
    ? Math.max(0, Math.trunc(record.maxDepth))
    : undefined;
```

Return:

```ts
...(maxDepth !== undefined ? { maxDepth } : {}),
```

In `src/orchestration/contracts.ts`, update `ChildThreadPolicy`:

```ts
  depth?: number | undefined;
  maxDepth?: number | undefined;
  rootDelegationId?: string | undefined;
  parentTaskId?: string | undefined;
```

`DelegationTaskSpawnRequest` already has the runtime-derived task and depth fields from Task 1.

- [ ] **Step 4: Normalize and enforce depth**

In `src/orchestration/Supervision.ts`, update `normalizeLaunchPolicy()` so it preserves the new fields:

```ts
  ...(typeof input.policy?.depth === "number" ? { depth: Math.max(0, Math.trunc(input.policy.depth)) } : {}),
  ...(typeof input.policy?.maxDepth === "number" ? { maxDepth: Math.max(0, Math.trunc(input.policy.maxDepth)) } : {}),
  ...(input.policy?.rootDelegationId !== undefined ? { rootDelegationId: input.policy.rootDelegationId } : {}),
  ...(input.policy?.parentTaskId !== undefined ? { parentTaskId: input.policy.parentTaskId } : {}),
```

In `src/orchestration/DelegationSupervisor.ts`, pass tool request metadata through `spawnTask()`:

```ts
policy: {
  ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
  ...(input.delegationDepth !== undefined ? { depth: input.delegationDepth + 1 } : { depth: 1 }),
  maxDepth: this.profile.delegation?.maxDepth ?? 2,
  ...(input.rootDelegationId !== undefined ? { rootDelegationId: input.rootDelegationId } : {}),
},
```

Add a depth check in `spawnDelegation()` after profile compatibility and before capacity:

```ts
this.assertDepth(input.policy);
```

Add the helper:

```ts
private assertDepth(policy: ChildThreadPolicy | undefined): void {
  const depth = policy?.depth ?? 1;
  const maxDepth = policy?.maxDepth ?? this.profile.delegation?.maxDepth ?? 2;
  if (depth > maxDepth) {
    throw createRuntimeFailure(
      "DELEGATION_DEPTH_LIMIT_REACHED",
      `Delegation depth limit reached (${depth}/${maxDepth}).`,
      {
        subsystem: "orchestration",
        classification: "policy",
        recoverable: true,
        depth,
        maxDepth,
      },
    );
  }
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --import tsx --test tests/unit/orchestration-thread-runtime.test.ts --test-name-pattern "delegat|depth"
```

Expected: passes.

Commit:

```bash
git add cli/contracts.ts cli/config/ProfileStore.ts tools/contracts.ts src/orchestration/contracts.ts src/orchestration/Supervision.ts src/orchestration/DelegationSupervisor.ts tests/unit/orchestration-thread-runtime.test.ts
git commit -m "feat(runtime): enforce subagent depth policy"
```

## Task 4: Store Minimal Child Result Envelopes

**Files:**
- Create: `src/orchestration/subAgentResult.ts`
- Modify: `src/kestrel/contracts.ts`
- Modify: `src/orchestration/DelegationSupervisor.ts`
- Modify: `src/orchestration/Supervision.ts`
- Test: `tests/unit/orchestration-thread-runtime.test.ts`

- [ ] **Step 1: Write failing result-envelope test**

Add this test near the existing child completion test:

```ts
test("ThreadRuntime stores minimal child agent result envelope", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-child-result",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        status: "completed",
        result: "API contract is already covered by unit tests.",
        references: ["file://tests/unit/api-contract.test.ts"],
      },
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-result-root",
    title: "Result root",
  });
  const handle = await runtime.spawnDelegation({
    parentThreadId: "thread-result-root",
    parentRunId: "run-result-root",
    title: "Check API contract",
    prompt: "Check the API contract",
    launchedBy: "agent",
  });
  await tick();

  const delegation = await sessionStore.getDelegation(handle.delegationId);
  assert.deepEqual(delegation?.result, {
    status: "completed",
    result: "API contract is already covered by unit tests.",
    references: ["file://tests/unit/api-contract.test.ts"],
  });
  assert.equal(delegation?.resultSummary, "API contract is already covered by unit tests.");
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --import tsx --test tests/unit/orchestration-thread-runtime.test.ts --test-name-pattern "result envelope"
```

Expected: fails because `DelegationRecord` has no `result` envelope.

- [ ] **Step 3: Add result envelope type and parser**

In `src/kestrel/contracts.ts`, import or define the result shape near `DelegationRecord`:

```ts
export interface SubAgentResultEnvelope {
  status: "completed" | "blocked" | "failed";
  result: string;
  references?: string[] | undefined;
  error?: {
    code: string;
    message: string;
  } | undefined;
}
```

Update `DelegationRecord`:

```ts
  result?: SubAgentResultEnvelope | undefined;
```

Create `src/orchestration/subAgentResult.ts`:

```ts
import type { SubAgentResultEnvelope } from "../kestrel/contracts.js";

export function normalizeSubAgentResult(
  value: unknown,
  fallbackStatus: SubAgentResultEnvelope["status"],
): SubAgentResultEnvelope {
  if (isRecord(value)) {
    const status = readStatus(value.status) ?? fallbackStatus;
    const result = typeof value.result === "string"
      ? value.result
      : typeof value.message === "string"
        ? value.message
        : stringifyResult(value);
    const references = Array.isArray(value.references)
      ? value.references.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : undefined;
    const error = isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"
      ? { code: value.error.code, message: value.error.message }
      : undefined;
    return {
      status,
      result,
      ...(references !== undefined && references.length > 0 ? { references } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
  return {
    status: fallbackStatus,
    result: typeof value === "string" ? value : stringifyResult(value),
  };
}

function readStatus(value: unknown): SubAgentResultEnvelope["status"] | undefined {
  return value === "completed" || value === "blocked" || value === "failed" ? value : undefined;
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}
```

- [ ] **Step 4: Persist result envelope through delegation records**

In `src/orchestration/DelegationSupervisor.ts`, import:

```ts
import { normalizeSubAgentResult } from "./subAgentResult.js";
```

When a child completes, compute:

```ts
const resultEnvelope = normalizeSubAgentResult(
  result.finalizedPayload ?? result.output,
  result.output.status === "COMPLETED" ? "completed" : "failed",
);
```

Then include it in the completed record:

```ts
result: resultEnvelope,
resultSummary: resultEnvelope.result.slice(0, 240),
```

For waiting children, set:

```ts
result: {
  status: "blocked",
  result: `Waiting for ${result.output.waitFor.eventType}.`,
  error: {
    code: result.output.waitFor.eventType,
    message: `Child agent is waiting for ${result.output.waitFor.eventType}.`,
  },
},
```

For caught failures, set:

```ts
result: {
  status: "failed",
  result: runtimeError.message,
  error: {
    code: runtimeError.code,
    message: runtimeError.message,
  },
},
```

In `src/orchestration/PostgresOrchestrationStore.ts`, store the envelope in `policy_json.subAgentResult` to avoid a schema migration:

```ts
policy: record.result === undefined
  ? record.policy
  : {
      ...(record.policy ?? {}),
      subAgentResult: record.result,
    },
```

When reading rows, hydrate:

```ts
const policy = parsePolicy(row.policy_json);
const result = readSubAgentResultFromPolicy(policy);
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --import tsx --test tests/unit/orchestration-thread-runtime.test.ts --test-name-pattern "result envelope|delegated child"
```

Expected: passes.

Commit:

```bash
git add src/orchestration/subAgentResult.ts src/kestrel/contracts.ts src/orchestration/DelegationSupervisor.ts src/orchestration/Supervision.ts src/orchestration/PostgresOrchestrationStore.ts tests/unit/orchestration-thread-runtime.test.ts
git commit -m "feat(runtime): store subagent results"
```

## Task 5: Attach Child Activity To Active Kanban Tasks Without Creating Cards By Default

**Files:**
- Modify: `src/taskGraph/contracts.ts`
- Modify: `src/taskGraph/state.ts`
- Modify: `src/taskGraph/store.ts`
- Modify: `cli/runtime/KestrelChatRuntime.ts`
- Test: `tests/taskGraphStore.test.ts`

- [ ] **Step 1: Write failing aggregation test**

Add this test to `tests/taskGraphStore.test.ts`:

```ts
test("ProductTaskGraphStore aggregates child agent activity on active task by default", async () => {
  const store = new SceneInMemorySessionStore();
  const graphStore = new ProductTaskGraphStore(store);
  await graphStore.saveGraph({
    sessionId: "session-main",
    graph: {
      version: 1,
      activeTaskId: "task:thread:thread-main",
      rootTaskIds: ["task:thread:thread-main"],
      tasks: {
        "task:thread:thread-main": {
          id: "task:thread:thread-main",
          title: "Main thread",
          order: 0,
          status: "active",
          source: "thread",
          proposedByAgent: false,
          linkedThreadId: "thread-main",
          linkedSessionId: "session-main",
          activeThreadLineageId: "thread-main",
          memory: {
            goal: "",
            currentPlan: "",
            findings: "",
            decisions: "",
            openQuestions: "",
            nextAction: "",
            linkedArtifacts: [],
          },
          runtime: {},
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });

  const updated = await graphStore.applyDelegationUpdate({
    sessionId: "session-main",
    parentTaskId: "task:thread:thread-main",
    aggregateOnParentTask: true,
    task: {
      taskId: "task-child",
      title: "Investigate browser flow",
      status: "COMPLETED",
      childSessionId: "session-child",
      resultSummary: "Browser flow is covered.",
      updatedAt: new Date().toISOString(),
    },
  });

  assert.equal(updated.tasks["task-child"], undefined);
  assert.equal(updated.tasks["task:thread:thread-main"]?.runtime.childSummary, "children:1 active:0 blocked:0 failed:0 completed:1");
  assert.equal(updated.tasks["task:thread:thread-main"]?.runtime.resultSummary, "Browser flow is covered.");
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --import tsx --test tests/taskGraphStore.test.ts
```

Expected: fails because `aggregateOnParentTask` and child activity summaries do not exist.

- [ ] **Step 3: Add task runtime child activity fields**

In `src/taskGraph/contracts.ts`, add:

```ts
export interface TaskChildActivitySummary {
  total: number;
  active: number;
  blocked: number;
  failed: number;
  completed: number;
  latestResult?: string | undefined;
}
```

Extend `TaskRuntimeSummary`:

```ts
  childActivity?: TaskChildActivitySummary | undefined;
```

- [ ] **Step 4: Aggregate child updates on parent task**

In `src/taskGraph/store.ts`, extend `applyDelegationUpdate()` input:

```ts
    aggregateOnParentTask?: boolean | undefined;
```

When `aggregateOnParentTask === true` and `parentTaskId` exists, update the parent task instead of calling `ensureDelegationTask()`:

```ts
if (input.aggregateOnParentTask === true && parentTaskId !== undefined && graph.tasks[parentTaskId] !== undefined) {
  const next = applyDelegationActivityToParentTask(graph, parentTaskId, input.task);
  await this.store.patchSessionState({
    sessionId: input.sessionId,
    statePatch: buildTaskGraphStatePatch(currentState, next),
    reason: "task_graph",
  });
  return next;
}
```

In `src/taskGraph/state.ts`, add:

```ts
export function applyDelegationActivityToParentTask(
  graph: ProductTaskGraph,
  parentTaskId: string,
  task: ProductDelegationTask,
): ProductTaskGraph {
  const parent = graph.tasks[parentTaskId];
  if (parent === undefined) {
    return graph;
  }
  const current = parent.runtime.childActivity ?? {
    total: 0,
    active: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
  };
  const previousStatus = readStoredChildStatus(parent.runtime, task.taskId);
  const next = subtractStatus(current, previousStatus);
  const status = deriveDelegationActivityStatus(task.status);
  const incremented = addStatus({
    ...next,
    total: previousStatus === undefined ? next.total + 1 : next.total,
    ...(task.resultSummary !== undefined ? { latestResult: task.resultSummary } : {}),
  }, status);
  return {
    ...graph,
    tasks: {
      ...graph.tasks,
      [parentTaskId]: {
        ...parent,
        runtime: {
          ...parent.runtime,
          childActivity: incremented,
          childSummary: `children:${incremented.total} active:${incremented.active} blocked:${incremented.blocked} failed:${incremented.failed} completed:${incremented.completed}`,
          ...(task.resultSummary !== undefined ? { resultSummary: task.resultSummary } : {}),
          childStatusByDelegation: {
            ...((parent.runtime as Record<string, unknown>).childStatusByDelegation as Record<string, string> | undefined ?? {}),
            [task.taskId]: status,
          },
        },
        updatedAt: task.updatedAt,
      },
    },
  };
}
```

Add small helpers in the same file:

```ts
type DelegationActivityStatus = "active" | "blocked" | "failed" | "completed";

function deriveDelegationActivityStatus(status: ProductDelegationTask["status"]): DelegationActivityStatus {
  if (status === "FAILED") {
    return "failed";
  }
  if (status === "WAITING") {
    return "blocked";
  }
  if (status === "COMPLETED") {
    return "completed";
  }
  return "active";
}
```

Implement `addStatus`, `subtractStatus`, and `readStoredChildStatus` in the same file with explicit `switch` branches for the four status values.

- [ ] **Step 5: Pass aggregation mode from chat runtime**

In `cli/runtime/KestrelChatRuntime.ts`, change `onTaskUpdate` so it passes:

```ts
parentTaskId: readParentTaskIdFromDelegationTask(update.task),
aggregateOnParentTask: true,
```

Add helper:

```ts
function readParentTaskIdFromDelegationTask(task: DelegationTaskSnapshot): string | undefined {
  const policy = task.policy;
  return typeof policy?.parentTaskId === "string" ? policy.parentTaskId : undefined;
}
```

Add `parentTaskId?: string` to `DelegationTaskSnapshot` in `tools/contracts.ts` and populate it from the delegation record policy in `toTaskSnapshot()`:

```ts
const parentTaskId = typeof record.policy?.parentTaskId === "string"
  ? record.policy.parentTaskId
  : undefined;
```

Then include:

```ts
...(parentTaskId !== undefined ? { parentTaskId } : {}),
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
node --import tsx --test tests/taskGraphStore.test.ts
```

Expected: passes.

Commit:

```bash
git add src/taskGraph/contracts.ts src/taskGraph/state.ts src/taskGraph/store.ts cli/runtime/KestrelChatRuntime.ts tools/contracts.ts src/orchestration/DelegationSupervisor.ts tests/taskGraphStore.test.ts
git commit -m "feat(runtime): aggregate subagent task activity"
```

## Task 6: Keep Source Mutations Behind Managed Worktree Fan-In

**Files:**
- Modify: `src/orchestration/DelegationSupervisor.ts`
- Modify: `src/orchestration/ThreadRuntime.ts`
- Test: `tests/unit/runtime-state-machine-hardening.test.ts`
- Test: `tests/unit/orchestration-thread-runtime.test.ts`

- [ ] **Step 1: Write test proving child write work carries managed worktree metadata**

Add a focused test to `tests/unit/orchestration-thread-runtime.test.ts`:

```ts
test("child delegation policy preserves parent task and managed worktree fan-in context", async () => {
  const sessionStore = new InMemorySessionStore();
  const executor = new QueueTurnExecutor(sessionStore, [
    {
      output: buildOutput({
        runId: "run-child-write",
        status: "COMPLETED",
      }),
      finalizedPayload: {
        status: "completed",
        result: "Updated implementation in managed worktree.",
      },
    },
  ]);
  const runtime = new ThreadRuntime({
    sessionStore,
    executor,
    profile: buildProfile(),
  });

  await runtime.startThread({
    threadId: "thread-write-root",
    title: "Write root",
  });
  const handle = await runtime.spawnDelegation({
    parentThreadId: "thread-write-root",
    parentRunId: "run-write-root",
    title: "Patch implementation",
    prompt: "Patch implementation",
    launchedBy: "agent",
    policy: {
      parentTaskId: "task-active",
      sourceMutationFanIn: "manual",
    },
  });
  await tick();

  const delegation = await sessionStore.getDelegation(handle.delegationId);
  assert.equal((delegation?.policy as Record<string, unknown>)?.parentTaskId, "task-active");
  assert.equal((delegation?.policy as Record<string, unknown>)?.sourceMutationFanIn, "manual");
});
```

- [ ] **Step 2: Run test and verify it fails if policy metadata is dropped**

Run:

```bash
node --import tsx --test tests/unit/orchestration-thread-runtime.test.ts --test-name-pattern "managed worktree fan-in context"
```

Expected: passes only after Task 3 policy metadata is preserved.

- [ ] **Step 3: Ensure source mutation policy defaults to manual fan-in**

In `src/orchestration/DelegationSupervisor.ts`, when building `policy` for `agent.spawn`, include:

```ts
sourceMutationFanIn: "manual",
```

In `src/orchestration/contracts.ts`, document the field in `ChildThreadPolicy`:

```ts
  sourceMutationFanIn?: "manual" | undefined;
```

- [ ] **Step 4: Verify managed worktree tests still pass**

Run:

```bash
node --import tsx --test tests/unit/runtime-state-machine-hardening.test.ts --test-name-pattern "managed worktree|dev shell tools auto-provision|dev process tools auto-provision"
```

Expected: passes, proving existing managed worktree behavior remains intact.

- [ ] **Step 5: Commit**

Commit:

```bash
git add src/orchestration/contracts.ts src/orchestration/DelegationSupervisor.ts tests/unit/orchestration-thread-runtime.test.ts
git commit -m "feat(runtime): preserve subagent fan-in policy"
```

## Task 7: Lightweight Web/Desktop/TUI Projections

**Files:**
- Modify: `cli/runtime/operatorAffordances.ts`
- Modify: `cli/ink/views/SessionsView.tsx`
- Modify: `apps/web/app/_components/ChatPageClient.tsx`
- Modify: `apps/web/app/_components/AiSdkActivityFeed.tsx`
- Test: `tests/unit/cli-operator-affordances.test.ts`
- Test: `tests/unit/cli-app-commands.test.ts`
- Test: `apps/web/tests/thread-presentation.test.ts`

- [ ] **Step 1: Write focused projection tests**

In `tests/unit/cli-operator-affordances.test.ts`, update the existing `formatOperatorAffordance includes focused thread, blocker, and next action parity fields` assertions from delegation-heavy copy to child-agent copy:

```ts
  assert.match(rendered, /Child blocker: thread-grandchild via delegation-1/u);
  assert.match(rendered, /Child agents: total=3 active=1 waiting=1 completed=2 failed=0 cancelled=1/u);
  assert.match(rendered, /Superseded child agents: thread-superseded/u);
  assert.match(rendered, /Child agent: thread-completed status=COMPLETED delegation=COMPLETED outcome="Collected evidence."/u);
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --import tsx --test tests/unit/cli-operator-affordances.test.ts
```

Expected: fails because the current copy still says delegation-first language.

- [ ] **Step 3: Update user-facing labels only**

Change product-facing labels from heavy “Delegation Review” language to lightweight child-agent language where the normal UX appears:

```ts
"Child agents"
"Child agent blocked"
"Child result ready"
"Open child thread"
```

Do not rename persisted `delegation.*` event types or storage fields in this task.

- [ ] **Step 4: Keep ops/debug labels detailed**

Leave ops/replay labels such as `delegationId`, `delegation.waiting`, and fan-in debug output intact in:

- `cli/runtime/inspectionFormatting.ts`
- `apps/web/app/_components/OpsRunDetailClient.tsx`
- `apps/web/app/_components/OpsSessionDetailClient.tsx`

The implementation should make normal shell UX lighter without reducing diagnostic evidence.

- [ ] **Step 5: Run projection tests and commit**

Run:

```bash
node --import tsx --test tests/unit/cli-operator-affordances.test.ts tests/unit/cli-app-commands.test.ts
pnpm --filter @kestrel/web test -- thread-presentation
```

Expected: passes.

Commit:

```bash
git add cli/runtime/operatorAffordances.ts cli/ink/views/SessionsView.tsx apps/web/app/_components/ChatPageClient.tsx apps/web/app/_components/AiSdkActivityFeed.tsx tests/unit/cli-operator-affordances.test.ts tests/unit/cli-app-commands.test.ts apps/web/tests/thread-presentation.test.ts
git commit -m "feat(ui): show lightweight subagent activity"
```

## Task 8: End-To-End Prompt And Runtime Validation

**Files:**
- Test: `tests/unit/unified-tool-registry.test.ts`
- Test: `tests/unit/orchestration-thread-runtime.test.ts`
- Test: `tests/taskGraphStore.test.ts`
- Test: `tests/unit/runtime-state-machine-hardening.test.ts`

- [ ] **Step 1: Run targeted runtime tests**

Run:

```bash
node --import tsx --test tests/unit/unified-tool-registry.test.ts tests/unit/orchestration-thread-runtime.test.ts tests/taskGraphStore.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run managed worktree regression slice**

Run:

```bash
node --import tsx --test tests/unit/runtime-state-machine-hardening.test.ts --test-name-pattern "managed worktree|dev shell tools auto-provision|dev process tools auto-provision"
```

Expected: all selected tests pass.

- [ ] **Step 3: Run prompt and governance gates**

Run:

```bash
pnpm run governance:check
pnpm run prompt-suite
```

Expected: both commands exit 0. If `prompt-suite` exits 0 while reporting known internal failures, record the reported failures in the commit message body and do not hide them.

- [ ] **Step 4: Run full test and evaluation gates**

Run:

```bash
pnpm run test
pnpm run evals:release-check
```

Expected: both pass.

- [ ] **Step 5: Final review and commit**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Dirty files should be either intentional sub-agent implementation files or pre-existing unrelated TUI work that remains unstaged.

If validation-only adjustments changed tests, commit them:

```bash
git add tests/unit/unified-tool-registry.test.ts tests/unit/orchestration-thread-runtime.test.ts tests/taskGraphStore.test.ts tests/unit/runtime-state-machine-hardening.test.ts
git commit -m "test(runtime): validate subagent execution"
```

If no code changed in this task, do not create an empty commit.
