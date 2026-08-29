# TUI Execution Environment Selection Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Keep TUI sessions unstarted until execution actually begins](03-repair-tui-session-start-lifecycle.md)
- [Make session describe durable and environment-authoritative](04-make-session-describe-durable-and-environment-authoritative.md)

## In progress

None.

## Blocked

- [Let users choose and understand the TUI execution environment](02-expose-environment-controls-and-language.md) — blocked by [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md), [Keep TUI sessions unstarted until execution actually begins](03-repair-tui-session-start-lifecycle.md), and [Make session describe durable and environment-authoritative](04-make-session-describe-durable-and-environment-authoritative.md)

## Implemented

- [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md)

## Done

None.
