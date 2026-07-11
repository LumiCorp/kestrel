---
id: plan-dev-shell-source-write-guard-persistence-2026-05-16
domain: runtime
status: draft
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on: [../../PLANS.md]
---

# Dev Shell Source-Write Guard Persistence Implementation Plan

See also: [Docs index](../../index.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist dev-shell source-write guard outcomes across process-store boundaries and make restart recovery explicit when a guarded live process is lost before final source-write enforcement.

**Architecture:** Keep enforcement deterministic and contract-driven. Store guard result JSON on `dev_shell_processes`, deep-clone it in memory, and add an explicit final-check marker so consumers can distinguish "guard configured/latest check clean" from "final source restoration completed." Do not reconstruct snapshots after restart and do not add heuristic path matching, retry caps, or policy inference.

**Tech Stack:** TypeScript, Node test runner, Postgres JSONB migration, existing `SqlExecutor`/`ScriptedSqlExecutor`, dev-shell supervisor/store contracts.

---

## Current Evidence

- `src/devshell/contracts.ts` already includes `sourceWriteGuard?: DevShellSourceWriteGuardResult` on `DevShellProcessRecord`.
- `src/devshell/InMemoryDevShellStore.ts` currently clones only readiness, requested tools, and env names; nested guard arrays are not deep-cloned.
- `src/devshell/PostgresDevShellStore.ts` does not insert, select, or map any `sourceWriteGuard` JSON.
- `db/migrations/018_dev_shell_processes.sql` has no source-write guard column.
- `src/devshell/DevShellSupervisor.ts` marks persisted `RUNNING` records as `LOST` on initialize without distinguishing guarded processes whose in-memory snapshot can no longer be enforced.

## File Map

- Modify `src/devshell/contracts.ts`
  - Add an optional deterministic guard-finalization field to `DevShellSourceWriteGuardResult`.
- Modify `src/devshell/DevShellSupervisor.ts`
  - Set the field when creating, enforcing, and recovering guarded process records.
- Modify `src/devshell/InMemoryDevShellStore.ts`
  - Deep-clone `sourceWriteGuard` and nested `unauthorizedSourceWrites`.
- Modify `src/devshell/PostgresDevShellStore.ts`
  - Persist and hydrate `sourceWriteGuard` through a new JSONB column.
- Create `db/migrations/021_dev_shell_source_write_guard_json.sql`
  - Add `source_write_guard_json jsonb`.
- Create `apps/desktop/resources/kestrel-repo/db/migrations/021_dev_shell_source_write_guard_json.sql`
  - Keep desktop bundled migrations aligned.
- Create `tests/unit/postgres-dev-shell-store.test.ts`
  - Cover JSON persistence with `ScriptedSqlExecutor`.
- Modify `tests/unit/dev-shell-supervisor.test.ts`
  - Cover restart recovery for guarded live processes.
- Add focused assertions to existing dev-shell tests where useful, without touching unrelated prompt/context files.

## Contract Choice

Add this optional field:

```ts
finalCheckCompleted?: boolean | undefined;
```

Semantics:

- `false`: guard exists, but the process is still running or was lost before final enforcement.
- `true`: process reached a terminal state and the source-write guard final check ran.
- omitted: legacy records before this contract field existed.

This is deliberately not a heuristic. It records lifecycle fact, not a guessed safety judgment.

## Task 1: Add Guard Finalization Contract And Supervisor Semantics

**Files:**
- Modify: `src/devshell/contracts.ts`
- Modify: `src/devshell/DevShellSupervisor.ts`
- Test: `tests/unit/dev-shell-supervisor.test.ts`

- [ ] **Step 1: Write the failing restart recovery test**

Add a test that starts a guarded process, creates a new supervisor over the same store/base directory, calls `initialize()`, and reads the stored process:

```ts
test("DevShellSupervisor marks lost guarded processes as not finally source-write checked", async () => {
  const { supervisor, workspaceRoot, baseDir, store } = await createSupervisor();
  let processId = "";
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "sleep 5",
      yieldTimeMs: 10,
      maxOutputBytes: 4096,
      sourceWriteGuard: { enabled: true },
    });
    assert.equal(started.status, "RUNNING");
    assert.equal(started.sourceWriteGuard?.finalCheckCompleted, false);
    processId = started.processId!;
  } finally {
    await supervisor.close();
  }

  const restarted = new DevShellSupervisor(store, baseDir);
  await restarted.initialize();
  try {
    const lost = await restarted.readProcess({ processId, waitMs: 0, maxBytes: 4096 });
    assert.equal(lost.status, "LOST");
    assert.match(lost.failureReason ?? "", /source-write guard final check did not run/u);
    assert.equal(lost.sourceWriteGuard?.finalCheckCompleted, false);
    assert.deepEqual(lost.sourceWriteGuard?.unauthorizedSourceWrites, []);
  } finally {
    await restarted.close();
  }
});
```

Expected before implementation: fails because `finalCheckCompleted` is absent and the failure reason is generic.

- [ ] **Step 2: Update the result contract**

In `DevShellSourceWriteGuardResult`, add:

```ts
finalCheckCompleted?: boolean | undefined;
```

- [ ] **Step 3: Set `finalCheckCompleted: false` on guarded process creation**

In the initial `sourceWriteGuard` record built in `startManagedProcess`, include:

```ts
finalCheckCompleted: false,
```

- [ ] **Step 4: Set finalization in enforcement**

In `enforceSourceWriteGuard`, compute:

```ts
const finalCheckCompleted = processStillRunning === false;
const finalizedResult = {
  ...result,
  finalCheckCompleted,
};
```

Use `finalizedResult` everywhere the method writes `sourceWriteGuard`. For unauthorized writes, the method kills or observes a terminal process, so set `finalCheckCompleted: true` before persisting the failed record.

- [ ] **Step 5: Preserve the signal during restart recovery**

In `initialize()`, when marking a `RUNNING` record as `LOST`, update guarded records with:

```ts
sourceWriteGuard: processRecord.sourceWriteGuard === undefined
  ? undefined
  : {
      ...processRecord.sourceWriteGuard,
      finalCheckCompleted: false,
    },
failureReason: processRecord.sourceWriteGuard === undefined
  ? "dev shell supervisor state was not available after restart"
  : "dev shell supervisor state was not available after restart; source-write guard final check did not run",
```

- [ ] **Step 6: Run the focused supervisor test**

Run:

```bash
node --import tsx --test tests/unit/dev-shell-supervisor.test.ts
```

Expected: pass.

## Task 2: Deep-Clone Guard Results In Memory

**Files:**
- Modify: `src/devshell/InMemoryDevShellStore.ts`
- Test: `tests/unit/dev-shell-supervisor.test.ts` or `tests/unit/dev-shell-store.test.ts`

- [ ] **Step 1: Write the failing clone test**

Add a small store test that upserts a record with a guard result, mutates the returned record, and verifies a later read is unchanged:

```ts
test("InMemoryDevShellStore deep clones source-write guard results", async () => {
  const store = new InMemoryDevShellStore();
  const now = new Date().toISOString();
  await store.upsertProcess({
    processId: "proc-1",
    command: "true",
    status: "FAILED",
    workspaceRoot: "/workspace",
    cwd: "/workspace",
    shellPath: "/bin/sh",
    idleTimeoutMs: 1000,
    maxReadBytes: 4096,
    readiness: {
      workspaceRootExists: true,
      cwdExists: true,
      cwdWithinWorkspace: true,
      shellResolved: true,
      tools: [],
      env: [],
    },
    requestedTools: [],
    envNames: [],
    transcriptPath: "/tmp/transcript.log",
    outputCursor: 0,
    submittedAt: now,
    startedAt: now,
    updatedAt: now,
    expiresAt: now,
    sourceWriteGuard: {
      enabled: true,
      mode: "source_readonly",
      sourceRoots: ["."],
      allowedWriteRoots: [],
      unauthorizedSourceWrites: [{ path: "app/page.tsx", kind: "modified", restored: true }],
      restored: true,
      finalCheckCompleted: true,
    },
  });

  const first = await store.getProcess("proc-1");
  first!.sourceWriteGuard!.unauthorizedSourceWrites[0]!.path = "mutated";
  const second = await store.getProcess("proc-1");
  assert.equal(second!.sourceWriteGuard!.unauthorizedSourceWrites[0]!.path, "app/page.tsx");
});
```

Expected before implementation: fails because nested guard arrays are shared.

- [ ] **Step 2: Implement a focused clone helper**

In `InMemoryDevShellStore.ts`, add:

```ts
function cloneSourceWriteGuard(
  guard: DevShellProcessRecord["sourceWriteGuard"],
): DevShellProcessRecord["sourceWriteGuard"] {
  if (guard === undefined) {
    return undefined;
  }
  return {
    ...guard,
    sourceRoots: [...guard.sourceRoots],
    allowedWriteRoots: [...guard.allowedWriteRoots],
    unauthorizedSourceWrites: guard.unauthorizedSourceWrites.map((write) => ({ ...write })),
    ...(guard.changedFiles !== undefined ? { changedFiles: [...guard.changedFiles] } : {}),
  };
}
```

Then include:

```ts
...(record.sourceWriteGuard !== undefined
  ? { sourceWriteGuard: cloneSourceWriteGuard(record.sourceWriteGuard) }
  : {}),
```

in `cloneProcess`.

- [ ] **Step 3: Run the clone test**

Run:

```bash
node --import tsx --test tests/unit/dev-shell-supervisor.test.ts
```

Expected: pass.

## Task 3: Persist Guard JSON In Postgres

**Files:**
- Create: `db/migrations/021_dev_shell_source_write_guard_json.sql`
- Create: `apps/desktop/resources/kestrel-repo/db/migrations/021_dev_shell_source_write_guard_json.sql`
- Modify: `src/devshell/PostgresDevShellStore.ts`
- Test: `tests/unit/postgres-dev-shell-store.test.ts`

- [ ] **Step 1: Add the migration**

Use this exact SQL in both migration locations:

```sql
DO $$
BEGIN
  IF to_regclass('public.dev_shell_processes') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'dev_shell_processes'
       AND column_name = 'source_write_guard_json'
  ) THEN
    ALTER TABLE public.dev_shell_processes
      ADD COLUMN source_write_guard_json jsonb;
  END IF;
END $$;
```

- [ ] **Step 2: Write the Postgres store tests**

Create `tests/unit/postgres-dev-shell-store.test.ts` with tests for:

- `upsertProcess` passes serialized guard JSON as a query value.
- `getProcess` maps `source_write_guard_json` back onto `record.sourceWriteGuard`.
- `listProcesses` maps `source_write_guard_json` for each row.

Use `ScriptedSqlExecutor` and a shared `buildDevShellProcessRow()` helper so the tests are deterministic and do not need a live database.

- [ ] **Step 3: Update insert/upsert SQL**

In `PostgresDevShellStore.upsertProcess`, add `source_write_guard_json` to the insert column list, values list, conflict update list, and query values:

```ts
JSON.stringify(record.sourceWriteGuard ?? null),
```

Cast the value as `$22::jsonb`.

- [ ] **Step 4: Update select SQL and row mapping**

In both `getProcess` and `listProcesses`, select `source_write_guard_json`.

In `DevShellProcessRow`, add:

```ts
source_write_guard_json: Record<string, unknown> | null;
```

In `mapProcessRow`, add:

```ts
...(row.source_write_guard_json !== null
  ? { sourceWriteGuard: row.source_write_guard_json as unknown as DevShellProcessRecord["sourceWriteGuard"] }
  : {}),
```

- [ ] **Step 5: Run the Postgres store test**

Run:

```bash
node --import tsx --test tests/unit/postgres-dev-shell-store.test.ts
```

Expected: pass.

## Task 4: Focused Validation And Commit

**Files:**
- All files from Tasks 1-3.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --import tsx --test tests/unit/dev-shell-supervisor.test.ts tests/unit/postgres-dev-shell-store.test.ts tests/unit/local-dev-shell-service.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run governance and broad gates**

Run:

```bash
pnpm run governance:check
pnpm run typecheck
pnpm run prompt-suite
pnpm run evals:release-check
pnpm run test
```

Expected: all pass. If any fail, separate dev-shell failures from unrelated dirty-tree failures before changing code.

- [ ] **Step 3: Stage only this slice**

Run:

```bash
git diff --check -- src/devshell/DevShellSupervisor.ts src/devshell/InMemoryDevShellStore.ts src/devshell/PostgresDevShellStore.ts src/devshell/contracts.ts tests/unit/dev-shell-supervisor.test.ts tests/unit/postgres-dev-shell-store.test.ts db/migrations/021_dev_shell_source_write_guard_json.sql apps/desktop/resources/kestrel-repo/db/migrations/021_dev_shell_source_write_guard_json.sql
git add src/devshell/DevShellSupervisor.ts src/devshell/InMemoryDevShellStore.ts src/devshell/PostgresDevShellStore.ts src/devshell/contracts.ts tests/unit/dev-shell-supervisor.test.ts tests/unit/postgres-dev-shell-store.test.ts db/migrations/021_dev_shell_source_write_guard_json.sql apps/desktop/resources/kestrel-repo/db/migrations/021_dev_shell_source_write_guard_json.sql
git diff --cached --check
git diff --cached --name-only
```

Expected staged files are exactly the files listed above, plus no unrelated prompt, desktop UI, internet-tool, or progress-ledger files.

- [ ] **Step 4: Commit**

Run:

```bash
git commit -m "devshell: persist source write guard results"
```

Expected: one isolated dev-shell persistence commit.

## Risks And Guardrails

- Do not persist active source snapshots or file contents in Postgres in this slice.
- Do not try to restore source writes after supervisor restart; the in-memory snapshot is gone, so recovery must be explicit rather than guessed.
- Do not add URL/path keyword heuristics, command classification, retry thresholds, or policy scoring.
- Do not touch the currently dirty `agents/reference-react/prompts/includes/dev-shell.md` unless a separate prompt slice is approved.
- Do not stage unrelated dirty files.

## Self-Review

- Spec coverage: the plan persists guard results, preserves deterministic replay metadata, makes lost-process recovery explicit, and avoids heuristic behavior.
- Placeholder scan: no task relies on "TODO" or unspecified tests.
- Type consistency: `finalCheckCompleted` is used only as an optional field on `DevShellSourceWriteGuardResult`, matching `DevShellProcessRecord.sourceWriteGuard`.
