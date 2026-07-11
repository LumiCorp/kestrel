# Combined Contract Closeout Pass (19)

## What I worked on

Implemented the coordinated closeout pass for the 4 remaining coding-agent contract gaps:

1. deterministic duplicate-name `tool_batch` identity correlation,
2. structured `check:` / `file:` verification token enforcement,
3. runtime-first finalize narrative grounding with provenance labels,
4. coding-focused scene and regression expansion.

Scope stayed within the requested contract-tightening slice (no topology expansion, no new feature surface).

## What changed

### 1) Deterministic mixed `tool_batch` identity matching

- Updated `agents/reference-react/src/codingWork.ts`:
  - Added strict typed batch item parsing with `name`, `output`, and parsed `input`.
  - Added deterministic correlation for `tool_batch` actions/results via identity keys:
    - `name + stable hash(normalized input)` for duplicate-name cohorts,
    - name-only identity for non-duplicate cohorts.
  - Duplicate-name requirement now fails closed when corresponding result items omit valid object `input`.
  - Replaced name-only queue evidence matching with identity-keyed queue matching.
  - Reused the same strict parsed batch path for completion matching and explicit non-shell evidence checks.

### 2) Structured verification contract enforcement

- Updated `agents/reference-react/src/decision/compileIntent.ts`:
  - `verification.verificationSteps` now validated as `check:<non-empty command>`.
  - `verification.expectedRepoDelta` now validated as `file:<non-empty path>`.
  - For coding finalize with `completionState="implemented_and_verified"`, compile-time policy now requires both token lists to be present and non-empty.
- Updated model-facing prompt examples/rules:
  - `agents/reference-react/src/steps/thinker.ts`
  - `agents/reference-react/src/steps/observer.ts`
  - Both now explicitly instruct tokenized `verificationSteps`/`expectedRepoDelta` output for verified coding completion claims.

### 3) Runtime-first finalize summary/risk grounding

- Updated `agents/reference-react/src/steps/observer.ts`:
  - Added runtime enforcement for verified finalize claims:
    - For `completionState="implemented_and_verified"`, required `check:`/`file:` tokens are matched against normalized finalize evidence (`checksRun`, `changedFiles`).
    - Missing tokens now raise `DECISION_POLICY_FAILED` with explicit `missingVerificationTokens` metadata.
  - Added deterministic runtime-derived fallback generation:
    - `summary` derives from runtime-linked changed files/checks/blockers when available.
    - `residualRisks` derives from runtime state (failed checks, blockers, inferred incomplete verification).
  - Updated `reportingGrounding` labeling so `summary` and `residualRisks` can be `runtime_linked`.

### 4) Coding evaluation cases + targeted regressions

- Added/updated regression coverage:
  - `tests/unit/coding-work-plan.test.ts`
    - duplicate-name identity matching success/failure paths,
    - duplicate result input omission fail-closed behavior.
  - `tests/unit/compile-intent-required-capabilities.test.ts`
    - malformed `check:`/`file:` token rejection,
    - verified finalize rejection when required token lists are absent.
  - `tests/unit/observer-recovery.test.ts`
    - verified finalize rejection with explicit missing token list metadata,
    - runtime-linked summary/residual/blocker grounding assertions.

## Validation

Ran and passed:

- `node --import tsx --test tests/unit/coding-work-plan.test.ts`
- `node --import tsx --test tests/unit/compile-intent-required-capabilities.test.ts`
- `node --import tsx --test tests/unit/observer-recovery.test.ts`
- `node --import tsx --test tests/unit/cli-app-commands.test.ts`
- `pnpm run governance:check`
- `pnpm run test`
- `pnpm run prompt-suite`
- `pnpm run evals:release-check`

## Next recommended to-do

Execute the deferred broad cleanup pass (`overreach pruning`) so legacy prompt/schema slack that is no longer needed after this contract hardening is removed without changing runtime topology.
