---
id: kestrel-runtime-evaluation-controls-delta
domain: reliability
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-04
depends_on:
  - ../../RELIABILITY.md
  - ../../QUALITY_SCORE.md
---

# Kestrel Runtime Evaluation Controls Delta

## Review status

This is a focused implementation delta for controls 153–160. It reviews the
runtime-evaluator contracts, delivery control, interruption behavior,
live/recorded replay evidence, calibration harness, and mutation proofs added
by the three-PR runtime-evaluator wave.

It is not a new 200-control inspection and does not publish a new overall
Kestrel score. The 2026-08-03 planning baseline assigned 2/8 to this domain,
but `main` changed after that inspection. A separate full reinspection is
required to recalculate the overall score.

## Delta conclusion

Runtime evaluation is now an explicit profile-owned feature. Disabled profiles
retain their previous behavior. An enabled profile pins one exact evaluator,
asset bundle, primary judge route, calibration identity, hook set, independent
budget, thresholds, and bounded revision/review actions. The runtime will not
construct its evaluator coordinator unless a strict passing calibration record
matches that exact evaluator, asset, dataset, requested model registration, and
observed model revision.

Intermediate tool, milestone, and handoff evaluations are awaited advisory
evidence only. The pre-delivery hook is the sole blocking hook. It runs before a
proposed completed transition is committed, withholds the sanitized candidate
until a pass or exact operator override, permits at most one deterministic
revision, and otherwise enters a durable exact-option review. The evaluator
receives no tools, raw credentials, acting-model recovery, or free-form control
authority.

Recorded replay uses the same evidence-projection contract as live execution.
It consumes persisted requests, verdicts, decisions, selected actions, failures,
and review evidence without invoking the acting model, tools, or evaluator.
Explicit offline re-evaluation is a separate operation with a separately
supplied budget and cannot execute the recorded trajectory.

## Implementation-backed control evidence

| Control | Planning baseline | Target | Implementation and proof evidence |
|---:|---:|---:|---|
| 153 — Typed evaluator contract | 0.5 | 1 | Strict request, verdict, decision, evidence, policy, and calibration contracts; exact-version evaluator registry; bounded model-backed built-in. [`evaluation.ts`](../../src/kestrel/contracts/evaluation.ts), [`RuntimeEvaluatorRegistry.ts`](../../src/evaluation/RuntimeEvaluatorRegistry.ts), [`runtime-evaluation-conformance.test.ts`](../../tests/unit/runtime-evaluation-conformance.test.ts) |
| 154 — Intermediate and final hooks | 0.5 | 1 | Exact advisory `after_tool`, `milestone`, and `handoff` selectors plus one blocking `pre_delivery` hook are connected at their existing runtime owners. [`ExecutionEngine.ts`](../../src/engine/ExecutionEngine.ts), [`RuntimeIO.ts`](../../src/engine/RuntimeIO.ts), [`DelegationSupervisor.ts`](../../src/orchestration/DelegationSupervisor.ts) |
| 155 — Versioned evaluation assets | 0.5 | 1 | The rubric, assertions, prompts, schema, thresholds, evaluator version, and 24-case dataset identity are canonically hashed into the immutable asset reference. [`assets.ts`](../../src/evaluation/assets.ts), [`dataset.ts`](../../src/evaluation/calibration/dataset.ts) |
| 156 — Control-flow integration | 0.5 | 1 | One coordinator maps typed verdicts deterministically; only pre-delivery evaluation can revise or enter review, while terminal settlement remains owned by `RunLifecycleController`. [`RuntimeEvaluationCoordinator.ts`](../../src/evaluation/RuntimeEvaluationCoordinator.ts), [`runtime-evaluation-integration.test.ts`](../../tests/unit/runtime-evaluation-integration.test.ts) |
| 157 — Auditable judge context | 0 | 1 | Canonical sanitized projections, secret-free route identity, bounded rationale/assertions/reason codes/evidence references/usage/latency, and lifecycle artifacts are persisted before control advances. [`RuntimeEvaluationCoordinator.ts`](../../src/evaluation/RuntimeEvaluationCoordinator.ts), [`runtime-evaluation-interruption.test.ts`](../../tests/unit/runtime-evaluation-interruption.test.ts) |
| 158 — Evaluator budgets | 0 | 1 | Four-call run budget, two chronological advisory slots, two reserved final slots, one attempt, timeout, concurrency one, per-call token caps, total token/spend caps, and one final revision are independently enforced. [`evaluation.ts`](../../src/kestrel/contracts/evaluation.ts), [`runtime-evaluation-coordinator.test.ts`](../../tests/unit/runtime-evaluation-coordinator.test.ts) |
| 159 — Online/offline consistency | 0 | 1 | Live and replay rebuild the same projection and require matching digests; recorded replay never re-executes and explicit offline evaluation uses the same evaluator contract. [`RuntimeEvaluationReplay.ts`](../../src/evaluation/RuntimeEvaluationReplay.ts), [`RuntimeReplayBundle.ts`](../../src/replay/RuntimeReplayBundle.ts), [`runtime-evaluation-replay.test.ts`](../../tests/unit/runtime-evaluation-replay.test.ts) |
| 160 — Evaluator quality tests | 0 | pending real calibration | The hermetic 24-case × 3 harness proves fixture composition, hidden-label exclusion, disposition metrics, repeatability, and threshold stability. The credentialed refresh command records actual model identity, bounded verdicts, usage, and latency. No real opted-in profile/calibration record was available in the implementation environment, so the real-route quality claim is withheld. [`RuntimeEvaluationCalibration.ts`](../../src/evaluation/RuntimeEvaluationCalibration.ts), [`runtime-evaluation-calibration.test.ts`](../../tests/unit/runtime-evaluation-calibration.test.ts), [`calibrate-runtime-evaluator.ts`](../../scripts/calibrate-runtime-evaluator.ts) |

## Audit movement status

The planned focused movement was **+6**, from 2/8 to 8/8. Contracts, runtime
control, interruption behavior, replay parity, hermetic calibration logic, and
mutation evidence are implementation-backed. The final +6 claim is **not
published** because a credentialed real-route calibration has not produced a
passing checked-in `EvaluationCalibrationRecordV1` for an exact opted-in
profile. Synthetic or stubbed output is not substituted for that evidence.

To unblock the claim, author the exact evaluation policy on the intended
profile and run:

```sh
pnpm calibrate:runtime-evaluator -- --profile <profile-id> --out <record.json>
```

Then pin the returned record revision in the policy, configure
`KCHAT_RUNTIME_EVALUATION_CALIBRATION_PATH`, validate the record hermetically,
and rerun this focused inspection. A failed or unavailable live calibration
continues to block control 160 and the +6 statement.

## Interruption and replay evidence

The interruption matrix injects failure after request persistence, after judge
attempt start, after judge response but before verdict persistence, after
verdict persistence, and after decision persistence. Integration proofs cover
revision start, durable waiting, operator response, accept-once, revised
completion, and terminal settlement. Restart therefore consumes the same
evidence, resumes the selected action, remains waiting, or fails closed. It does
not silently rerun an uncertain judge call or reveal a withheld candidate.

Recorded-result replay includes the evaluation evidence in
`RuntimeReplayBundleV1`. Missing decisions, malformed evidence, and live/replay
projection drift return `EVALUATION_EVIDENCE_INCOMPLETE`; historical evidence
is never fabricated.

## Mutation evidence

The prior audit manifest on current `main` contained 60 live mutations. This
wave adds ten exact evaluator mutations:

- Score/confidence threshold bypass.
- Required-assertion bypass.
- Stale calibration/evaluator/assets/model acceptance.
- Missing evaluator fail-open.
- Evaluator final-capacity-reserve bypass.
- Missing decision persistence.
- Candidate delivery before pass or exact operator override.
- One-revision bound bypass.
- Quarantined candidate exposure through the normal projection.
- Live/replay projection mismatch acceptance.

The focused evaluator mutation run killed **10/10**. The correct full audit
target for this branch is therefore **70/70 killed**, preserving every existing
proof; the obsolete 45-proof planning count is not used.

## Scope boundaries

- Evaluation remains disabled unless a resolved profile contains a policy.
- The acting primary route is also the judge route and independence is recorded as `shared_primary_route`.
- Intermediate verdicts do not enter recovery or the acting transcript.
- Quarantine restricts normal product projection; it does not claim a new storage ACL or encryption boundary.
- Ruhroh remains the offline suite, comparison, and release-evaluation owner.
- No multiple evaluators, consensus, dynamic sampling, automated rubric selection, package discovery, marketplace, dashboard, settings UI, or cross-provider judge was added.
- No SQL migration was required.

## Verification record

- Focused evaluator contract, integration, interruption, replay, conformance, calibration, and deterministic chaos tests: **37/37 passed**.
- Focused evaluator mutations: **10/10 killed**.
- Desktop runtime resource preparation and drift check: passed; the generated ignored payload was removed after the check.
- `CI=true pnpm validate`: passed in **143.7s**.
- `pnpm run validate:postgres`: passed in **53.3s**.
- `pnpm run validate:process`: passed in **360.8s**.
- `pnpm run validate:audit`: passed in **145.5s**, with **70/70 killed**.
- Credentialed real-route calibration: not run because no configured profile opted into runtime evaluation; the +6 audit claim remains withheld.
