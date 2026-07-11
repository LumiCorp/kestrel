# workPlan tool_batch Shape Hardening Pass

## What I worked on

Implemented a minimal completion-truth hardening pass for mixed `tool_batch` handling so malformed batch item records fail closed and cannot advance required coding phases.

## What changed

- Tightened mixed `tool_batch` completion matching in `agents/reference-react/src/codingWork.ts`:
  - Added a strict batch-result item reader (`readStrictToolBatchResultItems`) used by `toolBatchResultMatchesAction`.
  - Each `result.items[]` record must include:
    - a non-empty `name`, and
    - an explicit `output` field.
  - Any malformed item now invalidates the entire batch result for completion matching (fail-closed).
- Tightened explicit non-shell evidence checks to use the same strict batch-item reader:
  - `hasExplicitNonShellPhaseSuccessEvidence` now consumes strictly parsed batch items.
  - Malformed items are no longer silently skipped in evidence validation paths.
- Preserved scope boundaries:
  - no step-topology changes,
  - no planner/prompt doctrine changes,
  - no new coding-agent features,
  - no public interface/schema changes.
- Added focused regressions in `tests/unit/coding-work-plan.test.ts`:
  - malformed item missing `name` does not complete phase,
  - malformed item missing `output` does not complete phase,
  - otherwise-valid batch plus malformed extra item does not complete phase,
  - reordered valid batch outputs still complete when explicit evidence is present,
  - duplicate required non-shell batch with one malformed duplicate item does not complete phase.

## Validation

- `node --import tsx --test tests/unit/coding-work-plan.test.ts`
- `pnpm run governance:check`
- `pnpm run test`
- `pnpm run prompt-suite`
- `pnpm run evals:release-check`

All commands passed.

## Next recommended to-do

Replace name-count-only duplicate correlation with deterministic per-item identity matching (for example name + normalized input fingerprint) so duplicate tool names remain unambiguous even when result ordering or chunking behavior evolves.
