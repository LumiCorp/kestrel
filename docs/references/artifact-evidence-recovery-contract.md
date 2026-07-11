---
id: artifact-evidence-recovery-contract
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../index.md
  - ../plans/2026-05-16-tui-session-evidence-recovery-final-answer-hardening.md
  - ../../src/kestrel/contracts/execution.ts
  - ../../src/kestrel/contracts/orchestration.ts
  - ../../src/kestrel/contracts/store.ts
  - ../../src/store/PostgresSessionStore.ts
  - ../../agents/reference-react/src/context/ContextBuilderSupport.ts
  - ../../agents/reference-react/src/steps/acter.ts
  - ../../src/engine/ExecutionEngine.ts
---

# Artifact Evidence Recovery Contract

See also: [Docs index](../index.md).

## Decision

Persisted tool artifacts are durable evidence handles.

When compacted context carries `artifactIds` or `digestArtifactId` values for prior tool results, the runtime must treat those IDs as recoverable evidence references, not inert metadata. A final-answer or synthesis path must either load the relevant artifact payloads, use a stored source index derived from them, or report a precise artifact-access failure.

## Scope

This contract applies to:

- Tool outputs persisted as `tool-output` artifacts.
- Tool output summaries persisted as `tool-output-digest` artifacts.
- Context packets that replace large tool outputs with summaries and artifact IDs.
- Final-answer synthesis after compaction.
- Research-stall and loop-guard recovery when verified evidence already exists.

## Store Contract

The runtime store must expose read/list operations for artifacts in addition to append operations.

Required capabilities:

- Read artifacts by exact artifact ID.
- List artifacts by session ID, run ID, step index, artifact type, and limit.
- Return artifact metadata with payload availability, created time, run ID, session ID, step index, and type.
- Fail closed when an artifact ID belongs to a different session.
- Preserve deterministic replay semantics by returning persisted payloads without re-executing tools.

Artifact reads are evidence recovery operations. They must not be modeled as external web retrieval.

## Context Assembly Contract

When context assembly compacts a large tool output, it must preserve enough metadata for recovery:

- Full output artifact IDs.
- Digest artifact IDs.
- Tool name.
- Run ID and step index when available.
- Query/input lineage when available.
- Source index entries when available.

Context text should make the contract explicit: artifact IDs are loadable handles for stored evidence. It should not imply that raw evidence is gone merely because prompt text is compacted.

## Source Index Contract

Search and extraction artifacts should produce a lightweight source index when structured source data is available.

Recommended fields:

- Artifact ID.
- Tool name.
- Query or extraction input.
- Result title.
- URL.
- Source/publisher.
- Publication date or retrieved date when available.
- Rank or provider position when available.

The source index is a fallback and navigation aid. It does not replace full artifact payloads.

## Final Answer Contract

When the user asks for a final answer, final synthesis, or equivalent completion after prior retrieval:

1. If relevant raw evidence is already in prompt context, synthesize from it.
2. If only artifact handles are present, load the relevant artifacts or source index and synthesize from them.
3. If artifact loading fails, report the exact internal evidence-access failure.
4. Do not ask the user to paste snippets when persisted artifacts exist.
5. Do not run broad retrieval again unless no relevant stored evidence exists or the user explicitly asks to refresh.

Meta answers about process state do not satisfy final-answer intent unless the user explicitly asked for debugging.

## Research Stall And Loop Recovery Contract

When research-stall or loop-guard logic determines that verified evidence is already available, recovery should route to synthesis or artifact rehydration.

The runtime should not produce user-facing continuation language such as `Next if you want...` when it already knows that the next correct step is synthesis from collected evidence.

Loop guards are recovery triggers. They should not become terminal user answers unless recovery fails and the failure is reported precisely.

## Mode And Capability Contract

Plan mode may affect how future work is explained, but it must not prevent recovery of stored read-only evidence once the user asks for an answer.

Capability-loss downgrades must preserve artifact read/recovery capability for the current session. Reading previously persisted artifacts is an internal runtime operation, not a new external side effect.

## Observability Requirements

When an agent or runtime path claims evidence is unavailable, the persisted record should show:

- Whether artifact IDs were present in the current context.
- Whether matching artifacts existed in the store.
- Whether artifact loading was attempted.
- Whether loading failed because of authorization, missing row, malformed payload, or unavailable store capability.
- Whether the final response was substantive or process/meta-only.

This distinction is required to tell apart missing evidence from missing evidence access.

## Non-Goals

- This contract does not authorize new heuristic source ranking.
- This contract does not weaken existing artifact verification or finalization requirements.
- This contract does not require rerunning tools to recover previously persisted evidence.
- This contract does not make compacted prompt summaries authoritative when full artifacts are available.
