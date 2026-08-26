# Hosted Approval Simplification Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free
frontier. Move issues between states as implementation and review change the
graph.

Implementation must start from deployed-source revision
`b36756002321b7a7e942d9a08799e7b01fa387f3` or a verified descendant.

## Ready

None.

## In progress

None.

## Blocked

- [Resume the exact prepared invocation after approval](02-resume-prepared-invocation.md) — blocked by [Persist the exact tool invocation before approval](01-persist-prepared-invocation.md)
- [Make the thread interaction the approval decision owner](04-canonicalize-approval-lifecycle.md) — blocked by [Resume the exact prepared invocation after approval](02-resume-prepared-invocation.md)
- [Remember Ask First approval for the thread](03-remember-thread-tool-approval.md) — blocked by [Make the thread interaction the approval decision owner](04-canonicalize-approval-lifecycle.md)
- [Prove the hosted rollout and remove legacy approval paths](05-contract-legacy-approval-paths.md) — blocked by [Remember Ask First approval for the thread](03-remember-thread-tool-approval.md) and [Make the thread interaction the approval decision owner](04-canonicalize-approval-lifecycle.md)

## Implemented

- [Persist the exact tool invocation before approval](01-persist-prepared-invocation.md)

## Done

None.
