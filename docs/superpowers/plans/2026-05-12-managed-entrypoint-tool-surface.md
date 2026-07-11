---
id: plan-managed-entrypoint-tool-surface-2026-05-12
domain: runtime
status: draft
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on: [../../PLANS.md]
---

# Managed Entrypoint Tool Surface Implementation Plan

See also: [Docs index](../../index.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Terminal-Bench managed-entrypoint artifact tasks from burning ReAct turns on one transport operation at a time.

**Architecture:** Keep `dev.process.*` as real runtime tools, but hide raw start/write/read from deliberator when the active task has adapter-provided managed entrypoints and a required artifact contract. The normal model-facing path becomes a bounded `dev.shell.run` controller/checker that uses `kestrel_devshell.start(..., cwd=...)` internally and emits a completion packet; `dev.process.stop` remains available only for live-process cleanup.

**Tech Stack:** TypeScript reference-react runtime, existing `ContextBuilder`, `workItemTools`, model input boundary, Node unit tests.

---

## File Structure

- Modify `agents/reference-react/src/workItemTools.ts`
  - Add managed-entrypoint-aware tool filtering.
  - Hide `dev.process.start`, `dev.process.write`, and `dev.process.read` for managed-entrypoint artifact work.
  - Preserve `dev.process.stop` when a live process exists.

- Modify `agents/reference-react/src/steps/deliberator.ts`
  - Pass managed entrypoint facts from `DecisionContext` into `filterDeliberatorToolsForWorkItem(...)`.
  - Keep existing compile policy unchanged.

- Modify `agents/reference-react/src/context/ContextBuilder.ts`
  - Stop rendering raw process continuation guidance as the default strategy when managed-entrypoint artifact work should use a bounded controller.
  - Render one compact line that says raw process tools are hidden for normal artifact work and controller/checker execution should use `dev.shell.run`.

- Modify `agents/reference-react/src/modelInputBoundary.ts`
  - Ensure compact goal/context still names the managed entrypoint and canonical `kestrel_devshell.start(..., cwd=...)` controller pattern.
  - Do not add new schema fields.

- Test `tests/unit/context-builder-budget.test.ts`
  - Assert context no longer tells the model to use `dev.process.write/read/stop` as default continuation for managed-entrypoint artifact work.

- Test `tests/unit/planner-tool-intent.test.ts`
  - Assert deliberator tool availability hides raw process start/write/read in the managed-entrypoint artifact case.

- Test `tests/unit/react-boundary-journey.test.ts`
  - Add a run-shaped regression proving the previous start/write/read/stop loop is not model-facing after a managed entrypoint and artifact contract are known.

- Test `tests/unit/reference-react-prompt-rules.test.ts`
  - Assert prompts still explain that controllers should use `kestrel_devshell.start(..., cwd=...)`, not direct process transport.

---

### Task 1: Add Managed-Entrypoint Tool Filtering

**Files:**
- Modify: `agents/reference-react/src/workItemTools.ts`
- Test: `tests/unit/planner-tool-intent.test.ts`

- [ ] **Step 1: Write failing tool-filter tests**

Add tests in `tests/unit/planner-tool-intent.test.ts` near existing work-item tool filtering coverage:

```ts
test("managed-entrypoint artifact work hides raw process start write and read", () => {
  const tools = [
    { name: "dev.shell.run", description: "", inputSchema: { type: "object" } },
    { name: "dev.process.start", description: "", inputSchema: { type: "object" } },
    { name: "dev.process.write", description: "", inputSchema: { type: "object" } },
    { name: "dev.process.read", description: "", inputSchema: { type: "object" } },
    { name: "dev.process.stop", description: "", inputSchema: { type: "object" } },
    { name: "fs.write_text", description: "", inputSchema: { type: "object" } },
  ];
  const result = filterDeliberatorToolsForWorkItem(
    tools,
    {
      version: "v1",
      phase: "gather_evidence",
      objective: "Gather facts and produce /app/output.",
      sourceTruthGoal: {
        target: "Source facts needed for /app/output",
        requirements: [],
        completionCriteria: "facts are known",
        preferredEvidenceArtifact: "/app/output",
      },
    },
    {
      managedEntrypoints: [{
        path: "/app/maze_game.sh",
        command: "./maze_game.sh",
        cwd: "/app",
        securityMode: "protected_entrypoint",
        requiredTransport: "kestrel_devshell.start",
      }],
      artifactTarget: "/app/output",
    },
  );

  expect(result.availability.allowedToolNames).toContain("dev.shell.run");
  expect(result.availability.allowedToolNames).toContain("fs.write_text");
  expect(result.availability.allowedToolNames).not.toContain("dev.process.start");
  expect(result.availability.allowedToolNames).not.toContain("dev.process.write");
  expect(result.availability.allowedToolNames).not.toContain("dev.process.read");
  expect(result.availability.allowedToolNames).not.toContain("dev.process.stop");
  expect(result.availability.hiddenTools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["dev.process.start", "dev.process.write", "dev.process.read"]),
  );
});

test("managed-entrypoint artifact work keeps stop available for live cleanup", () => {
  const tools = [
    { name: "dev.process.start", description: "", inputSchema: { type: "object" } },
    { name: "dev.process.write", description: "", inputSchema: { type: "object" } },
    { name: "dev.process.read", description: "", inputSchema: { type: "object" } },
    { name: "dev.process.stop", description: "", inputSchema: { type: "object" } },
    { name: "dev.shell.run", description: "", inputSchema: { type: "object" } },
  ];
  const result = filterDeliberatorToolsForWorkItem(
    tools,
    {
      version: "v1",
      phase: "gather_evidence",
      objective: "Gather facts and produce /app/output.",
      sourceTruthGoal: {
        target: "Source facts needed for /app/output",
        requirements: [],
        completionCriteria: "facts are known",
        preferredEvidenceArtifact: "/app/output",
      },
    },
    {
      managedEntrypoints: [{
        path: "/app/maze_game.sh",
        command: "./maze_game.sh",
        cwd: "/app",
        securityMode: "protected_entrypoint",
        requiredTransport: "kestrel_devshell.start",
      }],
      artifactTarget: "/app/output",
      devShellProcesses: [{ processId: "proc-1", command: "./maze_game.sh", cwd: "/app", status: "RUNNING", live: true }],
    },
  );

  expect(result.availability.allowedToolNames).toContain("dev.process.stop");
  expect(result.availability.allowedToolNames).not.toContain("dev.process.start");
  expect(result.availability.allowedToolNames).not.toContain("dev.process.write");
  expect(result.availability.allowedToolNames).not.toContain("dev.process.read");
});
```

- [ ] **Step 2: Run the focused failing tests**

Run:

```bash
node --import tsx --test tests/unit/planner-tool-intent.test.ts
```

Expected: FAIL because `WorkItemToolFilterContext` does not accept `managedEntrypoints` or `artifactTarget`, and raw process tools remain visible.

- [ ] **Step 3: Extend the filter context type**

In `agents/reference-react/src/workItemTools.ts`, add local managed-entrypoint types and context fields:

```ts
export interface ManagedEntrypointToolContext {
  path: string;
  command: string;
  cwd: string;
  securityMode: "protected_entrypoint";
  requiredTransport: "kestrel_devshell.start" | "dev.process.start";
}

export interface WorkItemToolFilterContext {
  devShellProcesses?: Record<string, unknown>[] | undefined;
  availableToolNames?: string[] | undefined;
  latestToolEvidence?: LatestToolEvidence | undefined;
  postToolVerification?: Record<string, unknown> | undefined;
  managedEntrypoints?: ManagedEntrypointToolContext[] | undefined;
  artifactTarget?: string | undefined;
}
```

- [ ] **Step 4: Implement managed-entrypoint artifact filtering**

In `readHiddenToolForWorkItem(...)`, before the existing `gather_evidence` logic, add:

```ts
  const managedArtifactHidden = readHiddenManagedEntrypointArtifactTool(toolName, workItem, context);
  if (managedArtifactHidden !== undefined) {
    return managedArtifactHidden;
  }
```

Add this helper in the same file:

```ts
function readHiddenManagedEntrypointArtifactTool(
  toolName: string,
  workItem: ReactWorkItem,
  context: WorkItemToolFilterContext,
): HiddenWorkItemTool | undefined {
  if (managedEntrypointArtifactMode(workItem, context) === false) {
    return undefined;
  }
  if (toolName !== "dev.process.start" && toolName !== "dev.process.write" && toolName !== "dev.process.read") {
    return undefined;
  }
  return {
    name: toolName,
    reason:
      "Managed-entrypoint artifact work should not spend deliberator turns on raw process transport primitives.",
    correction:
      "Use dev.shell.run to run a bounded controller or checker that uses kestrel_devshell.start(..., cwd=...) internally, writes or verifies the required artifact, and prints a completion attempt packet. Use dev.process.stop only to clean up an already-live process.",
  };
}

function managedEntrypointArtifactMode(
  workItem: ReactWorkItem,
  context: WorkItemToolFilterContext,
): boolean {
  if (workItem.phase !== "gather_evidence" && workItem.phase !== "derive_artifact") {
    return false;
  }
  if ((context.managedEntrypoints ?? []).length === 0) {
    return false;
  }
  const target = context.artifactTarget?.trim() || readWorkItemArtifactTarget(workItem)?.trim();
  return target !== undefined && target.length > 0;
}

function readWorkItemArtifactTarget(workItem: ReactWorkItem): string | undefined {
  if ("artifact" in workItem) {
    return workItem.artifact.target;
  }
  if ("sourceTruthGoal" in workItem) {
    return workItem.sourceTruthGoal.preferredEvidenceArtifact;
  }
  return undefined;
}
```

- [ ] **Step 5: Run tool-filter tests**

Run:

```bash
node --import tsx --test tests/unit/planner-tool-intent.test.ts
```

Expected: PASS.

---

### Task 2: Pass Managed Entrypoints Into Deliberator Tool Filtering

**Files:**
- Modify: `agents/reference-react/src/steps/deliberator.ts`
- Test: `tests/unit/planner-tool-intent.test.ts`

- [ ] **Step 1: Add a deliberator regression test**

Add a test in `tests/unit/planner-tool-intent.test.ts` that builds a mocked deliberator input with `managedEntrypoints` in the decision context and asserts `availableTools` excludes raw process tools.

Use the existing test harness in that file. The assertion should inspect the captured model input:

```ts
expect(capturedInput.availableTools.map((tool) => tool.name)).toContain("dev.shell.run");
expect(capturedInput.availableTools.map((tool) => tool.name)).not.toContain("dev.process.start");
expect(capturedInput.availableTools.map((tool) => tool.name)).not.toContain("dev.process.write");
expect(capturedInput.availableTools.map((tool) => tool.name)).not.toContain("dev.process.read");
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
node --import tsx --test tests/unit/planner-tool-intent.test.ts
```

Expected: FAIL because `createDeliberatorStep(...)` does not pass `managedEntrypoints` or artifact target into `filterDeliberatorToolsForWorkItem(...)`.

- [ ] **Step 3: Pass context facts to the tool filter**

In `agents/reference-react/src/steps/deliberator.ts`, update both calls to `filterDeliberatorToolsForWorkItem(...)` so the context object includes:

```ts
managedEntrypoints: decisionContext.managedEntrypoints,
artifactTarget: decisionContext.taskArtifactContract?.path,
```

Apply this to:
- the initial `initialFilteredTools` call;
- the retry `retryTools` call.

- [ ] **Step 4: Run the focused test**

Run:

```bash
node --import tsx --test tests/unit/planner-tool-intent.test.ts
```

Expected: PASS.

---

### Task 3: Stop Rendering Raw Process Continuation as the Default Strategy

**Files:**
- Modify: `agents/reference-react/src/context/ContextBuilder.ts`
- Test: `tests/unit/context-builder-budget.test.ts`

- [ ] **Step 1: Write failing context test**

Add a test in `tests/unit/context-builder-budget.test.ts` with:
- managed entrypoint `/app/maze_game.sh`;
- artifact contract `/app/output`;
- live process fact for `./maze_game.sh`;
- work item phase `gather_evidence`.

Assert:

```ts
expect(currentSituation).toContain("Managed-entrypoint artifact work should use a bounded controller/checker");
expect(currentSituation).toContain("kestrel_devshell.start");
expect(currentSituation).not.toContain("valid next operations: dev.process.write, dev.process.read, or dev.process.stop");
```

- [ ] **Step 2: Run the failing context test**

Run:

```bash
node --import tsx --test tests/unit/context-builder-budget.test.ts
```

Expected: FAIL because `describeLiveProcessOperations(...)` currently renders raw process continuation operations.

- [ ] **Step 3: Add managed-entrypoint artifact context detection**

In `agents/reference-react/src/context/ContextBuilder.ts`, add a helper near `describeLiveProcessContinuation(...)`:

```ts
function shouldPreferManagedEntrypointController(input: {
  managedEntrypoints: readonly ManagedEntrypointContext[];
  workItem?: ReactWorkItem | undefined;
}): boolean {
  if (input.managedEntrypoints.length === 0) {
    return false;
  }
  const phase = input.workItem?.phase;
  if (phase !== "gather_evidence" && phase !== "derive_artifact") {
    return false;
  }
  if (input.workItem === undefined) {
    return false;
  }
  if ("artifact" in input.workItem && input.workItem.artifact.target.trim().length > 0) {
    return true;
  }
  if ("sourceTruthGoal" in input.workItem && input.workItem.sourceTruthGoal.preferredEvidenceArtifact !== undefined) {
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Replace live-process operation wording for this mode**

Update the call path that renders live-process continuation so it can see `managedEntrypoints`. When `shouldPreferManagedEntrypointController(...)` is true, render:

```ts
return `Process${processText} is still running${commandText}. Managed-entrypoint artifact work should use a bounded controller/checker through dev.shell.run; that controller should drive the entrypoint with kestrel_devshell.start(..., cwd=...), write or verify the required artifact, and print a completion attempt packet. Use dev.process.stop only if this live process must be cleaned up before running the controller.`;
```

Do not change raw process guidance for non-managed-entrypoint work.

- [ ] **Step 5: Run focused context tests**

Run:

```bash
node --import tsx --test tests/unit/context-builder-budget.test.ts
```

Expected: PASS.

---

### Task 4: Preserve Compact Goal Guidance Without Increasing Context Size

**Files:**
- Modify: `agents/reference-react/src/modelInputBoundary.ts`
- Test: `tests/unit/model-input-boundary.test.ts`

- [ ] **Step 1: Write compact-goal regression**

Add a test in `tests/unit/model-input-boundary.test.ts` asserting that iterative deliberator/observer goal text for a managed-entrypoint task contains:

```ts
expect(goal).toContain("Managed task entrypoint");
expect(goal).toContain("kestrel_devshell.start");
expect(goal).toContain("/app/output");
expect(goal.length).toBeLessThanOrEqual(1200);
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
node --import tsx --test tests/unit/model-input-boundary.test.ts
```

Expected: PASS if existing compact goal already satisfies this; otherwise FAIL with missing artifact target or oversized goal.

- [ ] **Step 3: If needed, tighten compact goal synthesis**

If the test fails, update `readCompactGoal(...)` in `agents/reference-react/src/modelInputBoundary.ts` so the managed-entrypoint branch emits one bounded sentence:

```ts
return [
  `Managed task entrypoint(s): ${entrypointCommands.join(", ")}; drive them through kestrel_devshell.start(..., cwd=...) inside bounded controllers, not raw transport turns.`,
  artifactTarget !== undefined ? `Required artifact: ${artifactTarget}.` : undefined,
  protocolSnippets.length > 0 ? `Protocol facts: ${protocolSnippets.slice(0, 4).join("; ")}.` : undefined,
].filter((part): part is string => part !== undefined).join(" ");
```

Keep the output bounded with the existing clamp helper in that file.

- [ ] **Step 4: Run model-input tests**

Run:

```bash
node --import tsx --test tests/unit/model-input-boundary.test.ts
```

Expected: PASS.

---

### Task 5: Add Journey Regression for the Previous Micro-Turn Loop

**Files:**
- Modify: `tests/unit/react-boundary-journey.test.ts`

- [ ] **Step 1: Write journey test**

Add a mocked-model journey that starts from:
- Terminal-Bench-like event metadata with `managedEntrypoints`;
- artifact contract `/app/output` with required children;
- model tools including `dev.process.start`, `dev.process.write`, `dev.process.read`, `dev.process.stop`, and `dev.shell.run`.

Assert the deliberator model input excludes:

```ts
expect(toolNames).not.toContain("dev.process.start");
expect(toolNames).not.toContain("dev.process.write");
expect(toolNames).not.toContain("dev.process.read");
expect(toolNames).toContain("dev.shell.run");
```

Then return a mocked deliberator action:

```json
{
  "phase": "gather_evidence",
  "nextAction": {
    "kind": "tool",
    "name": "dev.shell.run",
    "input": {
      "workspaceRoot": "/app",
      "cwd": "/app",
      "command": "python3 /app/maze_controller.py",
      "timeoutMs": 60000
    }
  },
  "reason": "Run the durable controller as one bounded work unit so it can drive the managed entrypoint internally and report artifact progress."
}
```

Assert compile accepts the action and routes to `react.exec.dispatch`.

- [ ] **Step 2: Run the journey test**

Run:

```bash
node --import tsx --test tests/unit/react-boundary-journey.test.ts
```

Expected: PASS after Tasks 1 and 2.

---

### Task 6: Revalidate Prompt Contract

**Files:**
- Test: `tests/unit/reference-react-prompt-rules.test.ts`

- [ ] **Step 1: Add prompt assertion**

Add an assertion that the permanent prompt still says:

```ts
expect(prompt).toContain("kestrel_devshell.start");
expect(prompt).toContain("dev.shell.run");
expect(prompt).toContain("bounded");
```

And does not reintroduce old names:

```ts
expect(prompt).not.toContain("dev.shell.exec");
expect(prompt).not.toContain("write_stdin");
expect(prompt).not.toContain("tbench_devshell");
```

- [ ] **Step 2: Run prompt tests**

Run:

```bash
node --import tsx --test tests/unit/reference-react-prompt-rules.test.ts
```

Expected: PASS.

---

### Task 7: Run Focused Validation

**Files:**
- No source changes unless validation reveals a bug in this slice.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --import tsx --test tests/unit/planner-tool-intent.test.ts tests/unit/context-builder-budget.test.ts tests/unit/model-input-boundary.test.ts tests/unit/react-boundary-journey.test.ts tests/unit/reference-react-prompt-rules.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run prompt suite**

Run:

```bash
pnpm run prompt-suite
```

Expected: PASS.

- [ ] **Step 4: Run evaluations**

Run:

```bash
pnpm run evals:release-check
```

Expected: PASS.

---

### Task 8: Probe the Behavior

**Files:**
- No source changes unless the probe exposes a new bug.

- [ ] **Step 1: Run the focused Terminal-Bench probe**

Run:

```bash
pnpm run bench:terminal -- cli --task-id blind-maze-explorer-algorithm
```

Expected acceptance for this slice:
- The first model-facing deliberator context does not expose `dev.process.start/write/read` as ordinary available tools for the managed-entrypoint artifact task.
- The run does not begin with the old start/write/read/stop ReAct micro-loop.
- A failure is acceptable if it is now controller algorithm quality, artifact verification, or clean blocked closeout.

- [ ] **Step 2: Inspect the probe timeline**

Run:

```bash
rg -n "decision_compiled|dev.process.start|dev.process.write|dev.process.read|dev.shell.run|RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED" runs/<run-id>/blind-maze-explorer-algorithm
```

Expected:
- No early sequence of separate deliberator decisions for `dev.process.start`, `dev.process.write`, `dev.process.read`, `dev.process.stop`.
- The first substantial action should be `dev.shell.run` or file creation/patching toward a durable controller/checker.

---

## Non-Goals

- Do not add a new phase.
- Do not add retry caps.
- Do not add a maze solver.
- Do not parse arbitrary stdout as correctness.
- Do not relax the protected sandbox.
- Do not remove `dev.process.*` from the runtime or non-managed workflows.
- Do not block `dev.process.stop` when a live process needs cleanup.

## Self-Review

- Spec coverage: The plan addresses the validated root cause: low-level process primitives are model-facing and context-endorsed during managed-entrypoint artifact work.
- Placeholder scan: No task uses TBD/TODO/fill-in wording.
- Type consistency: The new context fields are `managedEntrypoints` and `artifactTarget`; helper names are consistent across tasks.
