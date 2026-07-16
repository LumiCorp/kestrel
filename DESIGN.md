---
id: design-root
domain: agent
status: active
owner: kestrel-agents
last_verified_at: 2026-07-16
depends_on: [ARCHITECTURE.md, docs/PLANS.md]
---

# Kestrel Design Principles

Kestrel is designed for agent work that must remain understandable while it is
running and defensible after it ends. These principles guide runtime, product,
package, prompt, and documentation decisions.

## 1. Make Agent Work Legible

The system should show what exists, what is happening, what is blocked, and
what a person can do next. Waiting is a state, not a spinner. Failure is an
outcome, not missing UI. Recovery operates on the original work.

**In practice:** expose run identity, progress, tool activity, terminal state,
artifacts, and operator actions through shared contracts.

## 2. Give Every Decision an Owner

Repair behavior where it first becomes wrong. A downstream rejection is useful
evidence, but it does not automatically make the downstream boundary the owner
of the bug.

**In practice:** name the observed failure, first wrong component, owning
surface, and proof before implementing a runtime fix.

## 3. Carry Contracts Across Boundaries

Important meaning belongs in typed fields, validators, tool descriptions,
examples, prompts, and result shapes—not in convention or ambient process
state.

**In practice:** keep `assistantText`, structured results, status, and waiting or
cancellation outcomes explicit from runtime through public packages and UI.

## 4. Prefer Determinism Over Cleverness

Replay, retries, recovery, and tests depend on stable behavior. Hidden ranking,
keyword rules, fallback classification, and threshold policy make the system
harder to explain and reproduce.

**In practice:** do not add heuristic decision-making without surfacing the
exact rule, ownership, evidence, and approval.

## 5. Harden What the Model Can See

When model behavior is weak or repetitive, improve the instructions and
contracts that shape it before adding invisible policy around it.

**In practice:** strengthen prompts, schemas, field descriptions, examples,
validators, retries, and result shaping before considering caps, thresholds,
or fallback ranking.

## 6. Keep Effects Explicit

Agent reasoning and real-world effects are different responsibilities.
Filesystem writes, shell commands, network access, model calls, and MCP actions
must pass through typed, policy-aware boundaries.

**In practice:** parse input before use, return machine-readable outcomes, and
leave evidence for workspace mutations and operator-sensitive actions.

## 7. Build One Runtime, Many Surfaces

Desktop, Kestrel One, CLI/TUI, SDK, and framework adapters should share the
same execution model rather than reconstructing local variants.

**In practice:** product surfaces own experience and trusted context; the
runtime owns lifecycle, state, effects, evidence, and terminal results.

## 8. Design Recovery Before the Happy Path Is Done

Long-running work will be interrupted. A production-shaped feature includes
diagnosis, cancellation, resume, retry, and evidence—not just successful
execution.

**In practice:** define terminal states and recovery ownership alongside the
initial request path.

## 9. Keep Changes Small and Reversible

Contract-heavy systems are safer to evolve through narrow, independently
verified changes.

**In practice:** use existing utilities and boundaries, avoid speculative
abstractions, and separate migrations or policy changes from unrelated cleanup.

## 10. Treat Documentation as a Product Contract

Public guidance, repository truth docs, and exported code describe the same
system at different depths. Drift between them is a product defect.

**In practice:** lead with reader outcomes in public docs, keep maintainer
ownership precise in root docs, pin release-sensitive examples, and run the
documentation and governance checks.

## Decision Test

When several designs appear viable, prefer the option that:

1. keeps authority in the existing owner
2. makes behavior visible in contracts and evidence
3. remains deterministic under replay and recovery
4. reduces duplicated runtime meaning across surfaces
5. is testable without a live provider when practical
6. can be rolled back without an irreversible data or policy move

## Design Inputs

- [Architecture](ARCHITECTURE.md)
- [Plans index](docs/PLANS.md)
- [Quality score](QUALITY_SCORE.md)
- [Reliability](RELIABILITY.md)
- [Security](SECURITY.md)
- [Heuristic hotspots](docs/references/heuristic-hotspots.md)
- [Contributor guardrails](AGENTS.md)
