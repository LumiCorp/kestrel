---
id: reference-react-command-processor-milestones-2026-05-14
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../PLANS.md
  - ../adr/0001-reference-react-command-processor.md
  - ../../agents/reference-react/src/commandProcessor.ts
  - ../../src/orchestration/ThreadRuntime.ts
  - ../../src/replay/RunReplayService.ts
---

# Reference React Command Processor Milestones

This is the active milestone tracker for finishing the `reference-react` command-processor rewrite after the initial foundation described in the [command-processor ADR](../adr/0001-reference-react-command-processor.md). Keep this runtime work separate from unrelated TUI/controller refactor files, even when both are dirty in the same worktree.

Note: live runtime step IDs are `agent.loop` and `agent.exec.*`. Older ledger entries below may use legacy `react.*` step names as migration history.

## Current Baseline

- Turn records, turn segments, and hash-only model provenance have been introduced as durable runtime surfaces.
- [`ReferenceReactCommandProcessor`](../../agents/reference-react/src/commandProcessor.ts) exists as the intended command authority, but the legacy execution path still contains direct `reactState` mutation sites.
- Operator phase is currently a projection over stable step IDs; the step IDs themselves remain part of the replay compatibility contract.

## Milestones

### 1. Stabilize Current Foundation

- Keep turn/provenance/schema work passing.
- Keep runtime rewrite work separate from unrelated TUI/controller dirty work.
- Confirm the migration, ADR, glossary, and tests are part of the runtime branch before widening scope.

### 2. First Vertical Slice: `react.deliberate -> react.exec.dispatch`

- Preserve existing registered step IDs.
- Convert deliberator `nextAction` into a typed command batch.
- Route that batch through `ReferenceReactCommandProcessor`.
- Keep reads batchable and writes, shell effects, waits, and finalization as ordered checkpoints.

### 3. Processor Becomes Mutation Authority

- Move exec dispatch, wait, collect, and finalize state patches behind processor-owned command results.
- Stop adding direct `reactState` mutation sites.
- Preserve legacy compatibility only for replay and resume of older sessions.

### 4. Durable Working Plan And Narration Memory

- Make working-plan updates processor-authored and durable.
- Store progress narration as ordinary working memory.
- Ensure resumes carry the current chunk, blocker, and expected next command.

### 5. Operator Visibility

- Show phase, visible plan, current chunk, command batch, and wait reason in CLI and web surfaces.
- Keep operator phases projected over stable step IDs: `assemble -> decide -> act -> observe -> wait/finalize`.
- Keep final answers natural by default; provenance remains available through runtime inspection.

### 6. Inspection, Replay, And Guardrails

- Ensure doctor and replay expose turn and provenance records without raw prompt text.
- Add regression coverage for command ordering, resume segmentation, prompt hash stability, and operator state.
- Add a guard or invariant to prevent new scattered `reactState` mutation after migration.

## Validation

- Documentation-only updates should run `pnpm run governance:check`.
- Runtime milestone implementations should also run the relevant focused unit tests, then `pnpm run test`, `pnpm run prompt-suite`, and `pnpm run evals:release-check` before closeout.

## Progress Ledger

### 2026-05-14 - Milestone 1 foundation stabilized

Status: Complete for the current branch slice.

What was confirmed:

- Foundation artifacts are present: `CONTEXT.md`, the command-processor ADR, migration `020_turns_model_provenance.sql`, `ReferenceReactCommandProcessor`, and focused runtime tests.
- Turn/provenance records are wired through contracts, Postgres store, in-memory store, `ThreadRuntime`, `ExecutionEngine`, and `RunReplayService`.
- Runtime rewrite scope remains mixed in the worktree with unrelated TUI/controller and devshell edits; keep the next runtime milestone scoped to `reference-react` command processing and do not stage unrelated TUI/controller files with it.

Validation run:

- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/runtime-turn-provenance.test.ts tests/unit/run-replay-service.test.ts tests/unit/reference-react-stategraph.test.ts`
  - Result: 21 tests passed.

Next milestone:

- Start Milestone 2 with the first vertical slice: convert `react.deliberate` output into a typed command batch and route it into `react.exec.dispatch` through `ReferenceReactCommandProcessor`, while preserving existing registered step IDs.

### 2026-05-14 - Milestone 2 deliberator-to-exec vertical slice

Status: Complete for the current branch slice.

What changed:

- `react.deliberate` now persists a ready `commandBatch` beside the legacy `nextAction`, using the current tool capability manifest to classify read-only commands separately from ordered side-effect checkpoints.
- `ReferenceReactCommandProcessor` can derive a typed command batch from a `ReactAction` while preserving the registered step IDs and the existing `nextAction` contract for replay compatibility.
- `react.exec.dispatch` consumes a ready command batch once, records processor-owned `commandProcessor` and `workingPlan` state, marks the batch `processed`, emits the processor decision event, and then continues through the legacy execution reducer.
- Read-only tool batches remain batchable. Writes, shell work, external effects, waits, observations, and finalization remain ordered checkpoints.
- The full test gate exposed stale mountaintop prompt-lock assertions after the scenario contract moved from shell heredoc source edits to typed filesystem writes; the assertions now lock the current typed-filesystem contract.

Boundary kept for Milestone 3:

- This is a bridge slice, not the full mutation-authority migration. Exec collect, waits, finalize, and older legacy state patches still need to move behind processor-owned command results.
- Do not mix the Milestone 3 migration with the unrelated TUI/controller refactor files currently dirty in this worktree.

Validation run:

- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/runtime-turn-provenance.test.ts tests/unit/run-replay-service.test.ts tests/unit/reference-react-stategraph.test.ts tests/unit/compile-intent-required-capabilities.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 170 tests passed, 19 skipped.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx scripts/check-docs.ts`
  - Result: passed with existing no-link warnings.
- `git diff --check -- agents/reference-react/src/commandProcessor.ts agents/reference-react/src/steps/deliberator.ts agents/reference-react/src/steps/execStates.ts tests/unit/reference-react-command-processor.test.ts docs/plans/2026-05-14-reference-react-command-processor-milestones.md`
  - Result: passed.
- `pnpm run governance:check`
  - Result: passed with existing invariant warnings.
- `pnpm run test`
  - Result: passed after updating stale mountaintop prompt-lock assertions.
- `pnpm run prompt-suite`
  - Result: 78 passed, 0 failed.
- `pnpm run evals:release-check`
  - Result: 16 passed, 0 failed.

Next milestone:

- Start Milestone 3 by moving exec dispatch, wait, collect, and finalize state patches behind processor-owned command results, while keeping legacy compatibility only for replay and resume of older sessions.

### 2026-05-14 - Milestone 3 route-checkpoint slice started

Status: In progress.

What changed:

- Exec route-only transitions now use processor-owned checkpoint helpers for dispatch, wait, collect, and finalize routing state instead of hand-assembling those `reactState` patches in `execStates.ts`.
- The processor records the latest execution checkpoint under `commandProcessor.lastCheckpoint`, including substate, current step, next step, and step index.
- The processor updates durable working-plan status for routing checkpoints such as dispatching, waiting, collecting, and finalizing.
- Completed durable tool batches are cleared through the processor checkpoint helper when `react.exec.collect` moves to observation.
- `execStates.ts` still delegates acter reducer outputs through the compatibility wrapper, but the wrapper now applies execution substate normalization through the processor module instead of owning that state patch directly.

Boundary still open for Milestone 3:

- The large acter reducer still owns many direct state patches for tool dispatch, wait creation, effect collection, approval envelopes, user waits, and final answer payloads.
- The next Milestone 3 slice should move one acter-owned mutation family at a time behind processor result builders, starting with wait creation or effect collection.
- Legacy replay/resume compatibility paths should remain explicit until the scattered acter mutations are retired.

Validation run:

- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 22 tests passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/runtime-turn-provenance.test.ts tests/unit/run-replay-service.test.ts tests/unit/reference-react-stategraph.test.ts tests/unit/compile-intent-required-capabilities.test.ts tests/unit/runtime-state-machine-hardening.test.ts tests/unit/mountaintop-e2e.test.ts`
  - Result: 184 tests passed, 19 skipped.

Next milestone:

- Continue Milestone 3 by moving the first acter-owned mutation family behind processor-owned command results, with focused tests before widening the gate again.

### 2026-05-14 - Milestone 3 acter exec-patch bridge

Status: In progress.

What changed:

- The shared acter `withExecStatePatch` path now delegates exec-state merges to `applyReferenceReactExecPatch` in the processor module.
- This moves the common pending-effect, pending-approval, waiting-for-user, and pending-batch merge primitive behind the processor boundary without changing the individual acter transition builders yet.
- Added focused coverage for the processor-owned exec patch merge helper.

Boundary still open for Milestone 3:

- Individual acter transition builders still decide when to set or clear pending effect, approval, user wait, and finalization state.
- The next slice should replace one of those transition builders with an explicit processor result builder rather than only sharing merge mechanics.

Validation run:

- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 23 tests passed.

Next milestone:

- Continue Milestone 3 by moving a specific acter transition family, likely wait creation or effect collection, behind a processor-owned result builder.

### 2026-05-14 - Milestone 3 mode-blocked wait builder

Status: In progress.

What changed:

- Mode-blocked user waits now use `createReferenceReactWaitCheckpoint` from the processor module.
- The processor-owned wait checkpoint records `commandProcessor.lastCheckpoint`, working-plan waiting status, durable `waitingForUser`, prompt events, and active-region patches.
- All mode-policy blocked paths now pass step index into the wait checkpoint so resumes can point back to the exact execution checkpoint.
- Added focused coverage for processor-owned user waits with active-region state.

Boundary still open for Milestone 3:

- Approval waits, autonomy waits, effect dispatch, effect collection, and finalization still have acter-local transition builders.
- The next slice should move approval wait creation or effect collection into the same processor-owned result pattern.

Validation run:

- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/runtime-state-machine-hardening.test.ts tests/unit/compile-intent-required-capabilities.test.ts`
  - Result: 137 tests passed, 19 skipped.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/runtime-turn-provenance.test.ts tests/unit/run-replay-service.test.ts tests/unit/reference-react-stategraph.test.ts tests/unit/compile-intent-required-capabilities.test.ts tests/unit/runtime-state-machine-hardening.test.ts tests/unit/mountaintop-e2e.test.ts`
  - Result: 186 tests passed, 19 skipped.

Next milestone:

- Continue Milestone 3 by moving approval wait creation or effect collection behind a processor-owned result builder.

### 2026-05-14 - Milestone 3 approval wait builder

Status: In progress.

What changed:

- Per-call approval waits now use `createReferenceReactWaitCheckpoint` instead of hand-assembling `WAITING` transitions and `pendingApproval` state in the acter reducer.
- Autonomy escalation approval waits now use the same processor-owned wait checkpoint path.
- The processor-owned approval checkpoint records `commandProcessor.lastCheckpoint`, `workingPlan.status = waiting`, `exec.substate = wait_approval`, the pending approval envelope, prompt events, and active-region exec patches.
- Added direct processor coverage for approval waits and strengthened the autonomy escalation test to assert processor-owned wait state.

Boundary still open for Milestone 3:

- Approval denials, effect dispatch, effect waits, effect collection, tool result collection, durable batch transitions, and finalization still have acter-local transition builders.
- The next slice should move effect waiting/dispatch or effect collection behind processor-owned result builders.

Validation run:

- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/runtime-state-machine-hardening.test.ts tests/unit/compile-intent-required-capabilities.test.ts`
  - Result: 167 tests passed, 19 skipped.

Next milestone:

- Continue Milestone 3 by moving the effect wait/dispatch transition family behind processor-owned checkpoint helpers, then widen to collection/finalization once the wait side is stable.

### 2026-05-14 - Milestone 3 effect wait and dispatch builders

Status: In progress.

What changed:

- Effect-result waits now use `createReferenceReactWaitCheckpoint` with `substate = wait_effect`, preserving pending effect state, pending action state, and active-region exec state through the processor.
- Added `createReferenceReactEffectDispatchCheckpoint` for ordered effect dispatch checkpoints.
- Single durable tool dispatch and explicit effect dispatch now use the processor-owned effect dispatch helper instead of hand-assembling pending effect state, emitted effects, and working-plan status.
- Execution substate normalization now keeps an existing `commandProcessor.lastCheckpoint` aligned with the routed exec substate and next step when exec routing moves a dispatch checkpoint into `react.exec.wait_effect`.
- Added focused tests for processor-owned effect waits and effect dispatch, plus runtime assertions that durable tool dispatch records processor-owned state.

Boundary still open for Milestone 3:

- Durable batch dispatch, effect collection, approval denial, user-wait resume, tool-result collection, durable batch collection, and finalization still have acter-local transition builders.
- The next slice should move effect collection or durable batch dispatch behind processor-owned result builders.

Validation run:

- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 60 tests passed.

Next milestone:

- Continue Milestone 3 by moving effect collection behind a processor-owned result builder, then follow with durable batch dispatch/collection.

### 2026-05-14 - Milestone 3 non-tool effect collection builder

Status: In progress.

What changed:

- Added `createReferenceReactEffectCollectCheckpoint` for processor-owned collection checkpoints.
- Non-tool effect result collection now routes through the processor helper, including `lastActionResult`, pending effect cleanup, active-region state, `commandProcessor.lastCheckpoint`, and collecting working-plan status.
- Added direct processor coverage for effect collection and runtime coverage for `react.exec.wait_effect` collecting a non-tool effect result.

Boundary still open for Milestone 3:

- Tool-result collection, durable batch dispatch/collection, user-wait resume, approval denial, and finalization still have acter-local transition builders.
- The next slice should move durable batch dispatch first because it shares the effect dispatch semantics already introduced.

Validation run:

- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 62 tests passed.

Next milestone:

- Continue Milestone 3 by routing durable batch dispatch through the processor-owned effect dispatch checkpoint.

### 2026-05-14 - Milestone 3 durable batch dispatch builder

Status: In progress.

What changed:

- Durable batch dispatch now uses `createReferenceReactEffectDispatchCheckpoint` for the next side-effecting batch item.
- The processor now records pending batch state, pending item state, pending effect state, active-region exec state, emitted effect, and execution checkpoint metadata for durable batch dispatch.
- Added runtime coverage for `react.exec.dispatch` routing a multi-item durable batch through processor-owned effect dispatch.

Boundary still open for Milestone 3:

- Durable batch collection, user-wait resume, ordinary `ask_user` wait creation, approval denial, tool-result collection, and finalization still have acter-local transition builders.
- The next slice should finish ordinary user wait creation so all wait-family pauses use the processor-owned wait checkpoint.

Validation run:

- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 63 tests passed.

Next milestone:

- Continue Milestone 3 by routing ordinary `ask_user` wait creation through `createReferenceReactWaitCheckpoint`.

### 2026-05-14 - Milestone 3 ordinary user wait builder

Status: In progress.

What changed:

- Model-authored `ask_user` waits now use `createReferenceReactWaitCheckpoint`.
- Ordinary user waits now record processor-owned `waitingForUser`, `commandProcessor.lastCheckpoint`, waiting working-plan state, prompt events, and active-region exec state through the same path as mode-blocked waits.
- Added runtime coverage for `react.exec.dispatch` producing processor-owned `ask_user` wait state.

Boundary still open for Milestone 3:

- User-wait resume, approval denial, tool-result collection, durable batch collection, and finalization still have acter-local transition builders.
- The next slice should either move user-wait resume behind a processor-owned collect/resume helper or start the finalization transition helpers.

Validation run:

- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 64 tests passed.

Next milestone:

- Continue Milestone 3 by moving user-wait resume or finalization behind processor-owned result builders.

### 2026-05-14 - Milestone 3 finalization builder

Status: In progress.

What changed:

- Added `createReferenceReactFinalizeCheckpoint` for processor-owned completed transitions.
- Normal finalization and `cannot_satisfy` finalization now use the finalize checkpoint helper while preserving the existing finalize payload, artifact assembly, follow-up contract, and completion events.
- The helper records `commandProcessor.lastCheckpoint`, finalizing working-plan state, final output state, exec cleanup, and active-region patches.
- Added direct processor coverage for finalization and strengthened finalize artifact tests to assert processor-owned checkpoint state.

Boundary still open for Milestone 3:

- User-wait resume, approval denial, tool-result collection, durable batch collection, and read-only inline batch collection still have acter-local transition builders.
- The next slice should move one collection path at a time, starting with durable batch collection or approval denial cleanup.

Validation run:

- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/react-acter-code-artifacts.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 88 tests passed.
- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/runtime-turn-provenance.test.ts tests/unit/run-replay-service.test.ts tests/unit/reference-react-stategraph.test.ts tests/unit/compile-intent-required-capabilities.test.ts tests/unit/runtime-state-machine-hardening.test.ts tests/unit/mountaintop-e2e.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/react-acter-code-artifacts.test.ts`
  - Result: 250 tests passed, 19 skipped.
- `node --import tsx scripts/check-docs.ts`
  - Result: passed with existing no-link warnings.
- `git diff --check -- agents/reference-react/src/commandProcessor.ts agents/reference-react/src/steps/acter.ts tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/react-acter-code-artifacts.test.ts docs/plans/2026-05-14-reference-react-command-processor-milestones.md`
  - Result: passed.
- `pnpm run governance:check`
  - Result: passed with existing invariant warnings.
- `pnpm run prompt-suite`
  - Result: 78 passed, 0 failed.
- `pnpm run evals:release-check`
  - Result: 16 passed, 0 failed.
- `pnpm run test`
  - Result: passed.

Next milestone:

- Continue Milestone 3 by moving durable/tool result collection paths behind processor-owned result builders without changing result shaping.

### 2026-05-14 - Milestone 3 durable batch collection builder

Status: In progress.

What changed:

- Durable batch collection now uses `createReferenceReactEffectCollectCheckpoint` for both partial collection and final batch collection.
- The processor-owned collection checkpoint records completed batch items, pending-batch advancement, pending effect cleanup, active-region patches, artifacts, `commandProcessor.lastCheckpoint`, and `workingPlan.status = collecting`.
- Final durable batch collection now records the caller's current step in the checkpoint instead of hard-coding a wait-effect source step.
- Strengthened durable batch runtime coverage to assert processor-owned collection state after recoverable filesystem failures.

Boundary still open for Milestone 3:

- Single durable tool-result collection, inline read-only tool collection, user-wait resume, and approval denial still have acter-local transition builders.
- The next slice should move the single durable tool-result collection path behind `createReferenceReactEffectCollectCheckpoint`, because it shares the result shaping and observation handoff already used by durable batch collection.

Validation run:

- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 65 tests passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.

Next milestone:

- Continue Milestone 3 by routing single durable tool-result collection through the processor-owned effect collection checkpoint, preserving evidence/result shaping exactly.

### 2026-05-14 - Milestone 3 single durable tool collection builder

Status: In progress.

What changed:

- Single durable tool-result collection now uses `createReferenceReactEffectCollectCheckpoint`.
- Existing result shaping is preserved: tool artifacts, large-output artifact/digest handling, capability evidence, post-tool verification, duplicate-result evidence, devshell state patches, and observer handoff remain unchanged.
- The collection checkpoint now owns pending durable tool cleanup, active-region state patches, `commandProcessor.lastCheckpoint`, and `workingPlan.status = collecting`.
- Strengthened the durable wait-effect artifact failure test to assert processor-owned collection state for single durable tools.

Boundary still open for Milestone 3:

- Inline read-only tool collection, inline read-only batch collection, user-wait resume, and approval denial still have acter-local transition builders.
- The next slice should move inline read-only tool collection or user-wait resume behind processor-owned helpers. Inline read-only paths are larger because they execute in-process instead of through durable effect checkpoints.

Validation run:

- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 65 tests passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.

Next milestone:

- Continue Milestone 3 by moving the user-wait resume path or inline read-only tool collection behind processor-owned result builders.

### 2026-05-14 - Milestone 3 user-wait resume checkpoint

Status: In progress.

What changed:

- User reply resume now routes through a processor-owned collection checkpoint instead of hand-building the `ask_user.resume` state patch.
- The checkpoint records the user reply as `lastActionResult`, clears `exec.waitingForUser`, preserves the effective deliberation route, and records `commandProcessor.lastCheckpoint` with the current wait-user step.
- Strengthened the wait-user resume test to assert the stored reply, cleared wait state, processor checkpoint, and working-plan status.

Boundary still open for Milestone 3:

- Inline read-only tool collection, inline read-only batch collection, and approval denial still have acter-local transition builders.
- The next slice should move inline read-only tool collection behind a processor-owned collection checkpoint, then handle read-only batch collection.

Validation run:

- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 65 tests passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.

Next milestone:

- Continue Milestone 3 by routing inline read-only tool collection through the processor-owned collection checkpoint without changing inline execution behavior.

### 2026-05-14 - Milestone 3 inline read-only tool collection builder

Status: In progress.

What changed:

- Inline read-only tool collection now uses `createReferenceReactEffectCollectCheckpoint` instead of hand-building the observation transition.
- Existing inline behavior is preserved: no durable effect is emitted, recoverable read failures remain evidence, tool result shaping stays unchanged, and observer handoff still routes through `react.exec.collect`.
- The processor now owns the inline tool collection checkpoint, active-region patches, pending approval/tool cleanup, dispatch reuse guard cleanup, `commandProcessor.lastCheckpoint`, and collecting working-plan state.
- Strengthened the inline missing-artifact read test to assert processor-owned collection state.

Boundary still open for Milestone 3:

- Inline read-only batch collection and approval denial still have acter-local transition builders.
- The next slice should move inline read-only batch collection behind processor-owned collection checkpoints, preserving checkpoint chunking and recoverable read-failure behavior.

Validation run:

- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 65 tests passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.

Next milestone:

- Continue Milestone 3 by routing inline read-only batch collection through processor-owned collection checkpoints.

### 2026-05-14 - Milestone 3 inline read-only batch collection builder

Status: In progress.

What changed:

- Inline read-only batch collection now uses `createReferenceReactEffectCollectCheckpoint` for chunk collection.
- Existing batch behavior is preserved: read-only items still execute in parallel within the chunk, recoverable filesystem read failures are captured as evidence, checkpoint chunking still advances `pendingBatch`, and final chunks still hand off through `react.exec.collect`.
- The processor now owns inline batch collection state, active-region patches, pending batch advancement/cleanup, `commandProcessor.lastCheckpoint`, and collecting working-plan state.
- Strengthened recoverable read-only batch coverage to assert processor-owned collection state.

Boundary still open for Milestone 3:

- Approval denial is the remaining obvious acter-local transition builder in this milestone's mutation-authority pass.
- After approval denial, run the broader focused runtime suite and docs/diff checks before deciding whether Milestone 3 is ready for the full gates again.

Validation run:

- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 65 tests passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.

Next milestone:

- Continue Milestone 3 by moving approval denial cleanup behind a processor-owned checkpoint.

### 2026-05-14 - Milestone 3 approval denial checkpoint

Status: Complete for the current mutation-authority pass.

What changed:

- Per-call approval denial now uses a processor-owned collection checkpoint instead of hand-building the denial transition.
- The checkpoint records the denied approval result, clears `exec.pendingApproval`, preserves the deliberation route after denial, and records the current wait-approval step in `commandProcessor.lastCheckpoint`.
- Added a two-step regression test that first creates the real pending approval envelope, then resumes through `react.exec.wait_approval` with a denial event and asserts the processor-owned cleanup.

Boundary after this pass:

- The main dispatch, wait, collect, and finalize mutation families have processor-owned checkpoint builders.
- Legacy compatibility and smaller helper-local patch calls remain for replay/resume normalization and shared patch merging, but new behavior should use processor-owned helpers rather than adding scattered `reactState` mutation sites.
- The next Milestone 3 hardening step should add an invariant/guard against new scattered mutation sites, then broaden verification before moving to Milestone 4.

Validation run:

- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 66 tests passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.

Next milestone:

- Add the Milestone 3 guard/invariant that catches new scattered `reactState` mutation sites before proceeding to durable working-plan and narration-memory work.

### 2026-05-14 - Milestone 3 cached reuse collection builder

Status: Complete for the current mutation-authority pass.

What changed:

- Cached read-only tool reuse now uses `createReferenceReactEffectCollectCheckpoint` instead of hand-building the observation transition.
- Existing reuse behavior is preserved: the tool is not called, duplicate cached evidence is recorded, dispatch reuse guard state is advanced, and observer handoff still routes through `react.exec.collect`.
- Strengthened cached-reuse coverage to assert processor-owned collection state.

Validation run:

- `node --import tsx --test tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 66 tests passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.

### 2026-05-14 - Milestone 3 mutation-authority guard

Status: Complete for the current mutation-authority pass.

What changed:

- Added governance invariant `reference-react-command-processor-mutation-authority`.
- The invariant fails on direct `Transition.statePatch` assembly in `agents/reference-react/src/steps/acter.ts` and `agents/reference-react/src/steps/execStates.ts`.
- Added unit coverage proving the guard rejects direct execution state patches and permits command-processor checkpoint helper calls.
- Confirmed the current `acter.ts` and `execStates.ts` files no longer contain direct `statePatch:` transition assembly.

Boundary after this pass:

- Milestone 3's main mutation-authority rewrite is ready for full gates.
- Remaining legacy compatibility surfaces should stay explicit, but new execution behavior should be added through command-processor checkpoint helpers.
- Milestone 4 can start after full gates: durable working-plan updates and narration memory.

Validation run:

- `node --import tsx --test tests/unit/governance-invariants.test.ts tests/unit/reference-react-command-processor.test.ts tests/unit/acter-autonomy.test.ts tests/unit/exec-reasoning-narration.test.ts tests/unit/runtime-state-machine-hardening.test.ts`
  - Result: 71 tests passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `pnpm run check:invariants`
  - Result: passed with existing warning-level invariant output.

Next milestone:

- Run the required full gates for Milestone 3, then begin Milestone 4: durable working plan and narration memory.

### 2026-05-14 - Milestone 3 full-gate closeout

Status: Complete for the current branch slice.

What changed:

- Exec dispatch, wait, collect, and finalize transition families now route through processor-owned checkpoint helpers for the migrated paths.
- The command processor owns the active execution substate, checkpoint metadata, expected next route, and working-plan status for the migrated command-result paths.
- Added `reference-react-command-processor-mutation-authority` to prevent new direct `Transition.statePatch` assembly in `acter.ts` and `execStates.ts`.
- Preserved stable step IDs and replay/resume compatibility boundaries while keeping legacy compatibility explicit.

Validation run:

- `pnpm run governance:check`
  - Result: passed with existing warning-level output, including existing docs no-link warnings and invariant warnings.
- `pnpm run test`
  - Result: 343 test files passed, 3 skipped; 1597 tests passed, 7 skipped.
- `pnpm run prompt-suite`
  - Result: 78 checks passed.
- `pnpm run evals:release-check`
  - Result: 16 evaluation cases passed.

Next milestone:

- Start Milestone 4 by making working-plan and narration-memory updates durable processor-owned runtime state, then prove resumes carry current chunk, blocker, and expected next command.

### 2026-05-14 - Milestone 4 durable plan and narration memory

Status: Complete for the current branch slice.

What changed:

- Centralized processor-authored `workingPlan` updates so migrated command/checkpoint paths record `currentChunk`, `status`, `expectedNextCommand`, `waitReason`, `blocker`, and `lastUpdatedAtStepIndex`.
- Added ordinary working-memory persistence for reference-react progress narration under `memory.working.referenceReactNarrationMemory` and `memory.working.latestReferenceReactNarration`.
- Runtime commit now durably preserves reference-react narration hints, including synthesized wait/finalize hints, without forcing that provenance into final answers.
- Added regression coverage that waits persist the current chunk, blocker, expected next command, and latest narration memory across committed runtime state.

Validation run:

- `node --import tsx --test tests/unit/runtime-state-machine-hardening.test.ts tests/unit/reference-react-command-processor.test.ts tests/unit/exec-reasoning-narration.test.ts`
  - Result: 34 tests passed.
- `git diff --check -- src/engine/ExecutionEngine.ts agents/reference-react/src/commandProcessor.ts tests/unit/reference-react-command-processor.test.ts tests/unit/runtime-state-machine-hardening.test.ts docs/plans/2026-05-14-reference-react-command-processor-milestones.md`
  - Result: passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: blocked by unrelated dirty non-backlog runtime files; no `reference-react`, command-processor, or runtime narration type errors were reported before those failures.

Next milestone:

- Start Milestone 5 by projecting the durable processor state into operator visibility surfaces: CLI/web phase, visible plan, current chunk, command batch, and wait reason.

### 2026-05-14 - Milestone 5 operator visibility projection

Status: Complete for the current branch slice.

What changed:

- Added `OperatorRuntimePlanSummary` to the operator thread view contract.
- `OperatorControlPlane.getOperatorThreadView` now projects `react.workingPlan` and `react.commandProcessor` into operator-visible runtime state.
- CLI session/operator affordance payloads now carry the same runtime plan summary, giving terminal and protocol/web consumers the phase, current chunk, command batch, wait reason, blocker, expected next command, and checkpoint route.
- CLI affordance rendering now prints runtime plan, command batch, wait reason, expected next command, and checkpoint route lines.

Validation run:

- `node --import tsx --test tests/unit/cli-operator-affordances.test.ts tests/unit/runtime-state-machine-hardening.test.ts tests/unit/reference-react-command-processor.test.ts`
  - Result: 37 tests passed.
- `git diff --check -- src/orchestration/contracts.ts src/orchestration/OperatorControlPlane.ts cli/contracts.ts cli/runtime/KestrelChatRuntime.ts cli/runtime/operatorAffordances.ts tests/unit/cli-operator-affordances.test.ts`
  - Result: passed.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: blocked by unrelated dirty `agents/reference-react/src/codingWork.ts` missing `extractChangedFilesFromDevShellOutput`; no type errors were reported for the Milestone 5 operator visibility changes before that failure.

Next milestone:

- Start Milestone 6 by exposing runtime plan/narration/provenance through inspection and replay surfaces without raw prompt text, then keep the mutation-authority guard in the required gates.

### 2026-05-14 - Milestone 6 inspection and replay runtime-plan surface

Status: Complete for the current branch slice.

What changed:

- Replay results and doctor reports now include a `runtimePlan` summary derived from committed run state.
- Runtime inspection formatting now prints runtime plan and latest reference-react narration without exposing raw prompt text.
- The inspection surface includes phase, current chunk, status, command batch, command names, wait reason, expected next command, checkpoint substate, and latest narration fields.
- The mutation-authority invariant remains active through `pnpm run check:invariants`.

Validation run:

- `node --import tsx --test tests/unit/cli-runtime-inspection-formatters.test.ts tests/unit/cli-operator-affordances.test.ts tests/unit/runtime-state-machine-hardening.test.ts tests/unit/reference-react-command-processor.test.ts`
  - Result: 39 tests passed.
- `pnpm run check:invariants`
  - Result: passed with existing warning-level invariant output.
- `pnpm exec tsc --noEmit --pretty false`
  - Result: passed.
- `git diff --check -- src/replay/RunReplayService.ts cli/runtime/inspectionFormatting.ts tests/unit/cli-runtime-inspection-formatters.test.ts`
  - Result: passed.

Next milestone:

- Run the required full gates for the completed milestone set: `pnpm run governance:check`, `pnpm run test`, `pnpm run prompt-suite`, and `pnpm run evals:release-check`.

### 2026-05-14 - Completed milestone set full-gate closeout

Status: Complete.

Validation run:

- `pnpm run governance:check`
  - Result: passed with existing warning-level docs and invariant output.
- `pnpm run test`
  - Result: 343 test files passed, 3 skipped; 1597 tests passed, 7 skipped.
- `pnpm run prompt-suite`
  - Result: 78 checks passed.
- `pnpm run evals:release-check`
  - Result: 16 evaluation cases passed.

Closeout:

- Milestones 1 through 6 are complete for the current branch slice.
- Remaining work is cleanup/review/staging: inspect the final diff, separate unrelated dirty TUI/controller/devshell/workspace-checkpoint work from the runtime milestone set, and stage only the intended runtime/docs/test files.
