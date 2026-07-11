---
id: runtime-native-subagents-design-2026-05-19
domain: runtime
status: approved
owner: kestrel-runtime
last_verified_at: 2026-07-03
depends_on: [../../PLANS.md]
---

# Runtime-Native Sub-Agents Design

See also: [Docs index](../../index.md).

## Status

Approved design for implementation planning.

## Goal

Enable Kestrel agents to spawn other Kestrel agents as first-class runtime branches. The feature should feel like an explicit agent capability, not an operator-heavy delegation console and not recursive shelling out to the CLI.

## Non-Goals

- Do not make automatic task decomposition decisions in v1.
- Do not make every sub-agent spawn create a Kanban card.
- Do not use CLI recursion as the v1 product contract.
- Do not require a large child result schema.
- Do not auto-apply source mutations from child worktrees to the parent workspace in v1.

## Architecture

Sub-agents are runtime-native execution branches exposed through an explicit agent-facing spawn tool. Internally, the implementation reuses the existing delegation stack: child threads, `DelegationSupervisor`, orchestration records, child lineage, fan-in disposition, runner events, and task graph projections.

The parent agent calls a simple spawn tool. Runtime derives the rest of the context: parent thread, parent run, active task/card linkage, workspace binding, current delegation depth, profile policy, managed worktree behavior, and notification/fan-in projection.

CLI recursion can remain a future execution backend for isolation or distributed workers, but it is not the semantic model. The runtime contract is child threads and orchestration records, not subprocess stdout.

## Agent-Facing Spawn Tool

The v1 agent-facing tool is intentionally minimal:

```ts
agent.spawn({
  task: string;
})
```

The tool does not expose model, provider, tool allowlists, worktree controls, role selection, or task graph controls. Those are runtime and policy concerns.

Runtime fills in:

- parent thread and parent run
- active task/card linkage when available
- profile, provider, model, and tool policy inheritance
- delegation depth and concurrency constraints
- workspace binding
- managed worktree policy for write-capable child work
- fan-in behavior

If specialized child behavior is needed later, it should come from operator-managed presets or profile policy, not from expanding the common spawn call.

## Child Result Contract

The child-authored result is also minimal:

```ts
{
  status: "completed" | "blocked" | "failed";
  result: string;
  references?: string[];
  error?: {
    code: string;
    message: string;
  };
}
```

`result` is the semantic handoff from child to parent. `references` can contain links, file URIs, run URLs, artifact references, or other useful pointers. `error` is present only when the child failed or is blocked by a machine-readable condition.

Runtime-generated metadata stays separate from this child-authored result. That includes child thread id, child run id, logs, managed worktree binding, changed files, diffs, checkpoints, and fan-in state.

## Runtime Behavior

When a parent calls `agent.spawn({ task })`, runtime creates a child thread under the parent thread and starts it asynchronously. The parent does not block by default.

The child inherits the parent profile and policy envelope. Runtime enforces:

- delegation must be enabled on the profile
- max concurrent child agents
- max delegation depth
- inherited tool restrictions
- managed worktree use for write-capable child work
- manual fan-in for source mutations

The parent can inspect children through existing list/result mechanics. If a child blocks, fails, or produces source changes requiring fan-in, runtime emits notifications and operator inbox items. Normal completed children become lightweight activity on the parent thread or active task.

Nested sub-agents are allowed only within configured depth and concurrency limits. Nested lineage should collapse into the parent task/card activity unless a blocker, failure, or fan-in condition needs attention.

## Managed Worktrees And Fan-In

Write-capable child work uses the existing managed task worktree system. Read-only child work can run against the inherited workspace context without requiring a separate card or worktree.

For source mutations, child completion does not auto-apply changes to the parent workspace in v1. Runtime produces a fan-in checkpoint with the generated diff/worktree metadata and result reference. The operator can accept, defer, or supersede through existing control paths.

Non-mutating child results can be consumed by the parent without manual fan-in.

## Task Graph And Kanban

Kanban is task-level, not spawn-level. A single task/card can have many child sub-agent runs attached to it.

Default behavior:

- If the parent thread has an active task/card, child spawns attach to that task.
- A child spawn does not create a new Kanban card by default.
- A new card is created only when a task boundary is explicit through task graph or operator workflows.
- Cards aggregate child activity, status, result references, blockers, and fan-in state.

The existing `ProductTaskGraph` and delegation task projection should be reused, but adjusted so delegation lineage can aggregate under the active task instead of forcing a one-card-per-child model.

## UX

The primary UX is thread-tree plus notifications.

Web and Desktop:

- Parent transcript shows compact child activity: spawned, running, completed, blocked, failed.
- Child entries can expand or link to the child thread/run.
- Notifications/inbox surface only meaningful events: blocked child, failed child, result ready, source fan-in needed.
- Kanban cards aggregate child activity under the active task.

TUI:

- Show child activity inline in session/task views.
- Keep drill-in for child lineage and results.
- Avoid making a heavy Delegation Review workflow the normal path.

Ops:

- Preserve richer lineage/replay/debug views for inspection.
- Keep worktree, fan-in, event, and failure details available for operators and runtime debugging.

## Data And Events

Existing orchestration/delegation records remain the source of truth.

Small data additions:

- task/card linkage on child spawn records, when an active task exists
- delegation depth and max-depth metadata
- optional root delegation id or lineage metadata for nested child compression
- stored child result envelope

Event naming should preserve backward compatibility where possible. Persisted `delegation.*` events can remain the storage contract while projections and UI label them as sub-agent activity. New product-facing event labels may be introduced at the projection layer if needed.

Important projected events:

- sub-agent spawned
- sub-agent completed
- sub-agent blocked
- sub-agent failed
- sub-agent result ready
- source fan-in required

## Implementation Shape

This is an evolution of the existing delegation implementation, not a new subsystem.

Implementation should:

- add an `agent.spawn` shared tool with schema `{ task: string }`
- route it through the existing `DelegationServicePort` and `DelegationSupervisor`
- keep `delegate.*` tools as internal or legacy aliases, hidden from normal agent-facing surfaces where practical
- extend delegation records/policy with task linkage and depth metadata
- store the simple child result envelope on completion
- project child activity into parent thread/task summaries and notifications
- keep Kanban as task aggregation, not spawn-per-card
- reuse managed task worktrees for write-capable child runs

## Validation

Validation should prove:

- `agent.spawn` accepts only the minimal schema
- spawning is rejected when profile delegation is disabled
- concurrency and depth limits are enforced
- child spawns attach to the active task without creating a new card by default
- parent execution remains asynchronous after spawn
- blocked, failed, and completed children generate lightweight notifications
- write-capable child work uses managed worktrees
- source mutations require manual fan-in
- Web, Desktop, and TUI projections remain lightweight
- replay and ops views retain child lineage and worktree evidence
