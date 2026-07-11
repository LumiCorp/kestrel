# workPlan Mixed tool_batch Completion Truth Pass

## What I worked on

Implemented the smallest completion-truth tightening for mixed `tool_batch` lifecycle handling so phase completion does not advance from partial/ambiguous batch evidence.

## What changed

- Tightened `tool_batch` action/result correlation in `agents/reference-react/src/codingWork.ts`:
  - `toolBatchResultMatchesAction` now validates a full tool-name multiset match (counts per name), not loose set overlap.
  - This blocks partial chunk outputs and duplicate-name undercounts from matching as complete batch results.
- Tightened mixed-batch explicit success gating in `agents/reference-react/src/codingWork.ts`:
  - Added `NON_SHELL_EXPLICIT_SUCCESS_TOOLS` and `isRequiredNonShellBatchTool`.
  - `toolActionResultSucceeded` now requires explicit non-shell success evidence for `tool_batch` actions that contain required non-shell tools, even when inferred phase is not `implementation`/`verification`.
  - Batch explicit-evidence checks now support a `requiredOnly` mode so mixed batches only enforce explicit contracts for required non-shell tools (without forcing unrelated read-only tools like `fs.list` to satisfy mutation contracts).
- Added focused regression tests in `tests/unit/coding-work-plan.test.ts`:
  - Mixed `tool_batch` with partial outputs does not complete a phase.
  - Mixed `tool_batch` with duplicate required non-shell tool names does not complete unless every duplicate item has explicit success evidence.
  - Positive duplicate case confirms completion once full explicit evidence is present.

## Validation

- `node --import tsx --test tests/unit/coding-work-plan.test.ts`
- `pnpm run governance:check`
- `pnpm run test`
- `pnpm run prompt-suite`
- `pnpm run evals:release-check`

All commands passed.

## Next recommended to-do

Tighten batch item-to-result correlation from name-count matching to deterministic item identity matching (for example, name + normalized input fingerprint) so duplicate-name batches remain explicit and unambiguous even if result ordering changes.
