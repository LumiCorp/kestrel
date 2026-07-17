---
id: transcript-first-agent-runtime-refactor-2026-07-06
domain: runtime
status: completed
owner: kestrel-runtime
last_verified_at: 2026-07-06
depends_on:
  - ../PLANS.md
  - ../../src/runtime/modelTranscript.ts
  - ../../src/runtime/agent-context/assembleContext.ts
  - ../../agents/reference-react/src/steps/deliberator.ts
  - ../../src/engine/LoopGuardCoordinator.ts
---

# Transcript-First Agent Runtime Refactor

See also: [Plans index](../PLANS.md).

## Purpose / Big Picture

Simplify Kestrel's agent runtime so durable task continuity comes from the model-visible transcript/history rather than a separately recomputed `agent.goal`. The target architecture should look closer to best-in-class coding agents: append user turns, append tool calls and tool results, send full or compacted history back to the model, and stop on a final assistant answer.

This is a hard refactor. The goal is not to add another recovery branch around the latest failure. The goal is to delete, demote, or narrow semantic side state that can fight the transcript.

## Context and Orientation

- User turn entry starts in `cli/app/TuiRunController.ts`, which chooses `user.message` or a pending wait event and forwards UI transcript/history.
- Runtime turn materialization happens in `src/runtime/RuntimeTurn.ts`, which emits the event payload consumed by the kernel.
- The threaded runtime wrapper is `src/runtime/RuntimeThreadedTurnExecutor.ts`.
- Agent state persistence and validation live in `src/runtime/state.ts` and `src/store/PostgresSessionStore.ts`.
- The current deliberator computes a separate `goal` in `agents/reference-react/src/steps/deliberator.ts` before building model context.
- Transcript assembly lives in `src/runtime/modelTranscript.ts` and `src/runtime/agent-context/assembleContext.ts`.
- Blocker control surfaces currently include `kestrel.cannot_satisfy`, `kestrel.finalize` status `policy_blocked`, and decision policy in `agents/reference-react/src/policy/DecisionPolicy.ts`.
- Loop guard feedback is normalized in `src/engine/ExecutionEngineSupport.ts`.

## Progress

- [x] Read the implementation objective.
- [x] Confirmed the current code already has a transcript builder but still feeds it a preselected `goal`.
- [x] Characterize observed failures with regression tests.
- [x] Make transcript/context assembly authoritative for task continuity.
- [x] Demote `agent.goal` from primary task intent in model context and adjacent report/wait surfaces.
- [x] Collapse build-mode synthetic blocker behavior when executable tools are available.
- [x] Re-scope loop guard away from policy-feedback traps while preserving concrete tool-input repair paths.
- [x] Run required gates.

## Surprises & Discoveries

- `src/runtime/agent-context/assembleContext.ts` is already a useful central context builder. The issue is that it receives `goal` from upstream and renders that as `taskInstruction`, so it can faithfully preserve the wrong active task.
- `appendUserTurnToTranscript` currently deduplicates by content across the whole transcript. That is useful for retry idempotence but could hide repeated user turns if the same message is intentionally sent twice.
- Ordinary active tasks should not be duplicated as both runtime context `Task:` and a transcript user message. The transcript user item is enough; runtime context keeps expanded benchmark task guidance only when it differs from the active user task.
- Bootstrapped `user.reply` turns may have no persisted transcript yet. In that compatibility case, the reply handler must preserve the resume/original task instead of treating the reply text as the whole task.
- A hidden retry validator for build-mode `policy_blocked` was the wrong direction. The better fix is to remove that terminal option from the model-visible finalize schema when build-mode executable tools are available.
- Loop guard conversion for missing filesystem paths depends on concrete `TOOL_INPUT_INVALID` path details. Those concrete details are still useful. Repeated generic validation feedback should not become the loop guard's headline diagnosis.
- Context compaction is also a model call. It must read the active task from the transcript-backed context request, not from the pre-context `goal` variable, or compaction can reintroduce stale follow-up text as the task instruction.
- Transcript compaction must also preserve the first user task item itself. Otherwise the next turn can make a retained follow-up user item look like the active task.

## Decision Log

- Prefer improving the existing transcript builder over introducing a new contract layer.
- Treat `agent.goal` as legacy/display compatibility during the first implementation pass; do not rely on it as the authoritative model task.
- Avoid heuristic intent classification. Follow-up continuity should come from transcript order and session state, not keyword matching.
- Keep TUI wait semantics intact: `user.reply` continues to answer explicit wait states, while fresh `user.message` appends as a normal turn.
- The first non-empty user item in the model transcript is the active task for ordinary sessions.
- Runtime context omits `Task:` when the transcript already carries the active task. It still renders `Task:` for benchmark-expanded instructions and legacy sessions without a transcript user item.
- Bootstrapped replies with no persisted transcript seed the original task as the first user transcript item before appending the live reply.
- Compacted transcripts retain the first non-empty user item plus the provider-valid tail, so the active-task reader can stay simple.
- In build mode with executable workspace tools available, the model-visible control surface omits `kestrel.cannot_satisfy`, and `kestrel.finalize.status` is narrowed to `goal_satisfied | out_of_scope`.
- Compatibility/reporting surfaces that still need a goal value now prefer transcript active task before legacy `agent.goal`: ask-user resume metadata, cannot-satisfy/finalize report data, plan-handoff wait metadata, working memory recall, blocked-resume fallback, post-tool recovery summaries, and workspace scratchpad.
- Repeated no-progress reasoning loops stay mechanical: `NO_PROGRESS_REASONING_LOOP` reports threshold/action/evidence hashes. Concrete `TOOL_INPUT_INVALID` path details are retained only because they drive the existing targeted repair wait.

## Milestones

### 1. Characterize Current Behavior

Observed wrong behavior addressed:
- A follow-up message replaced the original build task.
- Empty workspace became a blocker despite scaffold-capable tools.
- Rejected `cannot_satisfy` escaped through `policy_blocked` or loop guard.
- Existing `ask_user` / `user.reply` resume behavior is narrower and should remain covered.

Likely files:
- `tests/unit/agent-loop-step.test.ts`
- `tests/unit/kestrel-agent-context-builder.test.ts`
- `tests/unit/compile-intent-executable-actions.test.ts`

### 2. Make Transcript Assembly Authoritative

Observed wrong behavior addressed:
- Latest user text becoming the whole task.

Owning surface:
- `src/runtime/agent-context/assembleContext.ts`
- `agents/reference-react/src/steps/deliberator.ts`

Implementation direction:
- Build model-visible task continuity from transcript/history first.
- Append fresh user turns into transcript before model request.
- Derive `taskInstruction` from transcript active task when available, not from the latest payload message.

### 3. Demote `agent.goal`

Observed wrong behavior addressed:
- Side-state goal drift from visible conversation.

Owning surface:
- `agents/reference-react/src/steps/deliberator.ts`
- `src/runtime/state.ts`
- tests that assert goal-first behavior.

Implementation direction:
- Stop writing fresh `agent.goal` from latest user message.
- Keep reads only where compatibility requires it.
- Document any remaining usage in this plan before leaving it.

### 4. Collapse Blocker Semantics

Observed wrong behavior addressed:
- `cannot_satisfy` rejection falling through to `policy_blocked`.

Owning surface:
- `agents/reference-react/src/policy/DecisionPolicy.ts`
- `agents/reference-react/src/modelToolCallActions.ts`
- `src/runtime/agent-context/toolContext.ts`

Implementation direction:
- In build mode, real blockers should be concrete tool/runtime/permission evidence or ordinary assistant final text.
- Narrow `cannot_satisfy` and `policy_blocked` so they cannot form a semantic control plane parallel to tools.

### 5. Re-Scope Loop Guard

Observed wrong behavior addressed:
- Policy-feedback loops becoming the first meaningful user-facing diagnosis.

Owning surface:
- `src/engine/ExecutionEngineSupport.ts`
- loop guard tests.

Implementation direction:
- Keep repeated mechanical action/result detection.
- Stop treating repeated policy feedback as if it were equivalent to repeated tool/action behavior.

### 6. Cleanup and Convergence

Observed wrong behavior addressed:
- Both goal-first and transcript-first systems living side by side.

Implementation direction:
- Delete dead branches and obsolete assertions.
- Prefer fewer model-facing control tools and fewer hidden state paths.

## Concrete Steps

1. Add failing characterization tests for the Chirp follow-up sequence.
2. Add/adjust blocker tests to prove `policy_blocked` cannot bypass available tool evidence.
3. Teach context assembly to preserve an existing transcript active task when the latest message is a follow-up. Done.
4. Update deliberator goal selection to stop preferring the latest message over transcript state. Done.
5. Narrow build-mode blocker control behavior. Done by model-visible tool surface shaping, not hidden semantic retry policy.
6. Demote adjacent `agent.goal` consumers that affect waits, final reports, scratchpads, blocked resume, and recovery summaries. Done.
7. Keep loop guard mechanical while preserving concrete tool-input repair paths. Done.
8. Keep context compaction transcript-first by deriving its maintenance task instruction from the context request transcript. Done.
9. Preserve the first user task through compaction and seed it before bootstrapped replies. Done.
10. Run targeted tests after each coherent change. Done for the current slice.
11. Run required gates and record results.

## Validation and Acceptance

Targeted tests:
- `node --import tsx --test tests/unit/agent-loop-step.test.ts`
- `node --import tsx --test tests/unit/kestrel-agent-context-builder.test.ts`
- `node --import tsx --test tests/unit/compile-intent-executable-actions.test.ts`
- `node --import tsx --test tests/unit/execution-loop-guard.test.ts tests/unit/finalize-payload.test.ts tests/unit/terminal-control-transcript.test.ts tests/unit/model-transcript.test.ts tests/unit/kestrel-agent-context-builder.test.ts tests/unit/agent-loop-step.test.ts tests/unit/compile-intent-executable-actions.test.ts`

Latest targeted result:
- `node --import tsx --test tests/unit/model-transcript.test.ts tests/unit/kestrel-agent-context-builder.test.ts tests/unit/agent-loop-step.test.ts`
- Result after active-task durability fix: 135 tests, 135 pass, 0 fail.
- `node --import tsx --test tests/unit/agent-loop-step.test.ts`
- Result after compaction fix: 83 tests, 83 pass, 0 fail.
- `node --import tsx --test tests/unit/execution-loop-guard.test.ts tests/unit/finalize-payload.test.ts tests/unit/terminal-control-transcript.test.ts tests/unit/model-transcript.test.ts tests/unit/kestrel-agent-context-builder.test.ts tests/unit/agent-loop-step.test.ts tests/unit/compile-intent-executable-actions.test.ts`
- Result: 235 tests, 235 pass, 0 fail.

Required final gates:
- `pnpm run governance:check`
- `pnpm run test`
- `pnpm run prompt-suite`
- `pnpm run evals:release-check`

Latest required-gate result:
- `pnpm run governance:check`: failed on four stale documents outside this slice:
  `docs/cli/contract-matrix.md`, `docs/cli/workspaces.md`,
  `docs/plans/2026-05-20-managed-worktree-source-promotion-design.md`, and a
  since-retired runtime-turn-coordinator shell-parity record.
- `CI=true pnpm run test`: passed after the active-task durability fix. Core TAP summaries include
  2112/2112 pass, 262/262 pass, 97/97 pass, 60/60 pass, 17/17 pass, 13/13 pass, 5/5 pass,
  and 5/5 pass; package suites finished with 351 test files passed, 3 skipped, 1646 tests passed,
  and 7 skipped.
- `CI=true pnpm run prompt-suite`: passed 84/84, passRate 1, composite 97.
- `CI=true pnpm run evals:release-check`: passed all 16 evaluation cases.

Acceptance:
- Observed failures are covered by tests.
- Follow-up messages append to transcript and no longer replace the original active task.
- Build-mode synthetic blockers cannot bypass available tool evidence.
- `agent.goal` no longer drives model task selection except documented legacy/display compatibility.
- The final diff removes or narrows old semantic machinery instead of adding another layer.

## Idempotence and Recovery

- The plan is append/update friendly. Each milestone should update this file with progress, surprises, and validation evidence.
- Tests should be written as stable characterization rather than relying on the developer's local session database.
- Existing dirty worktree changes must not be reverted unless explicitly requested.
- If a milestone exposes unrelated failures, record them separately and keep the transcript-first changes scoped.

## Outcomes & Retrospective

Current slice outcome:
- Follow-up user messages append to transcript and no longer replace the original active task in model context.
- Bootstrapped replies now persist the original task before the reply, so the next turn still reads the original task as active.
- Stale `agent.goal` no longer wins over transcript task in the main adjacent runtime surfaces that shape waits, final output metadata, recovery summaries, working memory, or scratchpad text.
- Context compaction now uses the transcript active task instead of the pre-context goal fallback and preserves the first user task item in the compacted transcript.
- Build-mode synthetic blockers are removed from the model-visible tool surface when executable tools are present.
- Loop guard remains a mechanical repeated-state detector rather than a policy-feedback diagnosis path. Concrete invalid tool-input details remain available for existing path-repair waits.

Compatibility retained by design:
- `agent.goal` still exists as legacy/display state for older sessions, wait metadata, autonomy evidence labels, and fallback paths when no transcript user item exists yet. Those reads are compatibility fallbacks; model context and compaction now prefer transcript active task first.
- Some compile-policy validation still exists for boundary contracts and mode/tool safety; that was intentionally narrowed rather than deleted because it validates executable action contracts, not durable task continuity.

External open item:
- `pnpm run governance:check` still fails on unrelated stale-document freshness checks listed above. The runtime/test gates pass, but the broad governance gate is not green until those stale docs are refreshed.
