---
id: adr-git-backed-workspace-checkpoints
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../../CONTEXT.md
  - ../../src/workspaceCheckpoints/service.ts
  - ../../src/workspaceCheckpoints/contracts.ts
  - ../../src/devshell/DevShellSourceWriteGuard.ts
---

# ADR 0002: Git-Backed Workspace Checkpoints

## Status

Accepted

## Context

Workspace checkpoints originally copied Git-visible files into `.kestrel/checkpoints/<id>/tree`.
That made manual restore straightforward, but it is the wrong primitive for action-boundary rollback in agent coding runs. A long coding turn can execute many mutation-capable actions, and copying a large workspace before each one creates unnecessary disk churn.

The dev-shell source-write guard also needed a clearer transaction boundary. Source writes inside a dedicated Kestrel task worktree are acceptable when the runtime can compare and restore source state through durable checkpoints. Source writes outside that managed worktree remain source-read-only by default.

## Decision

Workspace checkpoints are stored as Kestrel-owned hidden Git commit refs using `storageKind: "git_ref_v1"`.
Checkpoint records expose the internal `gitRef` for audit and replay, but the ref remains runtime-owned.
The implementation is centered in [WorkspaceCheckpointService](../../src/workspaceCheckpoints/service.ts), with the persisted record contract in [workspace checkpoint contracts](../../src/workspaceCheckpoints/contracts.ts).

Checkpoint capture uses a temporary Git index so it records tracked files plus untracked non-ignored files without disturbing the user-visible index. Restore uses the checkpoint ref to restore Git-visible files and remove Git-visible files created after the checkpoint. Ignored files, caches, and build outputs are not restored or deleted by default.

Kestrel does not retain compatibility with `workspace_artifact_v1` checkpoint records. Workspaces without a usable Git repository fail closed for checkpoint flows that require rollback.

Inside a managed Kestrel task worktree, shell-produced source diffs can count as implementation progress when the runtime supplies explicit changed-file evidence from checkpoint comparison. Shell output text and command parsing do not count as source-edit evidence.

## Consequences

- Checkpoint capture no longer copies the source tree into `.kestrel/checkpoints`.
- Retention cleanup deletes hidden checkpoint refs and keeps existing logical count/age/label/thread/run/task semantics.
- `totalBytes` remains a logical tree-size value, not a precise promise of Git object storage reclaimed by cleanup.
- Ignored files survive checkpoint restore unless another explicit cleanup mechanism removes them.
- Non-Git workspaces must be initialized or rebound before coding rollback/time-travel flows can run.
