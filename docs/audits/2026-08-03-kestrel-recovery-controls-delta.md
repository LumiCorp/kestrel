---
id: kestrel-recovery-controls-delta-2026-08-03
domain: reliability
status: historical
owner: kestrel-runtime
last_verified_at: 2026-08-03
---

# Kestrel Recovery Controls Delta

## Review status

This is a focused implementation delta for the three-PR recovery-integrity
wave completed from the `5a434c3e` planning base. It reviews only controls
074, 080, 101, 194, 196, 197, 199, and 200 against the immutable recovery
contracts, the single runtime coordinator, and the proof suites delivered by
the wave.

This document is not a new 200-control inspection. The planned movement from
`137.5` to `142.5 / 200` remains a planning projection until a separate full
reinspection verifies every control at one commit. Controls 178 and 180 remain
accepted egress critical zeros and are unchanged by this work.

## Delta conclusion

Recovery is now an authored, immutable execution-profile contract rather than
a collection of local fallback choices. A resolved policy fixes the primary
route, exact ordered candidates, attempt bounds, failure codes, adapter and
workflow identities, human-review options, and typed terminal outcomes. The
runtime coordinator is the only recovery chooser. Provider retry
classification and delay remain where failures first occur, but every retry or
route change is policy-authorized and durably recorded before execution.

Alternate models must be registered against the exact policy revision and pass
credential, capability, prompt, budget, freshness, and visible-output checks.
Alternate tools are scheduled as typed engine effects through the existing
lookup, schema, policy, approval, sandbox, and idempotency boundaries. External
effects receive a fresh action-bound approval whose authority revision includes
the target authority, recovery-policy revision, and adapter identity. Managed
human review persists an exact decision binding and creates no tool authority.

The proof wave adds interruption, deterministic chaos, registry conformance,
and nine live mutation proofs. Restart evidence shows that an operator wait
remains durable and resumes the exact option, while recorded recovery tool
results prevent a consumed external effect from executing again.

## Implementation-backed control movement

| Control | Prior | Supported delta | Implementation and proof evidence |
|---:|---:|---:|---|
| 074 — Layer-specific recovery | 0.5 | 1 | Model, tool, deterministic workflow, human, and terminal recovery enter one `RecoveryCoordinator`; failure classification remains at the owning gateway or engine boundary. [`RecoveryCoordinator.ts`](../../src/engine/recovery/RecoveryCoordinator.ts), [`RuntimeIO.ts`](../../src/engine/RuntimeIO.ts), [`ExecutionEngine.ts`](../../src/engine/ExecutionEngine.ts) |
| 080 — Recovery tests | 0.5 | 1 | Focused suites cover retry, fallback, tool transitions, human review, crash ordering, durable waiting/resume, recorded-result replay, and terminal settlement. [`recovery-runtime-integration.test.ts`](../../tests/unit/recovery-runtime-integration.test.ts), [`recovery-interruption.test.ts`](../../tests/unit/recovery-interruption.test.ts) |
| 101 — Pinned fallback behavior | 0 | 1 | Policies reject discovery and ranking, preserve candidate order, and require an exact registration and revision match before a candidate can run. [`recovery.ts`](../../src/kestrel/contracts/recovery.ts), [`RecoveryRegistries.ts`](../../src/engine/recovery/RecoveryRegistries.ts), [`recovery-coordinator.test.ts`](../../tests/unit/recovery-coordinator.test.ts) |
| 194 ◆ — Explicit escalation ladder | 0 | 1 | `RecoveryPolicyV1` defines ordered same-route retry, pinned model, exact tool adapter, deterministic workflow, human review, and terminal stages. The coordinator is the sole chooser. [`recovery.ts`](../../src/kestrel/contracts/recovery.ts), [`RecoveryCoordinator.ts`](../../src/engine/recovery/RecoveryCoordinator.ts) |
| 196 — Deterministic non-agentic path | 0.5 | 1 | Compaction, continuation, and loop recovery are exact-ID registered handlers, and missing handlers fail closed. [`RecoveryRegistries.ts`](../../src/engine/recovery/RecoveryRegistries.ts), [`recovery-conformance.test.ts`](../../tests/unit/recovery-conformance.test.ts) |
| 197 — Budget-aware degradation | 0.5 | 1 | Each decision records a budget snapshot; exhausted time blocks automatic recovery and candidate selection evaluates declared request capabilities before route movement. [`RecoveryCoordinator.ts`](../../src/engine/recovery/RecoveryCoordinator.ts), [`recovery-coordinator.test.ts`](../../tests/unit/recovery-coordinator.test.ts) |
| 199 — Audited degradation | 0.5 | 1 | Decisions record ordered candidate dispositions and lifecycle evidence before action and after completion, failure, waiting, or exhaustion. [`recovery.ts`](../../src/kestrel/contracts/recovery.ts), [`RecoveryCoordinator.ts`](../../src/engine/recovery/RecoveryCoordinator.ts), [`recovery-interruption.test.ts`](../../tests/unit/recovery-interruption.test.ts) |
| 200 — Chaos and recovery tests | 0.5 | 1 | One deterministic suite covers model regression, sandbox loss, tool removal, and typed evaluator rejection; conformance and mutation suites cover every registered recovery family and nine no-bypass claims. [`recovery-chaos.test.ts`](../../tests/unit/recovery-chaos.test.ts), [`recovery-conformance.test.ts`](../../tests/unit/recovery-conformance.test.ts), [`mutations.json`](../../tests/proof/mutations.json) |

The supported delta is **+5 points** across these eight controls. Control 194
therefore has implementation evidence to move off zero. A full reinspection is
still required before reporting `142.5 / 200` as Kestrel's verified overall
score or recalculating its complete critical-control result.

## Interruption and replay evidence

The interruption suite exercises the recovery boundaries in execution order:

1. A retryable model failure is captured with its exact failure code.
2. Failure to persist the recovery decision prevents selection from returning.
3. Failure to persist action start prevents the action callback from running.
4. Visible streamed reasoning or output prevents retry authorization and route switching.
5. Alternate tools execute only as typed effects with a decision-derived idempotency key.
6. Recovery review settles the original run as `WAITING` and persists its binding.
7. A reconstructed runtime validates the exact operator, tenant, Thread, policy, profile, decision, and option.
8. Resume settles a new run normally, while a recorded external-effect result is consumed without re-execution.

The runtime therefore either continues the already authorized action, remains
waiting, or fails closed. It does not silently reorder candidates or repeat a
recorded external effect.

## Mutation evidence

The historical 23 mutations are retained. This wave adds nine exact live
mutations:

- Candidate-order inversion.
- Capability-check bypass.
- Budget-check bypass.
- Stale policy/profile acceptance.
- Missing adapter fail-open.
- Route switching after visible output.
- Missing decision persistence.
- External-effect approval reuse.
- Attempt-bound bypass.

The focused recovery mutation run killed **9/9**. The hermetic,
Docker-independent audit gate retained the historical proofs and killed
**32/32** mutations.

## Scope boundaries

- No provider, model, tool, or workflow fallback exists unless the resolved policy names it exactly.
- Existing provider retry classification and delay behavior is unchanged.
- No heuristic ranking, score, threshold, keyword route, or dynamic discovery was introduced.
- Human recovery review creates no approval grant or tool authority.
- No SQL migration was required; resolved profile snapshots, interaction metadata, run events, and effect results carry the evidence.
- Egress policy, filesystem TOCTOU, memory architecture, hierarchical budgets, live-fork replay, and runtime evaluator integration remain out of scope.

## Verification record

Observed on the final branch:

- Recovery coordinator, runtime integration, interruption, chaos, and conformance suites: **21/21 passed**.
- Recovery mutation proofs: **9/9 killed**.
- Root TypeScript check: passed.
- `CI=true pnpm validate`: passed in **102.8s**.
- `pnpm run validate:postgres`: passed in **50.3s**.
- `pnpm run validate:process`: passed in **313.3s**; the real disposable-keychain host integration was explicitly skipped under CI while its nine deterministic contract tests passed.
- `pnpm run validate:audit`: passed in **97.8s**, with **32/32 killed**.
