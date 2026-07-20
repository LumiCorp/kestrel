---
id: design-root
domain: agent
status: active
owner: kestrel-agents
last_verified_at: 2026-07-20
depends_on: [ARCHITECTURE.md, docs/PLANS.md]
---

# Kestrel Design Principles

Kestrel is designed for agent work that may span many steps, use tools, pause
for people, and continue after an interruption. These principles describe what
people using Kestrel should be able to expect from every product surface.

## Agent work stays understandable

Kestrel shows what work exists, what is happening, what is waiting, and what a
person can do next. Runs have stable identities, progress is represented by
events, and completed, failed, cancelled, and waiting outcomes are distinct.

## Important meaning travels in contracts

Runs, events, tool calls, errors, and terminal results use shared typed
contracts. Human-facing `assistantText` remains separate from structured result
data so an application does not have to recover meaning from display text.

## The same execution model appears everywhere

Desktop, the CLI and TUI, Kestrel One, the SDK, and framework adapters use the
same Runtime and Execution Protocol. Product surfaces may present different
workflows, but they do not redefine sessions, runs, tools, waiting, recovery,
or terminal results.

## Effects are explicit

Model reasoning and real-world effects are different responsibilities.
Filesystem changes, shell commands, network access, provider calls, and MCP
actions pass through validated tool boundaries. Their outcomes remain visible
as structured events, results, artifacts, or checkpoints.

## Recovery is part of normal operation

Long-running work can lose a network connection, close a window, encounter a
provider failure, or wait for a decision. Kestrel preserves durable state so a
person can inspect, resume, retry, cancel, or recover the original work instead
of starting an unrelated replacement.

## Recorded work can be explained later

Sessions, events, artifacts, checkpoints, and operator actions form a durable
record. That evidence supports diagnosis, replay, comparison, and evaluation
after the original request has ended.

## Credentials stay behind trusted boundaries

Provider keys, runner tokens, and deployment credentials stay in Local Core,
the Electron main process, or trusted application servers. Browser and renderer
code receive only the data and capabilities needed for their interface.

## Public documentation is part of the product contract

Root documentation, the public docs site, package documentation, and exported
types describe the same system at different levels of detail. Examples identify
their required version and execution target, and unavailable behavior is stated
as unavailable rather than presented as a tutorial.

## Read Next

- [Architecture](ARCHITECTURE.md)
- [Reliability](RELIABILITY.md)
- [Security](SECURITY.md)
- [Documentation](docs/index.md)
- [Contributor guidance](CONTRIBUTING.md)
