---
id: runtime-simplification-baseline-2026-06-08
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-08
depends_on:
  - ../../AGENTS.md
  - ../../ARCHITECTURE.md
  - ../adr/0004-runtime-simplification-boundaries.md
---

# Runtime Simplification Baseline

This note records the PR 0 branch and gate baseline for the runtime simplification series before behavior-preserving PR 1 edits. It follows the repo [AGENTS contract](../../AGENTS.md) and the accepted [runtime simplification ADR](../adr/0004-runtime-simplification-boundaries.md).

## Branch Hygiene

- Source branch before isolation: `asher/canonical-execution-context`.
- Pre-existing dirty work was preserved with `git stash push --include-untracked -m pre-runtime-simplification-20260608`.
- Simplification branch: `asher/runtime-simplification-series`.
- Working tree was clean before baseline gates and before PR 1 edits.

## Baseline Gates

- `pnpm run governance:check`: failed before edits. `check:docs` reported eight stale documents over the 45-day threshold:
  - `docs/plans/2026-04-20-desktop-project-library-persistence-design.md`
  - `docs/plans/2026-04-20-thread-titlebar-icon-first-design.md`
  - `docs/plans/2026-04-20-thread-titlebar-icon-first-implementation-plan.md`
  - `docs/references/workspace-checkpoint-thread-id-contract.md`
  - `docs/runbooks/2026-04-22-studio-cutover-baseline-ledger.md`
  - `docs/runbooks/2026-04-22-studio-runner-service-operations-runbook.md`
  - two since-retired Agent Admin Superpowers records
- `pnpm run test`: failed before edits. Core tests progressed to the web package; `@kestrel/web` failed in [ui-smoke.test.ts](../../apps/web/tests/ui-smoke.test.ts) while matching settings page source output.
- `pnpm run prompt-suite`: passed, `total=84 passed=84 failed=0 passRate=1 composite=97`.
- `pnpm run evals:release-check`: passed all listed evaluation cases.

## Classification

The failing governance and full-test gates are baseline failures, not introduced by PR 1. PR 1 validation should still run focused tests for the new characterization coverage, plus the full gates where practical, and should keep these baseline failures called out until fixed by their owning slices.

## PR 1 Validation

- `node --import tsx --test tests/unit/runtime-simplification-characterization.test.ts`: passed, 4/4.
- `pnpm run typecheck`: failed after PR 1 on the pre-existing `agents/reference-react/src/decision/DecisionEnvelope.ts:588` spread-type error; the new characterization test no longer contributes type errors.
- `pnpm run governance:check`: still failed only on the eight baseline stale documents listed above.
- `pnpm run test:core`: passed on rerun, 1907/1907.
- `pnpm run web:test`: failed on the same baseline [ui-smoke.test.ts](../../apps/web/tests/ui-smoke.test.ts) settings-page source assertion.
- `pnpm run test`: failed after core tests passed, stopping at the same baseline `@kestrel/web` [ui-smoke.test.ts](../../apps/web/tests/ui-smoke.test.ts) settings-page source assertion.
- `pnpm run prompt-suite`: passed, `total=84 passed=84 failed=0 passRate=1 composite=97`.
- `pnpm run evals:release-check`: passed all listed evaluation cases.
