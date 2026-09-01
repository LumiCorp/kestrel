# Validate before cleanup DONE repair

## Failed behavior

Engine recovery sees a FAILED cleanup effect with a DONE result and marks the
effect DONE before validating the exact release output. Malformed or legacy
DONE evidence is then correctly rejected, but the effect has already become
terminal and can no longer retry. The reset-raced-to-DONE branch has the same
validation ordering gap.

## Affected work

[Validate exact cleanup DONE evidence](06l-validate-exact-cleanup-done-evidence.md),
commit `68602937f`, especially
`ExecutionEngine.prepareFailedPreparedApprovalCleanupForResume` and the shared
exact DONE validator.

## Repair requirements

Validate the exact effect/result pair before any FAILED-to-DONE repair. When a
reset reports that another worker completed the effect, re-read the current
result and validate it before marking or accepting DONE. Malformed DONE evidence
must leave the effect nonterminal and fail closed without blocking corrected
exact evidence from later convergence.

## Done when

- FAILED effect plus wrong-call, extra-field, errored, or otherwise malformed
  DONE result is rejected while the effect remains FAILED.
- Exact DONE evidence repairs FAILED to DONE and recovers terminal cleanup.
- A reset-to-DONE race re-reads and validates current evidence before mutation.
- Engine/Web tests prove malformed evidence can be corrected and then converge.

## Depends on

[Validate exact cleanup DONE evidence](06l-validate-exact-cleanup-done-evidence.md).
