# workPlan Non-Shell Completion Truth Pass

## What I worked on

Implemented the smallest lifecycle-only fix so non-shell mutation and verification phases only transition to `done` from explicit per-tool success evidence.

## What changed

- Tightened phase-completion success gating in `agents/reference-react/src/codingWork.ts`:
  - `reconcileCodingWorkPlanAfterAction` now passes the inferred phase into `actionResultSucceeded`.
  - `toolActionResultSucceeded` now enforces explicit non-shell success evidence for `implementation` and `verification` phases, in addition to existing correlation and failure-signal checks.
- Added explicit success-contract checks for non-shell tools used in coding phases:
  - `fs.write_text`: requires non-empty `path` and finite non-negative `bytesWritten`.
  - `fs.replace_text`: requires non-empty `path` and finite positive `replacements`.
  - `fs.mkdir` / `fs.delete`: require non-empty `path`.
  - `fs.copy` / `fs.move`: require non-empty `sourcePath` and `destinationPath`.
  - `code.execute`: requires `status === "ok"` and `exitCode === 0`.
  - Unknown non-shell tools do not satisfy explicit success evidence.
- Kept scope constrained:
  - No step-topology changes.
  - No new coding-agent features.
  - No planner/prompt doctrine changes.
  - Existing shell completion semantics from prior pass were left intact.
- Expanded focused tests in `tests/unit/coding-work-plan.test.ts`:
  - Non-shell mutation does not complete from generic `resultQuality: "ok"` without explicit `fs.write_text` success fields.
  - Non-shell verification does not complete from generic quality alone and requires explicit `code.execute` success fields.

## Validation

- `node --import tsx --test tests/unit/coding-work-plan.test.ts tests/unit/planner-tool-intent.test.ts tests/unit/thinker-bypass.test.ts tests/unit/observer-recovery.test.ts`
- `pnpm run governance:check`
- `pnpm run test`
- `pnpm run prompt-suite`
- `pnpm run evals:release-check`

All commands passed.

## Next recommended to-do

Apply the same explicit success-evidence contract tightening to mixed `tool_batch` edge paths with duplicate tool names and partial batch outputs, and add targeted tests proving a phase cannot complete when any required non-shell batch item lacks its explicit success fields.
