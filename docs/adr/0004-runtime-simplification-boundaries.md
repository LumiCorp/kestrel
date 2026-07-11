---
id: adr-runtime-simplification-boundaries
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-08
depends_on:
  - ../../AGENTS.md
  - ../../ARCHITECTURE.md
  - ../../src/kestrel/contracts/base.ts
  - ../../src/kestrel/contracts/events.ts
  - ../../src/kestrel/contracts/execution.ts
  - ../../src/kestrel/contracts/model-io.ts
  - ../../src/kestrel/contracts/orchestration.ts
  - ../../src/kestrel/contracts/store.ts
  - ../../src/engine/ExecutionEngine.ts
  - ../../src/orchestration/ThreadRuntime.ts
  - ../../src/runtime/RuntimeTurn.ts
  - ../../tools/runtime/UnifiedToolRegistry.ts
---

# ADR 0004: Runtime Simplification Boundaries

## Status

Accepted

## Context

Kestrel's runtime implementation accumulated overlapping concepts across the engine, orchestration runtime, store, tool registry, runner protocol, SDK, and reference agent. The ownership boundary is now expressed through focused [runtime contract modules](../../src/kestrel/contracts/) instead of one monolithic file, and the simplification series exists to keep those contracts explicit while deleting the old overlap.

The simplification series must preserve deterministic replay, explicit runtime contracts, and evidence-backed behavior while reducing overlap. The first implementation slice is documentation plus [characterization tests](../../tests/unit/runtime-simplification-characterization.test.ts); later PRs can make coordinated internal API breaks when tests pin current behavior.

## Decision

Kestrel will use these canonical concepts for the simplification series:

- `AgentDefinition`: the static description of an agent's step graph, step contracts, entry step, and agent-owned state contract.
- `AgentInstance`: the runtime registration of an `AgentDefinition` against a Kestrel runtime with concrete dependencies.
- `Run`: one execution attempt over a session event, owned by the runtime lifecycle.
- `Turn`: an operator or adapter request projected into one or more runtime runs, owned by turn orchestration and conversation projection.
- `Step`: one agent-owned execution unit selected by the runtime scheduler and committed atomically.
- `RuntimeIO`: the model/tool execution boundary used by steps, including provenance, validation, progress, queueing, console bridging, and budget propagation.
- `RuntimeStore`: the narrow persistence capabilities required by runtime lifecycle, step commits, event recording, effects, outbox, artifacts, claims, replay, and projections.
- `ToolRegistry`: the single model-visible and capability-visible tool boundary, including validation, invocation, provider refresh, and hidden/internal tool enforcement.
- `RuntimeEvent`: the persisted runtime event model used as the authoritative replay stream.
- `Result`: the normalized terminal output for a run or turn, derived from committed state and terminal lifecycle events.

Ownership rules:

- Runtime owns run lifecycle: run ID creation, start, resume, wait, completion, failure, cancellation, terminal normalization, leases, and lifecycle events.
- Agent owns step graph and agent state shape: step IDs, transitions, action/result state, waits it requests, and step contracts.
- Store persists canonical records only: sessions, runs, commits, effects, outbox, artifacts, claims, events, logs, replay records, and projection records through narrow interfaces.
- Thread runtime owns operator/conversation projection only: thread status, turn grouping, operator controls, context assembly, delegation projection, and adapter-facing conversation state.
- Runner, SDK, CLI, Desktop, and web UI are adapters: they map public commands and public event names onto canonical runtime turns, results, and projected events.

## Consequences

- `src/kestrel/contracts/` is the canonical runtime contract surface. New work should land in the focused ownership module instead of recreating a compatibility barrel.
- Later PRs should favor deletion and consolidation over accumulating adapters that preserve old ownership collisions.
- Runtime behavior changes are not part of this ADR. Characterization tests must fail when lifecycle ordering, wait/resume targets, direct model/tool event surfaces, or atomic step persistence change unexpectedly.
- Public event and protocol compatibility can change only in the event-normalization PR, with tests and release notes in the same slice.
- New heuristic routing, ranking, fallback, or policy behavior remains out of scope unless explicitly approved.
