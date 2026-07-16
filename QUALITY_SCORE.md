---
id: quality-score-root
domain: docs
status: active
owner: kestrel-quality
last_verified_at: 2026-07-16
depends_on:
  - docs/generated/quality-scorecard.json
  - docs/index.md
  - scripts/generate-quality-scorecard.ts
---

# Kestrel Quality Score

The quality scorecard is a directional health signal by domain. It shows where
risk and drift are accumulating so maintainers can choose the next hardening
work. It is not a release gate and must not overrule a failing test, replay
baseline, security review, or evaluation.

## What It Measures

The generator in
[`src/governance/qualityScorecard.ts`](src/governance/qualityScorecard.ts)
combines:

| Signal | What it helps reveal |
| --- | --- |
| Architecture compliance | Boundary and dependency drift |
| Test depth | Behavior without a proportional regression proof |
| Incident rate | Operational instability in a domain |
| Drift | Stale contracts, docs, or generated evidence |
| Replay stability | Loss of deterministic or inspectable behavior |
| Latency | Performance risk that affects product operation |

Each domain receives a score, trend, confidence, and recommended actions. Low
confidence means the score should trigger better evidence before a broad
conclusion.

## Generate the Scorecard

```bash
pnpm run scorecard:generate
```

The generated artifact is
[`docs/generated/quality-scorecard.json`](docs/generated/quality-scorecard.json).
Commit it only when the source signals or generator intentionally changed.

## Interpret the Result

- **Stable high score:** normal release work can continue, subject to direct
  gates.
- **Falling trend:** inspect the contributing signals before adding unrelated
  features in that domain.
- **High drift:** reconcile current contracts, docs, and generated evidence.
- **Weak test depth:** add focused tests at the owning behavior boundary.
- **Weak replay stability:** investigate deterministic state and evidence before
  changing baselines.
- **Rising incident rate:** prioritize containment, diagnosis, and recovery
  proofs.
- **Low confidence:** improve the inputs rather than tuning the score.

The scorecard should guide a question—“where is risk accumulating?”—not supply
an automatic policy decision.

## Direct Gates Still Decide Readiness

```bash
pnpm run governance:check
pnpm run test
pnpm run prompt-suite
pnpm run evals:release-check
```

Benchmark and product-specific work may require additional gates. See
[Reliability](RELIABILITY.md) for the verification ladder and incident model,
and [Design principles](DESIGN.md) for decision rules.
