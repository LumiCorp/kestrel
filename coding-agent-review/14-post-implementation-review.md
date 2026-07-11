# Post-Implementation Review

## Executive judgment
overreached and needs pruning

The implementation solves part of the intended coding-agent gap, but it ships materially more than the stated pass scope and introduces avoidable lifecycle and grounding risk. The durable `workPlan` state is the largest issue: it has no task identity/reset boundary, and it can mark completion from weak signals. Finalize/reporting still presents model-authored fields in an authoritative-looking structure without hard runtime provenance checks.

## Intended scope vs shipped scope
| area | intended by pass docs | actually shipped | verdict |
| --- | --- | --- | --- |
| Planner/Thinker/Observer consume coding intent | Add coding-intent consumption with minimal topology change | Added coding ordering rules, repo-grounding promotion, read-only guardrails, coding convergence/finalize guards | in-scope |
| Decision verification contract | Additive `verificationSteps`, `expectedRepoDelta`, `blockedBy`; blocked coding enforcement | Added fields across schema/types/compiler; enforced `blockedBy` for coding `cannot_satisfy` + blocked finalize | in-scope |
| Durable coding work artifact | Compact durable `react.workPlan` seeded/progressed/reconciled through planner/thinker/observer | New `codingWork.ts`; persistent merge/progress/reconcile logic; observer convergence/finalize now depends on this lifecycle | in-scope (implementation overbuilt) |
| Coding finalize/reporting | Normalize coding finalize payload and gate premature finalize | Observer normalizes fields and completion state; acter forwards payload | in-scope |
| Skill-pack/preset host-shell posture | Preserve `dev.shell.*` when already allowed; update coding preset/task wording | `cli/runtime/skillPacks.ts` and `src/operatorShell.ts` updated exactly for this | in-scope |
| Supporting runtime/context changes | Not described as a primary pass target | Large additional changes in `ContextBuilder`, dev-shell observer policy in `compileIntent`, and dev-shell diagnostic/identity logic in `acter` | overreach |

## What is demonstrably correct
- finding: Coding intent fields are truly wired extractor -> context -> planner/thinker/observer.
  - evidence: `agents/reference-react/src/steps/extractor.ts` schema + prompt fields; `agents/reference-react/src/toolIntent.ts` parsing/context projection; downstream consumption in `steps/planner.ts`, `steps/thinker.ts`, `steps/observer.ts`.
  - why it matters: This is the core intended behavioral upgrade and it is implemented, not only documented.

- finding: `blockedBy` is runtime-enforced for coding blocked outcomes.
  - evidence: `agents/reference-react/src/decision/compileIntent.ts` `validateCodingVerificationConsistency` enforces `verification.blockedBy` for coding `cannot_satisfy` and blocked finalize states.
  - why it matters: Prevents silent blocked exits without explicit blocker declaration.

- finding: Observer now applies coding finalize gating beyond generic evidence-sufficiency.
  - evidence: `agents/reference-react/src/steps/observer.ts` checks `needsVerificationPendingGuard`, `codingWorkPlanHasOpenRequiredItems`, and rejects invalid `implemented_and_verified` claims.
  - why it matters: Reduces premature coding finalization in turns with open implementation/verification work.

- finding: Code skill pack now preserves profile-allowed host-shell tools without policy bypass.
  - evidence: `cli/runtime/skillPacks.ts` adds `dev.shell.*` only from existing profile allowlist; does not invent tools outside profile.
  - why it matters: Enables coding workflow parity while preserving operator policy boundaries.

## Highest-confidence problems
### 1) `workPlan` has no task identity or reset semantics
- severity: high
- classification: proven
- affected files:
  - `agents/reference-react/src/codingWork.ts`
  - `agents/reference-react/src/steps/planner.ts`
  - `agents/reference-react/src/steps/thinker.ts`
  - `agents/reference-react/src/steps/observer.ts`
- evidence:
  - `CodingWorkPlan` has no task key in `types.ts` / `codingWork.ts`.
  - `mergeCodingWorkPlan` merges by static phase IDs only (`grounding`, `implementation`, `verification`, `reporting`).
  - planner/thinker/observer repeatedly call `mergeCodingWorkPlan(readCodingWorkPlan(reactState.workPlan), seedCodingWorkPlan(...))` with no objective-change reset check.
- why it matters:
  - State can carry across unrelated coding requests and bias convergence/finalization with stale statuses.
- recommended correction:
  - Add task identity (objective hash or explicit task id) and hard reset/reseed when identity changes.

### 2) `workPlan` marks completion from weak signals
- severity: high
- classification: proven
- affected files:
  - `agents/reference-react/src/codingWork.ts`
- evidence:
  - `reconcileCodingWorkPlanAfterAction` marks phase `done` when `hasUsefulActionResult(lastActionResult)` is true.
  - `hasUsefulActionResult` only checks `lastActionResult.kind` exists, not success semantics (exit code, mutation success, verification pass/fail).
- why it matters:
  - Completion state can be advanced without proving successful implementation or validation.
- recommended correction:
  - Gate phase completion on action-specific success contracts (command exit status, mutation acknowledgment, verification result schema).

### 3) Trailing observer-cycle counter no longer counts trailing cycles
- severity: medium
- classification: proven
- affected files:
  - `agents/reference-react/src/context/ContextBuilder.ts`
- evidence:
  - In `countTrailingSameEvidenceObserverCycles`, non-observer entries changed from `break` to `continue`.
  - Function name and use imply trailing-consecutive semantics; `continue` allows skipping intervening steps and counting older observer entries.
- why it matters:
  - Repetition/recovery signals can be inflated, affecting observer policy decisions outside coding flows.
- recommended correction:
  - Restore consecutive-trailing behavior (`break` on first non-observer entry).

### 4) Contract surface grew faster than runtime enforcement
- severity: medium
- classification: proven
- affected files:
  - `agents/reference-react/src/decision/DecisionEnvelope.ts`
  - `agents/reference-react/src/decision/compileIntent.ts`
  - `agents/reference-react/src/steps/planner.ts`
  - `agents/reference-react/src/steps/thinker.ts`
- evidence:
  - New fields `verificationSteps` and `expectedRepoDelta` are added across schema/types/compiler and injected by planner/thinker defaults.
  - Runtime policy checks only enforce `blockedBy` semantics; there is no execution-time verification that `verificationSteps` or `expectedRepoDelta` match actual observed outcomes.
- why it matters:
  - Shared contract complexity increases while enforceable guarantees do not increase proportionally.
- recommended correction:
  - Either add deterministic enforcement against runtime evidence or demote these fields from core verification contract.

### 5) Coding finalize report fields are only partially grounded
- severity: medium
- classification: proven
- affected files:
  - `agents/reference-react/src/steps/observer.ts`
  - `agents/reference-react/src/steps/acter.ts`
  - `cli/output/FinalizePayload.ts`
- evidence:
  - Observer `ensureCodingFinalizeAction` now derives `changedFiles`, `checksRun`, and `checksFailed` from runtime/tool traces when available and labels them `runtime_linked`.
  - `blockers` and `completionState` still use runtime/work-plan linkage paths.
  - `summary` and `residualRisks` remain model-authored/defaulted narrative fields.
  - `acter` `buildFinalizePayload` forwards these fields largely unchanged into final payload data; no strict provenance mode is enabled in this path.
  - CLI parser accepts any `data` object shape as long as `message` exists.
- why it matters:
  - Operator-facing payload is improved for trace-backed fields, but narrative fields can still appear more factual than they are.
- recommended correction:
  - Keep explicit provenance labeling and add stricter handling for narrative fields (`summary`, `residualRisks`) in a follow-up pass.

## Durable work-plan assessment
- justified or not justified:
  - Not justified in current form.

- what runtime problem it actually solves:
  - It gives observer/planner/thinker a persistent progress scaffold under compaction and multi-step coding turns.

- what risk it introduces:
  - No task identity/reset boundary creates ownership ambiguity and stale carry-over risk.
  - Completion semantics are weak, so persistent state can drift from real execution truth.

- whether a smaller design would have worked better:
  - Yes. A smaller scoped progress record keyed to task identity, with completion derived from explicit action outcomes, would provide inspectability without adding broad lifecycle coupling.

Task identity, reset semantics, completion semantics, ownership:
- task identity: missing (proven).
- reset semantics: missing on objective change (proven).
- completion semantics: too weak (`lastActionResult.kind`-level) (proven).
- ownership: shared mutable state across planner/thinker/observer without task boundary (strong inference from merge behavior).

## Finalize/reporting grounding assessment
### Evidence-backed fields
- `goal` (from `reactState.goal` in `acter` finalize payload build).
- `plan` (from `reactState.plan`).
- `lastActionResult` (from runtime state).
- artifact UI payload when sourced from explicit finalize UI artifacts and/or validated `KCHAT_ARTIFACT_MANIFEST` promotion path.
- `changedFiles` when derived from runtime tool traces.
- `checksRun` when derived from dev-shell/runtime traces.
- `checksFailed` when derived from dev-shell/runtime traces.
- `blockers` when linked from `verification.blockedBy`.
- `completionState` when inferred from work-plan state.

### Narrative or weakly grounded fields
- `summary`
- `residualRisks`

These remain primarily model-provided and observer-normalized/defaulted; they are not yet reconciled against a strict runtime evidence contract in this path.

Does the current design risk overstating certainty to operators? **Partially.**
Trace-backed fields now reduce the trust gap, but narrative/defaulted fields can still overstate certainty.

## Top 3 follow-up fixes
1. Add `workPlan` task identity + reset in `agents/reference-react/src/codingWork.ts` and all call sites (`planner.ts`, `thinker.ts`, `observer.ts`).
   - Why now: prevents stale-state cross-task corruption, the highest lifecycle risk.

2. Replace weak `workPlan` completion transitions with explicit success contracts in `codingWork.ts` and action/result adapters.
   - Why now: current completion can advance without proving implementation/verification success.

3. Tighten narrative finalize fields (`summary`, `residualRisks`) with stronger provenance treatment in `observer.ts` + `acter.ts`.
   - Why now: remaining operator trust gap is concentrated in narrative reporting fields.

## Bottom line
Keep:
- additive coding-intent extraction/consumption,
- `blockedBy` enforcement,
- bounded host-shell skill-pack alignment.

Prune:
- unrelated supporting scope pulled into this pass set (broad dev-shell/context policy changes).

Tighten before additional coding-agent expansion:
- task-scoped `workPlan` lifecycle,
- evidence-true completion semantics,
- provenance-grounded finalize reporting.
