# Make in-memory cleanup quarantine atomic

## Failed behavior

The production in-memory store appends quarantine audit before cloning the
replacement result. A malformed DONE output containing a function or symbol
makes `structuredClone` throw after the append. Every retry appends another
audit event while leaving the result DONE and the effect pending, so cleanup
never converges.

## Affected work

[Redact cleanup quarantine audit](06p-redact-cleanup-quarantine-audit.md),
commit `d1319b52b`, especially
`InMemorySessionStore.quarantinePreparedApprovalCleanupDoneResult` and the
shared quarantine replacement contract.

## Repair requirements

Validate and prepare every fallible quarantine value before mutating in-memory
state. Commit the audit append, quarantined replacement result, and effect
status as one critical-section mutation. A failed preparation must leave all
three surfaces unchanged. Preserve PostgreSQL behavior and ordinary effects.

## Done when

- Function-, symbol-, cyclic-, and otherwise non-cloneable malformed DONE
  output cannot cause a partial in-memory quarantine mutation.
- Repeated quarantine attempts do not duplicate audit events and cleanup can
  continue to one terminal release result.
- Focused tests prove atomic failure behavior and successful retry convergence.

## Depends on

[Redact cleanup quarantine audit](06p-redact-cleanup-quarantine-audit.md).
