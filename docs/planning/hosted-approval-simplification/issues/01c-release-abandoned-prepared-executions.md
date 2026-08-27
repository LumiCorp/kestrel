# Release prepared execution resources when approval will not execute

## Failed behavior

Preparing an approval retains a pinned execution source. The source is removed
and released only when execution occurs; decline, abandonment, and registry
close clear state without releasing every retained source. Repeated declined
approvals can accumulate snapshot, provider, or handler resources on a
long-lived worker.

## Affected work

[Persist the exact tool invocation before approval](01-persist-prepared-invocation.md),
commit `20f1c39fe`, especially `tools/runtime/UnifiedToolRegistry.ts`, the
runtime IO contract, and the decline path in
`agents/reference-react/src/steps/acter/policyGates.ts`.

## Repair requirements

Every terminal path that will not execute a prepared call must release its
retained execution source exactly once. Execution, decline, expiry,
abandonment, and registry shutdown must remain race-safe and must not release a
source that can still execute.

## Done when

- Decline, expiry/abandonment, successful execution, failed execution, and
  registry close release retained sources exactly once.
- Focused lifecycle tests cover non-execution cleanup and duplicate release.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
