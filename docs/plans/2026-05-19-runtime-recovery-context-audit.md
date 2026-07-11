---
id: runtime-recovery-context-audit-2026-05-19
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-03
depends_on:
  - ../PLANS.md
  - ../../src/engine/ExecutionEngine.ts
  - ../../agents/reference-react/src/context/ContextBuilder.ts
  - ../../agents/reference-react/src/modelInputBoundary.ts
---

# Runtime Recovery Context Audit

See also: [Plans index](../PLANS.md).

## Goal

Ensure every recoverable runtime/control-plane failure becomes structured, durable, fresh context for the next model decision.

The invariant for this audit is:

> If runtime logic knows a concrete action failed, stalled, was rejected, or is waiting, the next deliberator input must show what happened, where it happened, and what should not be blindly repeated.

## Bug Taxonomy

| Class | Meaning |
| --- | --- |
| `detection_only` | Runtime detects a condition, but recovery handling never receives it. |
| `persistence_gap` | Recovery computes a useful diagnostic, but session state loses it. |
| `context_gap` | Session state has the fact, but deliberator/model input omits it. |
| `precedence_bug` | Older summary state overrides newer runtime diagnostics. |
| `resume_bug` | Wait/resume clears or bypasses the recovery fact. |
| `test_illusion` | Tests assert terminal status but not next-turn model context. |

## Recovery Context Matrix

| Slice | Detector / Source | Classification | Persisted State | Model-Visible Context | Audit Result |
| --- | --- | --- | --- | --- | --- |
| Loop guards and repetition guards | `ExecutionEngine.applyRuntimeStateGuards` throws `LOOP_GUARD_TRIGGERED`; max-step recovery uses loop history. | Recoverable when a concrete loop target exists; otherwise wait for narrower instruction. | `state.agent.loopStall`, `state.agent.wait`, `state.agent.terminal`, run events. | `deliberationFacts.loopAndRecovery.loopStateSummary`, now also `loopStall` and `activeWait`. | Fixed first-pass `detection_only`, `precedence_bug`, and structured `context_gap` for dispatch loop guards. |
| Tool action validation feedback | Deliberator ingestion and action validation reject malformed or stale action shapes. | Recoverable validation feedback to `agent.loop`. | `state.agent.retryContext.failure`, validation observation, failed `lastActionResult`. | `deliberationFacts.loopAndRecovery.validationFeedback`, latest result, and situation text. | Fixed second-pass `context_gap`: rejected path, reason, tool, value, and retry attempt are now structured model facts. |
| Tool execution failures | `agent.exec.dispatch` and wait/collect paths record failed tool outcomes. | Recoverable for many read-only failures; terminal for non-recoverable side effects. | `state.agent.lastActionResult`, evidence ledger, exec substate. | `deliberationFacts.latestResult.lastActionResult`. | Covered at a basic level; follow-up should verify failed action name, input hash, error code, and retry constraint survive compaction. |
| Tool batch partial failures | Batch wait/collect records settled and failed items. | Recoverable when batch evidence can return to deliberation. | `state.agent.lastActionResult.items`, pending batch state, evidence ledger. | Latest result and evidence context. | Needs follow-up vertical test for partial failures becoming per-item recovery facts. |
| Cached/deduped result handling | Dispatch reuse guard and duplicate read-only result detection. | Recoverable until reuse becomes no-progress. | `state.agent.exec.dispatchReuseGuard`, `lastActionResult.reused`, duplicate metadata. | `deliberationFacts.loopAndRecovery.repetitionSignals.latestDuplicateResult`, repetition signals, and latest result. | Fixed third-pass `context_gap`: duplicate verdicts now carry kind, tool, fingerprint/count, prior step, canonical URL/source, and an explicit non-repeat constraint into model input. |
| Approval, wait, and resume flows | Runtime `WAITING` transitions, action/user waits, resume handlers. | User/approval/effect wait; resume should preserve reason until resolved. | `state.agent.nextAction.waitFor`, `state.agent.exec.waitingForUser`, `state.agent.wait`, `state.agent.terminal`. | Now `deliberationFacts.loopAndRecovery.activeWait`. | Fixed first-pass `context_gap` for active wait state; review pass aligned `activeWait` extraction with the real wait precedence. Follow-up simplification introduced `src/runtime/waitState.ts` as the shared reader/token helper for `nextAction.waitFor`, `exec.waitingForUser`, and `wait`. |
| Finalization blockers | Evidence ledger and finalization support derivation. | Block finalization when required evidence is unresolved. | Evidence ledger entries and support/blocker ids. | `deliberationFacts.blockers.finalizationBlockers`. | Existing model boundary coverage is good; follow-up should test blocker precedence against stale success summaries. |
| Session-note continuation and handoff | Deliberator imports session-scoped note context and continuation replies. | Continue or ask for narrower instruction. | Session-note fact and wait/continuation state. | `deliberationFacts.planDocument`, `activeWait`, latest result. | First-pass active wait fact improves handoff recovery. Follow-up should test note-handoff waits include the exact session path and resume step. |
| Observer judgment precedence | Context builder chooses loop/recovery summaries from agent state. | Fresh runtime diagnostics should beat older observer summaries. | `loopStall`, `loopState`, `observerJudgment`. | `loopStateSummary`, `loopStall`. | Fixed first-pass precedence: `loopStall` wins over stale observer judgment. |

## First-Pass Fixes

- Dispatch-level loop guards for `agent.exec.dispatch` now route through loop-stall recovery when they are exact `IDENTICAL_CONTROL_STATE` or `NO_PROGRESS_REASONING_LOOP` guards.
- Loop-stall recovery persists the actual guard details and emits `loop.guard_triggered` evidence before returning a user wait.
- Context assembly now prefers `state.agent.loopStall` over older `loopState` or `observerJudgment`.
- Deliberator model input now receives structured `loopStall` and `activeWait` facts under `deliberationFacts.loopAndRecovery`.
- Validation feedback now has a dedicated structured recovery fact under `deliberationFacts.loopAndRecovery.validationFeedback`, sourced from `state.agent.retryContext.failure`.
- Active wait context now uses the same wait-source precedence as the deliberator resume path.
- Duplicate executed/cached-result verdicts now surface as `repetitionSignals.latestDuplicateResult` with a deterministic non-repeat constraint.
- Wait state readers now share `readActiveWaitState(...)` and `buildWaitResumeToken(...)` instead of separately interpreting top-level `wait`, `exec.waitingForUser`, and action `waitFor` in context, deliberation, CLI/operator, diagnostics, scratchpad, reasoning, region scheduling, and resume logging paths.

## Follow-Up Candidates

- Add a tool-batch partial-failure test proving failed item diagnostics survive into model input.
- Add a resume test proving recovery diagnostics are preserved until the first post-resume deliberator turn.

## Validation

- Targeted context/model boundary tests must assert `detector -> persisted state -> context builder -> model input`.
- Runtime/core changes must run targeted unit tests, `pnpm run governance:check`, `pnpm run prompt-suite`, `pnpm run evals:release-check`, and the full `pnpm run test` gate before handoff.
