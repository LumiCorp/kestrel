# workPlan Task Identity + Reset Pass

## What I worked on

Implemented the smallest lifecycle-only fix for durable coding `workPlan` identity and stale-state carryover, with stricter completion truth for shell-backed actions.

## What changed

- Tightened persisted coding plan identity contract in `agents/reference-react/src/codingWork.ts`:
  - `readCodingWorkPlan` now rejects legacy/invalid coding plans that do not have a non-empty `taskKey`.
  - `CodingWorkPlan.taskKey` is now required in `agents/reference-react/src/types.ts`.
- Added hard reset semantics for stale carryover:
  - `mergeCodingWorkPlan(existing, seeded)` now returns `undefined` when `seeded` is absent, which clears stale coding state on non-coding turns.
  - Task-key mismatch still reseeds from the current task as before.
- Tightened completion truth in `reconcileCodingWorkPlanAfterAction`:
  - Phase completion now requires both action/result correlation and explicit success semantics.
  - For `dev.shell.exec`/`dev.shell.read`/`dev.shell.status`, phase completion now requires a settled command with `postToolVerification.devShell.completedExitCode === 0` and no active command.
- Updated lifecycle call sites to persist resolved work-plan state (including clear):
  - `agents/reference-react/src/steps/planner.ts`
  - `agents/reference-react/src/steps/thinker.ts`
  - `agents/reference-react/src/steps/observer.ts`
  - These now write `react.workPlan` as the resolved value each cycle, so stale plans are explicitly cleared when lifecycle says no active coding plan.
- Expanded focused tests in `tests/unit/coding-work-plan.test.ts`:
  - stale-state reset when no coding seed exists,
  - rejection of taskless legacy plans,
  - shell command remains `in_progress` until settled success.

## Validation

- `node --import tsx --test tests/unit/coding-work-plan.test.ts`
- `node --import tsx --test tests/unit/planner-tool-intent.test.ts tests/unit/thinker-bypass.test.ts tests/unit/observer-recovery.test.ts`
- `pnpm run governance:check`
- `pnpm run test`
- `pnpm run prompt-suite`
- `pnpm run evals:release-check`

All commands passed.

## Next recommended to-do

Harden phase completion contracts for non-shell mutation/verification actions so each phase can only transition to `done` from explicit per-tool success fields (not only generic `resultQuality` + failure-signal absence).
