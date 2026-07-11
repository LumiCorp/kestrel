---
id: managed-worktree-source-promotion-design-2026-05-20
domain: runtime
status: historical
owner: kestrel-runtime
last_verified_at: 2026-07-10
depends_on:
  - ../../ARCHITECTURE.md
  - ../../docs/adr/0002-git-backed-workspace-checkpoints.md
  - ../../src/engine/ExecutionEngine.ts
  - ../../src/workspace/ManagedTaskWorktreeService.ts
  - ../../src/workspaceCheckpoints/service.ts
  - ../../src/devshell/DevShellSourceWriteGuard.ts
---

# Managed Worktree Source Promotion Design

See also: [Plans index](../PLANS.md).

This design has been implemented in
[`ManagedWorktreePromotionService`](../../src/workspace/ManagedWorktreePromotionService.ts)
and [`WorkspaceLifecycleCoordinator`](../../src/engine/WorkspaceLifecycleCoordinator.ts).
It remains as historical design context.

## Problem

Kestrel coding runs can mutate files inside managed task worktrees, but the source workspace does not currently receive those changes through a first-class runtime transaction.

The current model protects the source workspace by routing mutation-capable dev tools into a managed worktree, then checkpointing and rolling back failed tool actions inside that worktree. This is safer than direct source writes, but it leaves a user-visible gap: after the agent succeeds, the source checkout still needs an explicit and reliable path to receive the work.

## Goal

Make successful managed-worktree coding changes appear in the source workspace automatically, with enough checkpoint evidence to make "undo last change" reliable.

## Non-Goals

- Do not create a new worktree for every individual mutating tool call.
- Do not loosen the source-write guard for direct shell writes against the source workspace.
- Do not silently promote unverified or partial work by default.
- Do not overwrite source paths that changed since the managed worktree was created.
- Do not delete dirty unpromoted worktrees during cleanup.
- Do not use keyword rules, score thresholds, or path heuristics to decide promotion safety.

## Current Runtime Facts

Managed worktrees are already provisioned before selected dev tools run when the runtime payload marks the workspace as requiring a managed worktree. The runtime stores a trusted binding on session state and rewrites the tool payload so mutation tools see the managed worktree as `workspaceRoot`.

Managed worktrees are detached from the source repository `HEAD`. This intentionally avoids importing dirty source checkout state into the execution workspace.

Mutation-capable tools already receive pre-action checkpoints, post-action changed-file evidence, and rollback-on-failure when a trusted managed worktree binding is present. These checkpoints apply to the active managed worktree, not automatically to the source workspace.

Source writes outside the managed worktree remain guarded as source-readonly. Managed worktree writes use checkpoint-backed guard mode.

## Recommended Design

Keep the scoped managed worktree model. Add a source promotion transaction that runs only after a terminal successful managed-worktree coding run.

Promotion should be a runtime-owned source write path. It should not rely on model-authored copy commands, shell text, or user-visible manual file moves.

The transaction is:

1. Confirm the run is terminal and eligible for promotion.
2. Confirm the managed worktree binding is valid.
3. Hold the worktree lease through promotion, or acquire an explicit promotion lock before the run lease is released.
4. Refuse promotion while a managed process lease is active.
5. Compute the managed diff from the worktree `baseHead` to the managed worktree current tree.
6. If there is no diff, record a no-op promotion result and leave source untouched.
7. Capture a source pre-promotion checkpoint.
8. Check source divergence for every changed path by comparing the current source file state with `baseHead`.
9. If any changed source path diverged, block promotion with a conflict result.
10. Apply only the managed diff into the source workspace.
11. Capture a source post-promotion checkpoint.
12. Record a promotion transaction with source checkpoints, changed paths, managed worktree root, base head, and status.
13. Emit a `managed_worktree.promoted` run event.

The source workspace becomes the only place that user-facing undo targets. "Undo last change" restores the source pre-promotion checkpoint for the latest completed promotion transaction.

Promotion must happen inside terminal handling before the managed worktree becomes reusable, or the runtime must persist a blocking promotion state on the worktree. A verified worktree that is waiting on promotion conflict resolution must not be silently reused by another run.

## Eligibility

Automatic promotion should initially run only when the managed run completes with verified success.

Do not automatically promote `implemented_not_verified` or blocked work in the first slice. Those states should remain visible as pending managed-worktree changes that can be reviewed or promoted by an explicit future command.

This keeps partial edits from silently changing the user's source checkout.

`COMPLETED` alone is not a sufficient trigger. The promotion gate must require coding closeout evidence equivalent to `completionState: "implemented_and_verified"`, no failed checks, and concrete changed-file evidence from runtime checkpoint comparison. Non-coding completed runs, unavailable-tool completions, and retrieval synthesis completions must not enter source promotion.

## Conflict Handling

Promotion must fail closed if the source workspace changed on any path the managed worktree also changed.

The conflict check is path-specific and evidence-based:

- For each managed changed path, read the file state from `baseHead`.
- Read the current source workspace file state.
- Read the current source index state.
- Read the managed worktree file state.
- If current source working-tree content or index content does not match `baseHead`, block promotion for that path.
- If current source working-tree content and index content match `baseHead`, apply the managed state.

This is not a heuristic merge. The first implementation should not attempt three-way conflict resolution.

For added files, an existing source file, directory, symlink, or staged entry at the same path is a conflict. For deleted files, a source file that already changed or disappeared is a conflict. Renames can be represented as delete plus add in the first slice unless the implementation can preserve Git rename metadata without weakening conflict checks.

Promotion should preserve binary content, executable mode, symlinks, and deletions. Use Git plumbing and NUL-delimited path lists where possible; do not implement promotion as text-only reads and writes.

Submodule or gitlink changes should fail closed in the first slice unless explicitly supported.

## Checkpoint Semantics

Existing checkpoint records need enough metadata to distinguish active workspace roles:

- `workspaceRole: "source"` for source checkpoints.
- `workspaceRole: "managed_worktree"` for managed worktree checkpoints.
- Optional promotion metadata for source pre/post checkpoints.

Restore commands must validate the checkpoint target role and workspace root before applying. A source undo should never restore a managed worktree checkpoint into the source workspace, and a managed worktree rollback should never restore a source promotion checkpoint into the managed worktree.

Source promotion should construct its source checkpoint setup from the managed worktree binding's `sourceWorkspaceRoot` and `sourceRepoRoot`, not from a possibly stale or switched session project snapshot.

Promotion transactions need durable state, not only run events. The minimum record should include transaction id, session id, run id, source workspace root, source repo root, managed worktree root, base head, changed paths, status, source pre-checkpoint id, source post-checkpoint id, conflict paths, and timestamps.

## Cleanup Semantics

Managed worktree cleanup should be conservative:

- It may remove clean worktrees with no active lease after the retention window.
- It may remove dirty worktrees only when their latest diff was promoted and no active process lease exists.
- It must not remove dirty unpromoted worktrees.
- It must not remove worktrees with active run or process leases.
- It should emit cleanup events with worktree root, scope, reason, and skipped reason.

Cleanup should be periodic and explicit. Promotion should update worktree metadata so cleanup can make deterministic decisions without inspecting model text.

Worktree metadata should distinguish at least:

- `pending_promotion`
- `promotion_blocked`
- `promoted`
- `abandoned`

Cleanup can only delete dirty worktrees in `promoted` or explicit `abandoned` state, with no active lease or process lease.

## Operator UX

The user should not need to approve routine source promotion after a verified successful run.

The operator-visible statuses should be:

- `Promoted to source` with changed-file count and undo checkpoint.
- `No source changes` when the worktree diff is empty.
- `Promotion blocked` with concrete conflicting paths.
- `Pending review` for implemented-but-unverified work.

Undo should target the latest completed promotion transaction, not the latest managed-worktree checkpoint.

## Risks

The largest risk is mixing source checkpoints and managed-worktree checkpoints in existing checkpoint UI and restore flows. This requires explicit checkpoint role metadata before automatic source promotion ships.

Long-running processes are another risk. A managed worktree with an active process lease may still be writing files, so promotion must block until the process exits or is stopped.

Dirty source workspaces are common. Promotion must preserve unrelated source dirt and must block only paths that overlap with the managed diff.

Generated and ignored files remain outside normal checkpoint restore semantics. This matches the current checkpoint ADR, but promotion messaging must not imply caches or ignored build outputs are covered by undo.

Source index state is a risk. Promotion must not leave the user's index with stale staged content. If the source index differs from `baseHead` on any changed path, block promotion.

Terminal ordering is a risk. Current terminal handling releases managed worktree leases for terminal statuses. Promotion must run before release, or a promotion lock/state must block reuse until promotion completes, is explicitly deferred, or is abandoned.

Session routing is a risk. Restore and checkpoint commands often resolve their target through the session project snapshot. Promotion and undo must use the promotion transaction's recorded source workspace, not whatever workspace the UI currently has selected.

Path handling is a risk on case-insensitive filesystems and with unusual filenames. Promotion should use Git pathspec plumbing and NUL-delimited paths rather than string-splitting command output.

## Tabletop Scenarios

| Scenario | Expected behavior |
| --- | --- |
| Verified coding run changes `app/page.tsx`; source path still matches `baseHead`. | Promote the file, capture source pre/post checkpoints, record `promoted`, release lease. |
| Coding run completes `implemented_not_verified`. | Do not promote; record pending review state; keep worktree recoverable. |
| Non-coding run completes successfully. | Do not promote even if a managed worktree binding exists. |
| Tool-unavailable or policy-blocked finalization completes. | Do not promote. |
| Managed worktree has no diff from `baseHead`. | Record no-op promotion; release lease; source unchanged. |
| Source has unrelated dirty files outside managed diff. | Promote changed managed paths only; preserve unrelated source dirt. |
| Source has unstaged changes on a managed changed path. | Block promotion with concrete conflict path. |
| Source has staged changes on a managed changed path but working tree matches `baseHead`. | Block promotion because the index differs. |
| Managed diff adds a file where source already has an untracked file or directory. | Block promotion with conflict path. |
| Managed diff deletes a file that source already modified or deleted. | Block promotion with conflict path. |
| Managed process is still running in the worktree. | Block promotion until process exits or is stopped. |
| Promotion blocks on conflict. | Keep or acquire a promotion lock so the worktree is not reused; surface operator action. |
| User asks "undo last change" after promotion. | Restore the source pre-promotion checkpoint from the latest completed promotion transaction. |
| User asks "undo last change" when promotion is blocked and source was untouched. | No source restore; point to pending managed worktree promotion. |
| Cleanup sees dirty unpromoted worktree. | Skip and report reason. |
| Cleanup sees dirty promoted worktree with no active lease after retention. | Remove worktree and sidecar metadata. |

## Acceptance Criteria

- Verified managed-worktree coding runs promote source changes automatically.
- Promotion requires `implemented_and_verified` coding closeout evidence, not only run status `COMPLETED`.
- Failed runs still roll back only the managed worktree action that failed.
- `implemented_not_verified` runs do not auto-promote.
- Source pre/post promotion checkpoints are recorded.
- Undo last promoted change restores the source pre-promotion checkpoint.
- Promotion blocks when an active managed process lease exists.
- Promotion blocks when source paths changed since the managed worktree base.
- Promotion blocks when source index state changed on affected paths.
- Promotion applies only changed paths from the managed diff.
- Checkpoint restore cannot confuse source checkpoints with managed-worktree checkpoints.
- Promotion cannot race with lease release or worktree reuse.
- Promotion records durable transaction state.
- Cleanup never deletes dirty unpromoted worktrees.

## Validation

Focused tests should cover:

- Clean source promotion.
- Empty managed diff.
- Source path conflict blocking.
- Source index conflict blocking.
- Source untracked path collision.
- Active process lease blocking.
- `implemented_not_verified` leaves work pending.
- Non-coding `COMPLETED` runs do not promote.
- Source undo restores the source pre-promotion checkpoint.
- Managed worktree rollback still restores the managed pre-action checkpoint.
- Promotion conflict keeps the worktree from reuse.
- Cleanup skips dirty unpromoted worktrees.

Before shipping:

```bash
pnpm run governance:check
pnpm run test
pnpm run prompt-suite
pnpm run evals:release-check
```
