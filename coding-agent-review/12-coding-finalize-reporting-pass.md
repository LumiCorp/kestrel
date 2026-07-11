# Coding Finalize/Reporting Pass

## What I worked on

Implemented coding-shaped finalize payload normalization and gating while preserving runtime `FinalizeAnswer` compatibility.

## What changed

- Observer now normalizes coding finalize payload fields in `nextAction.input.data`:
  - `summary`
  - `changedFiles`
  - `checksRun`
  - `checksFailed`
  - `blockers`
  - `residualRisks`
  - `completionState`
- Observer now derives coding handoff metadata from runtime traces when available (runtime-first precedence):
  - `changedFiles` from `lastActionResult` tool/tool_batch outputs for `fs.*` mutations and `code.execute` artifact paths
  - `checksRun`/`checksFailed` from `postToolVerification.devShell.lastCommand` + exit code and `tool_batch` `dev.shell.exec` item inputs/results
  - runtime-derived values override conflicting model-authored values for those fields
- Observer finalize gating now blocks premature coding finalization when required verification/work-plan status is still open without an explicit allowed completion path.
- Observer convergence now reflects coding work-plan open-state instead of only generic evidence sufficiency.
- `DecisionEnvelope` finalize data schema supports coding handoff fields.
- `Acter` finalize path preserves/forwards enriched coding data payload for runtime/API consumers.
- CLI finalize payload parser remains message-first and accepts richer `data` objects unchanged.

## Validation

- `node --import tsx --test tests/unit/observer-recovery.test.ts`
- `node --import tsx --test tests/unit/react-acter-code-artifacts.test.ts`
- `node --import tsx --test tests/unit/cli-finalize-payload.test.ts`

## Blockers and risks

- No blockers in this pass.
- Residual risk: `summary` and `residualRisks` remain primarily model-authored narrative fields.

## Next recommended to-do

Add runtime-backed grounding for remaining narrative finalize fields (`summary`, `residualRisks`) or explicitly strengthen their non-factual labeling in operator-facing handoff.
