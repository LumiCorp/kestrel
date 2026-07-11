---
id: adr-reference-react-command-processor
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../../CONTEXT.md
  - ../../agents/reference-react/src/commandProcessor.ts
  - ../../src/kestrel/contracts/execution.ts
  - ../../src/kestrel/contracts/orchestration.ts
  - ../../src/kestrel/contracts/store.ts
  - ../../src/orchestration/ThreadRuntime.ts
  - ../../src/replay/RunReplayService.ts
---

# ADR 0001: Reference React Command Processor

## Status

Accepted

## Context

The reference-react agent had too many mutation and policy responsibilities spread across step code, especially execution dispatch, batch handling, waits, observation handoff, finalization, and working-plan state. That made larger autonomous work chunks harder to reason about because the runtime could not point to one place that translated model decisions into state changes, effects, waits, and operator-visible progress.

Kestrel also needed prompt provenance without retaining rendered prompt text. Full snapshots are useful for debugging, but they increase data-retention risk and make audit storage a transcript store. Hash-only provenance answers whether a model-call identity changed while preserving the boundary that prompt text is not stored by default.

## Decision

Reference-react will use an agent-local [command processor](../../agents/reference-react/src/commandProcessor.ts) as the mutation authority for the redesigned agent loop. Steps read immutable snapshots and emit typed command batches. The command processor translates those commands into state deltas, effects, waits, observations, next-step routing, and working-plan updates.

Registered step IDs remain stable. Operator surfaces receive a simpler phase projection over the existing graph instead of a breaking graph rename.

Prompt provenance is hash-only by default. Runtime records store provider-payload hashes and Kestrel component hashes through the durable runtime contract modules under [src/kestrel/contracts/](../../src/kestrel/contracts/), plus non-secret metadata such as model, provider, step, turn, assembly, schema, and tool-manifest identity.

## Consequences

- Read-only command batches can grow larger and run as parallel context gathering.
- Writes, shell commands, durable effects, waits, and finalization remain ordered checkpoints.
- Existing replay contracts can keep current step IDs while exposing clearer operator phases.
- Prompt audit can detect drift and correlate model calls to turns without persisting rendered prompts.
- Future work should migrate remaining direct `reactState` mutation behind the command processor rather than adding more local patch sites.
