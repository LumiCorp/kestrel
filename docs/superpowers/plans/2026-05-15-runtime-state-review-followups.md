---
id: plan-runtime-state-review-followups-2026-05-15
domain: runtime
status: draft
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on: [../../PLANS.md]
---

# Runtime State Review Followups Implementation Plan

See also: [Docs index](../../index.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two concrete review findings from the runtime-state, compaction, resume, and repair slice before staging the implementation for commit.

**Architecture:** Keep this as a follow-up hardening slice, not a policy change. Preserve the runtime-state/compaction boundary, add missing test coverage first, and keep diagnostics compact and redacted.

**Tech Stack:** TypeScript, Node test runner via `pnpm exec tsx --test`, Kestrel runtime session store contracts, in-memory and Postgres session stores.

---

## Review Findings

1. [P1] `buildDeterministicStructuredContextSummary()` ignores `finalizedPayload.summary`, so summary-only finalized payloads no longer feed the compaction summary text. This changes compaction artifact content even though the slice was supposed to avoid compaction behavior changes.
2. [P2] `runtime.state_persisted` diagnostics report `stepAgent` as `nextStepAgent` because `CommitStepInput` has no executing-step field. The event is still redacted and useful, but it cannot accurately show the step that committed the version.

## File Map

- Modify: `src/runtime/contextPacket.ts` to preserve summary-only finalized payloads in deterministic context summaries.
- Modify: `tests/unit/context-packet.test.ts` to lock summary-field behavior.
- Modify: `src/kestrel/contracts.ts` to add optional `stepAgent?: string` to `CommitStepInput`.
- Modify: `src/engine/ExecutionEngine.ts` to pass the executing `stepName` into each `commitStep()` call made from the step loop.
- Modify: `src/store/PostgresSessionStore.ts` and `tests/helpers/InMemorySessionStore.ts` to use `input.stepAgent` for diagnostics while preserving existing `nextStepAgent` persistence semantics.
- Modify: `tests/unit/runtime-state-observability.test.ts` to assert distinct `stepAgent` and `nextStepAgent`.
- Modify generated desktop runtime resources only if `pnpm run governance:check` reports stale desktop resources after source changes.

---

### Task 1: Preserve Summary-Only Compaction Payloads

**Files:**
- Modify: `src/runtime/contextPacket.ts:96-100`
- Modify: `tests/unit/context-packet.test.ts`

- [ ] **Step 1: Add the failing summary-field test**

Add this test to `tests/unit/context-packet.test.ts`:

```ts
test("deterministic structured context summary preserves finalized summary text", () => {
  const summary = buildDeterministicStructuredContextSummary({
    threadId: "thread-summary",
    runId: "run-summary",
    createdAt: "2026-05-15T12:00:00.000Z",
    result: {
      output: {
        status: "COMPLETED",
        runId: "run-summary",
      },
      finalizedPayload: {
        summary: "Compacted result from summary field",
      },
    },
  });

  assert.deepEqual(summary.completedWork, ["Compacted result from summary field"]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm exec tsx --test tests/unit/context-packet.test.ts
```

Expected: FAIL because `completedWork` falls back to `Run completed with status COMPLETED.`

- [ ] **Step 3: Add `summary` to deterministic message extraction**

Change the `message` chain in `src/runtime/contextPacket.ts` to:

```ts
  const message =
    readOptionalString(finalizedRecord?.message) ??
    readOptionalString(finalizedRecord?.summary) ??
    readOptionalString(finalizedRecord?.text) ??
    readOptionalString(payloadData?.message) ??
    readOptionalString(payloadData?.summary) ??
    readOptionalString(payloadData?.text);
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm exec tsx --test tests/unit/context-packet.test.ts
```

Expected: PASS.

---

### Task 2: Make Runtime State Diagnostics Report the Executing Step

**Files:**
- Modify: `src/kestrel/contracts.ts:1012-1028`
- Modify: `src/engine/ExecutionEngine.ts`
- Modify: `src/store/PostgresSessionStore.ts:486-496,555-565`
- Modify: `tests/helpers/InMemorySessionStore.ts`
- Modify: `tests/unit/runtime-state-observability.test.ts`

- [ ] **Step 1: Add the failing observability assertion**

Update the successful diagnostic test in `tests/unit/runtime-state-observability.test.ts` so the commit input includes both fields:

```ts
    stepAgent: "agent.loop",
    nextStepAgent: "agent.exec.dispatch",
```

Then assert both values:

```ts
  assert.equal(diagnostic?.metadata?.stepAgent, "agent.loop");
  assert.equal(diagnostic?.metadata?.nextStepAgent, "agent.exec.dispatch");
```

- [ ] **Step 2: Run the focused observability test and verify it fails**

Run:

```bash
pnpm exec tsx --test tests/unit/runtime-state-observability.test.ts
```

Expected: FAIL because `CommitStepInput` does not accept `stepAgent` yet and diagnostics currently mirror `nextStepAgent`.

- [ ] **Step 3: Add `stepAgent` to the commit contract**

In `src/kestrel/contracts.ts`, update `CommitStepInput`:

```ts
export interface CommitStepInput {
  runId: string;
  event: RuntimeEvent;
  sessionId: string;
  expectedVersion: number;
  stepAgent?: string | undefined;
  nextStepAgent?: string | undefined;
  statePatch?: Record<string, unknown> | undefined;
  effects: ResolvedEffect[];
  emitEvents: RuntimeEventIntent[];
  runLogs?: RunLogEntry[] | undefined;
  runEvents?: RunEvent[] | undefined;
  stateNode?: StateNodeRef | undefined;
  artifacts?: ArtifactIntent[] | undefined;
  claims?: ClaimIntent[] | undefined;
  memory?: MemorySnapshot | undefined;
  budget?: BudgetSnapshot | undefined;
  stepIndex: number;
}
```

- [ ] **Step 4: Pass `stepName` from the main execution loop**

In the main `ExecutionEngine` step-loop `commitStep()` call, add:

```ts
          stepAgent: stepName,
```

Keep `nextStepAgent: transition.nextStepAgent` unchanged. For direct internal commits that do not have a local executing-step variable, omit `stepAgent` and keep current behavior.

- [ ] **Step 5: Use `stepAgent` in commit diagnostics**

In `src/store/PostgresSessionStore.ts`, update both diagnostic calls:

```ts
            stepAgent: input.stepAgent ?? undefined,
            nextStepAgent: input.nextStepAgent ?? undefined,
```

and:

```ts
          stepAgent: input.stepAgent ?? undefined,
          nextStepAgent: input.nextStepAgent ?? undefined,
```

Make the same replacement in `tests/helpers/InMemorySessionStore.ts`.

- [ ] **Step 6: Run the focused observability test and verify it passes**

Run:

```bash
pnpm exec tsx --test tests/unit/runtime-state-observability.test.ts
```

Expected: PASS.

---

### Task 3: Re-Run Runtime-State Slice Tests and Governance

**Files:**
- Test-only verification across the runtime-state and compaction slice.

- [ ] **Step 1: Run targeted runtime-state tests**

Run:

```bash
pnpm exec tsx --test tests/unit/context-packet.test.ts tests/unit/runtime-state-observability.test.ts tests/unit/orchestration-thread-runtime.test.ts tests/unit/runtime-state-machine-hardening.test.ts tests/unit/corrupted-next-action-inspection.test.ts tests/unit/cli-runtime-inspection-formatters.test.ts tests/unit/run-replay-service.test.ts tests/integration/postgres-session-store.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run governance**

Run:

```bash
pnpm run governance:check
```

Expected: PASS. If it fails only because desktop resources are stale, run:

```bash
pnpm --filter @kestrel/desktop prepare:resources
```

Then run `pnpm run governance:check` again and expect PASS.

- [ ] **Step 3: Run the required gates before commit staging**

Run:

```bash
pnpm run test
pnpm run prompt-suite
pnpm run evals:release-check
```

Expected: all commands exit 0.

- [ ] **Step 4: Stage only the reviewed follow-up files**

Run:

```bash
git add src/runtime/contextPacket.ts tests/unit/context-packet.test.ts src/kestrel/contracts.ts src/engine/ExecutionEngine.ts src/store/PostgresSessionStore.ts tests/helpers/InMemorySessionStore.ts tests/unit/runtime-state-observability.test.ts
git diff --cached --name-only
```

Expected staged list:

```text
src/engine/ExecutionEngine.ts
src/kestrel/contracts.ts
src/runtime/contextPacket.ts
src/store/PostgresSessionStore.ts
tests/helpers/InMemorySessionStore.ts
tests/unit/context-packet.test.ts
tests/unit/runtime-state-observability.test.ts
```

If desktop resource regeneration was required by governance, add only the corresponding generated files under `apps/desktop/resources/kestrel-repo/` that mirror this source-file set.
