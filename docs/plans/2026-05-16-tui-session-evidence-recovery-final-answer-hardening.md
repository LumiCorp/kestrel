---
id: tui-session-evidence-recovery-final-answer-hardening-2026-05-16
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../PLANS.md
  - ../references/artifact-evidence-recovery-contract.md
  - ../../src/kestrel/contracts.ts
  - ../../src/store/PostgresSessionStore.ts
  - ../../agents/reference-react/src/context/ContextBuilderSupport.ts
  - ../../agents/reference-react/src/steps/acter.ts
  - ../../src/engine/ExecutionEngine.ts
  - ../../cli/app/App.ts
---

# TUI Session Evidence Recovery And Final Answer Hardening

See also: [Plans index](../PLANS.md).

## Problem Statement

Session `session-1778937400333` exposed a runtime/user-experience failure where the agent collected useful local-government news evidence, lost practical access to that evidence after compaction, repeatedly asked the user to continue or rerun searches, and eventually continued broad retrieval instead of synthesizing the requested final answer.

The core failure is not that tool evidence was absent. Full tool outputs were persisted as artifacts. The active agent path carried compact summaries and artifact IDs, but did not have a first-class rehydration path from those IDs back into final-answer synthesis.

## Session Evidence

- The conversation began as a read-only research request about Cincinnati local-government news.
- Multiple `internet.news` and `internet.search_advanced` calls persisted full `tool-output` and `tool-output-digest` artifacts.
- Later turns included explicit final-answer requests such as `produce it`, `ok so produce the final answer!`, and `give me your final answer`.
- The agent responded with process/meta answers, asked for more retrieval or pasted snippets, and said it only had a summarized record of tool calls.
- The runtime store still had raw search outputs, including Cincinnati Enquirer, FOX19, WLWT, WVXU, and WKRC results.
- Later recovery attempts ran additional broad searches instead of synthesizing from stored artifacts.
- The last observed recovery attempt failed with `LOOP_GUARD_TRIGGERED` after repeated no-progress reasoning/search cycles.

## Root Causes

### Stored evidence is not recoverable enough

The runtime writes full tool artifacts, but the active store contract and context path do not make those artifacts loadable evidence handles for synthesis after compaction.

### Final-answer intent is under-specified

When the user asks for a final answer, the runtime currently allows meta answers, continuation prompts, and additional broad retrieval. It needs a stronger terminal synthesis contract.

### Research-stall handling leaks internal state to users

The retrieval guard can know that verified evidence is already available while still producing user-facing `Next if you want...` language. That turns a recoverable internal state into another stop.

### Plan-mode behavior over-asks

Read-only research in plan mode should not keep asking for permission once evidence exists and the user explicitly asks for the answer.

### TUI presentation amplifies dissatisfaction

Reasoning rows such as `I finished the execution path and finalized the run.` appear in the main transcript before weak or incomplete answers.

### Retrieval quality compounds the issue

The session repeatedly ran broad Cincinnati mayor/council queries that returned noisy results. Retrieval quality is secondary to artifact recovery, but it made the loop more visible.

## Work Chunk 1: Durable Evidence Recovery

Goal: make persisted tool evidence actually usable after compaction.

Scope:

- Add artifact read/list APIs to the runtime store contract.
- Implement artifact rehydration for `tool-output` and `tool-output-digest`.
- Teach context assembly and synthesis to treat `artifactIds` as loadable evidence handles.
- Build a lightweight source index from search/extract artifacts: title, URL, source, date when available, query, and artifact ID.
- Preserve query/result lineage for later synthesis and operator inspection.

Done when:

- A compacted session with only artifact IDs can recover source titles and URLs without rerunning search.
- The agent can synthesize from prior tool results after compaction.
- Artifact load failures are reported as precise internal failures, not user requests for pasted snippets.

## Work Chunk 2: Final Answer Contract

Goal: make `produce it` and `final answer` mean synthesize, not ask, stall, or search again.

Scope:

- Define final-answer intent as terminal synthesis intent.
- Route final-answer requests to artifact-backed synthesis when stored evidence exists.
- Block generic reretrieval unless no relevant stored evidence exists or the user explicitly asks to refresh.
- Treat missing raw evidence in the compacted prompt as internal recovery work.
- Add answer-substance validation so meta replies do not count as successful completion.

Done when:

- A final-answer request cannot complete with only a status explanation.
- A final-answer request with stored evidence produces a substantive answer or a precise artifact-access failure.
- `ask_user` is invalid when the missing input is internally recoverable from persisted artifacts.

## Work Chunk 3: Research Stall And Loop Recovery

Goal: turn loop guards into recovery paths, not user-facing dead ends.

Scope:

- Change `verifiedEvidenceAvailable: true` handling so it forces synthesis or artifact recovery.
- Stop emitting `Next if you want...` when the runtime already knows the next step.
- Separate internal stall diagnostics from terminal user replies.
- Make loop-guard failures explain the actual failure mode.
- Treat repeated retrieval after verified evidence as a runtime bug class.

Done when:

- Retrieval guard output routes into synthesis/recovery before final user messaging.
- Loop-guard failures identify whether the system failed to synthesize stored evidence.
- Users are not asked to approve the next known step in a read-only answer flow.

## Work Chunk 4: Mode And Autonomy Semantics

Goal: stop plan mode from over-asking in read-only research flows.

Scope:

- Clarify plan-mode behavior once read-only evidence exists.
- Ensure capability-loss downgrades do not remove stored-evidence recovery.
- Define when `ask_user` is invalid because the missing input is internally recoverable.
- Allow read-only research to continue to synthesis without extra permission when the user has already asked for the answer.

Done when:

- Plan mode may still explain planned work, but it does not keep stopping after evidence is collected.
- Capability narrowing preserves artifact read/recovery capability.
- User final-answer intent overrides continuation-style prompting for collected read-only evidence.

## Work Chunk 5: TUI Presentation And Operator UX

Goal: remove transcript noise and expose useful state.

Scope:

- Hide or move reasoning rows such as `I finished the execution path...` out of the main chat transcript.
- Suppress process/meta answers unless explicitly requested.
- Add evidence-collected status: source count, artifact count, and last relevant source when available.
- Add operator affordances for viewing collected evidence and synthesizing from prior results.
- Improve loop/stall messages for users.

Done when:

- Main transcript output is focused on the user task.
- Operators can see that evidence exists without reading runtime logs.
- Loop/stall messages are useful for recovery rather than just explaining internal state.

## Work Chunk 6: Retrieval Quality And Source Discipline

Goal: reduce repeated broad searches and preserve high-value sources.

Scope:

- Prefer extracting known-good URLs over broad reruns.
- De-duplicate repeated source results.
- Preserve source variety intentionally across local TV, newspaper, public radio, and primary government sources when available.
- Track which query produced each source.
- Avoid broad mayor/council reruns once concrete local articles exist.

Done when:

- Retrieval iterations add clear new evidence or pivot to extraction.
- Noisy broad searches are not repeated after useful local sources are already collected.
- The evidence set remains explainable through query/result lineage.

## Work Chunk 7: Regression And Observability Suite

Goal: lock down this failure class.

Scope:

- Add a compacted-session regression: persisted tool outputs, compacted context with artifact IDs, final-answer request.
- Assert no `if you want`, no pasted-snippet request, and no generic reretrieval.
- Assert the answer uses source titles/URLs from stored artifacts.
- Add telemetry when artifact IDs exist but are not loaded.
- Add run classification for completed but non-substantive answers.

Done when:

- The test suite fails if a compacted final-answer request cannot recover stored evidence.
- Observability can distinguish missing evidence from missing evidence access.
- Completed runs can be audited for substantive-answer failures.

## Delivery Order

1. Durable Evidence Recovery
2. Final Answer Contract
3. Research Stall And Loop Recovery
4. Regression And Observability Suite
5. Mode And Autonomy Semantics
6. TUI Presentation And Operator UX
7. Retrieval Quality And Source Discipline

The first three chunks are the core runtime fix. TUI and retrieval quality work improve the experience, but they do not solve the root failure without artifact recovery and final-answer semantics.

## Non-Goals

- Do not tune search result thresholds as the primary fix.
- Do not add new lexical heuristics for detecting dissatisfaction or final-answer intent without explicit approval.
- Do not make broad retrieval loops more permissive.
- Do not weaken artifact verification or finalization contracts.

## Validation Gates

- `pnpm run governance:check`
- Focused unit/integration tests for artifact read/list, context rehydration, final-answer routing, and research-stall recovery.
- `pnpm run test`
- `pnpm run prompt-suite`
- For runtime/core changes, `pnpm run evals:release-check`
