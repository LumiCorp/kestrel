# TUI Execution Environment Selection Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Make queue transactions session-scoped and multi-run](18-make-queue-transactions-session-scoped-and-multi-run.md)

## In progress

None.

## Blocked

- [Let users choose and understand the TUI execution environment](02-expose-environment-controls-and-language.md) — blocked by [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md), [Keep TUI sessions unstarted until execution actually begins](03-repair-tui-session-start-lifecycle.md), [Bind TUI start state to authoritative runtime acceptance](05-bind-start-state-to-authoritative-runtime-acceptance.md), [Reconcile TUI lifecycle from exact runtime evidence](06-reconcile-tui-lifecycle-from-exact-runtime-evidence.md), [Separate queued reservations and backfill thread ownership](15-separate-queued-reservations-and-backfill-thread-ownership.md), [Make queued lifecycle ownership crash-durable and thread-exact](16-make-queued-lifecycle-crash-durable-and-thread-exact.md), [Serialize and reconcile queued ownership](17-serialize-and-reconcile-queued-ownership.md), and [Make queue transactions session-scoped and multi-run](18-make-queue-transactions-session-scoped-and-multi-run.md)

## Implemented

- [Serialize and reconcile queued ownership](17-serialize-and-reconcile-queued-ownership.md)
- [Make queued lifecycle ownership crash-durable and thread-exact](16-make-queued-lifecycle-crash-durable-and-thread-exact.md)
- [Separate queued reservations and backfill thread ownership](15-separate-queued-reservations-and-backfill-thread-ownership.md)
- [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md)
- [Keep TUI sessions unstarted until execution actually begins](03-repair-tui-session-start-lifecycle.md)
- [Bind TUI start state to authoritative runtime acceptance](05-bind-start-state-to-authoritative-runtime-acceptance.md)
- [Reconcile TUI lifecycle from exact runtime evidence](06-reconcile-tui-lifecycle-from-exact-runtime-evidence.md)
- [Make TUI lifecycle reconciliation monotonic and exact](11-make-tui-lifecycle-reconciliation-monotonic-and-exact.md)
- [Close remaining TUI lifecycle ordering gaps](12-close-remaining-tui-lifecycle-ordering-gaps.md)
- [Finish exact reply and terminal ownership](13-finish-exact-reply-and-terminal-ownership.md)
- [Persist submission and thread ownership](14-persist-submission-and-thread-ownership.md)

## Done

- [Make session describe durable and environment-authoritative](04-make-session-describe-durable-and-environment-authoritative.md)
- [Make durable describe strictly read-only and deterministic](07-make-durable-describe-strictly-read-only-and-deterministic.md)
- [Preserve environment consistency through protocol correlation](08-preserve-environment-consistency-through-protocol-correlation.md)
- [Reject uncorrelated descriptions and preserve evidence](09-reject-uncorrelated-descriptions-and-preserve-evidence.md)
- [Claim responses and snapshot evidence before publication](10-claim-responses-and-snapshot-evidence-before-publication.md)
