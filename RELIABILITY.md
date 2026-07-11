---
id: reliability-root
domain: ops
status: active
owner: kestrel-ops
last_verified_at: 2026-07-10
depends_on:
  - ARCHITECTURE.md
  - docs/generated/quality-scorecard.json
  - apps/docs/content/operations/quality-gates.mdx
---

# Reliability

Kestrel reliability is maintained through explicit gates, replay-oriented
evidence, and operator-visible failure state. Failures must remain diagnosable
and recoverable across runtime, CLI/TUI, Desktop, Kestrel One, and packages.

## Prevention

- `pnpm run governance:check` protects architecture, docs, package boundaries,
  release tracks, evaluation ownership, and replay baselines.
- `pnpm run test` protects runtime, app, and package behavior.
- `pnpm run prompt-suite` protects model-visible reference-agent contracts.
- `pnpm run evals:release-check` validates declarative behavior through the
  exact released Ruhroh dependency.
- `pnpm run bench:smoke` protects benchmark adapter contracts without live
  provider or Docker dependencies.

## Detection

- Replay baseline failures indicate deterministic or contract regressions.
- Ruhroh failures identify invalid specifications, adapter drift, or changed
  behavior evidence.
- Prompt-suite failures indicate model-facing contract drift.
- Quality-score regressions identify accumulating domain risk.
- Logs, artifacts, checkpoints, and operator evidence provide incident facts.

## Response

- Start governance failures with `pnpm run governance:check`.
- Start general regressions with the narrow test, then `pnpm run test`.
- Start model-facing regressions with `pnpm run prompt-suite`.
- Start evaluation regressions with `pnpm run evals:release-check` and the
  owning Ruhroh scenario or named Kestrel runtime test.
- Start benchmark adapter regressions with `pnpm run bench:smoke` before live
  Terminal-Bench or SWE workloads.

## Operational References

- [Quality gates](apps/docs/content/operations/quality-gates.mdx)
- [Evaluations with Ruhroh](apps/docs/content/operations/evaluations.mdx)
- [Operator runbook](docs/runbooks/2026-02-25-kestrel-mvp-operator-runbook.md)
- [Mountain Top runbook](docs/runbooks/2026-03-23-mountaintop-runbook.md)
- [Quality score](QUALITY_SCORE.md)
