---
id: quality-score-root
domain: docs
status: active
owner: kestrel-quality
last_verified_at: 2026-07-10
depends_on:
  - docs/generated/quality-scorecard.json
  - docs/index.md
  - scripts/generate-quality-scorecard.ts
---

# Quality Score

The quality scorecard is a compact health summary by domain. It highlights
where drift is accumulating; direct validation gates determine whether a
change can ship.

## Inputs

The generator in `src/governance/qualityScorecard.ts` combines:

- architecture compliance
- test depth
- incident rate
- drift
- replay stability
- latency

It emits a score, trend, confidence, and recommended actions for each domain.

Refresh the generated artifact with:

```bash
pnpm run scorecard:generate
```

## Interpretation

- Stable high scores support normal release work.
- High drift calls for docs and contract cleanup.
- Weak test depth or replay stability calls for focused tests, prompt coverage,
  or Ruhroh evaluation coverage according to behavior ownership.
- Rising incident rate makes reliability hardening release work.

## Direct Gates

The scorecard does not replace:

- `pnpm run governance:check`
- `pnpm run test`
- `pnpm run prompt-suite`
- `pnpm run evals:release-check`
- `pnpm run bench:smoke`

See [the generated scorecard](docs/generated/quality-scorecard.json) and
[Reliability](RELIABILITY.md).
