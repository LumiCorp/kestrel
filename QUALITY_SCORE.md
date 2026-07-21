---
id: quality-score-root
domain: docs
status: active
owner: kestrel-quality
last_verified_at: 2026-07-20
depends_on:
  - docs/generated/quality-scorecard.json
  - docs/index.md
  - scripts/generate-quality-scorecard.ts
---

# Kestrel Quality Score

The Kestrel quality scorecard is a directional view of engineering health by
domain. It highlights where evidence suggests that risk or drift is
accumulating. It does not replace direct tests, security review, evaluation, or
release checks.

## What it measures

| Signal | What it can reveal |
| --- | --- |
| Architecture compliance | Boundary or dependency drift |
| Test depth | Behavior without proportional regression coverage |
| Incident rate | Operational instability in a domain |
| Drift | Stale contracts, documentation, or generated evidence |
| Replay stability | Loss of deterministic or inspectable behavior |
| Latency | Performance risk that affects product operation |

Each domain receives a score, trend, confidence level, and recommended actions.
A low-confidence result means that more evidence is needed before drawing a
broad conclusion.

## Reading the scorecard

- A stable high score indicates no accumulating quality signal in the measured
  inputs; direct release checks still apply.
- A falling trend identifies the signals contributing to the change.
- High drift points to disagreement among current contracts, documentation, or
  generated evidence.
- Weak test depth indicates that behavior has outgrown its regression coverage.
- Weak replay stability indicates that recorded state no longer reproduces or
  explains behavior consistently.
- A rising incident rate highlights a domain that needs stronger containment,
  diagnosis, or recovery evidence.

The scorecard answers “where might risk be accumulating?” It does not make an
automatic product or release decision.

Direct pull-request readiness is established by `pnpm validate`. GitHub Actions
runs the same fixed validation DAG. The runner reports component V8 coverage,
contract coverage, mutation evidence, and slowest work without turning elapsed
time into a correctness gate or collapsing evidence into one global percentage.
macOS package readiness is established separately during release preparation
with `pnpm run validate:release:macos`.

## Current data

The generated scorecard is available at
[`docs/generated/quality-scorecard.json`](docs/generated/quality-scorecard.json).
Its generator combines repository governance, test, incident, drift, replay,
and latency signals into the published domain summaries.

See [Reliability](RELIABILITY.md) for the wider reliability model and
[Design principles](DESIGN.md) for the product guarantees those signals protect.
