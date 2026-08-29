# TUI Execution Environment Selection Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Preserve environment consistency through protocol correlation](08-preserve-environment-consistency-through-protocol-correlation.md)

## In progress

None.

## Blocked

- [Let users choose and understand the TUI execution environment](02-expose-environment-controls-and-language.md) — blocked by [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md), [Keep TUI sessions unstarted until execution actually begins](03-repair-tui-session-start-lifecycle.md), [Make session describe durable and environment-authoritative](04-make-session-describe-durable-and-environment-authoritative.md), and [Bind TUI start state to authoritative runtime acceptance](05-bind-start-state-to-authoritative-runtime-acceptance.md)
- [Reconcile TUI lifecycle from exact runtime evidence](06-reconcile-tui-lifecycle-from-exact-runtime-evidence.md) — blocked by [Make session describe durable and environment-authoritative](04-make-session-describe-durable-and-environment-authoritative.md)

## Implemented

- [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md)
- [Keep TUI sessions unstarted until execution actually begins](03-repair-tui-session-start-lifecycle.md)
- [Bind TUI start state to authoritative runtime acceptance](05-bind-start-state-to-authoritative-runtime-acceptance.md)
- [Make session describe durable and environment-authoritative](04-make-session-describe-durable-and-environment-authoritative.md)
- [Make durable describe strictly read-only and deterministic](07-make-durable-describe-strictly-read-only-and-deterministic.md)

## Done

None.
