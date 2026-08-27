# Serialize cleanup release and audit quarantine

## Failed behavior

Two live runners can both reset/reclaim a quarantined cleanup effect and invoke
the release handler before either records a result. Although final evidence is
consistent, the exact release is called twice. Quarantine also preserves invalid
output only in the replaceable result row; the normal reset deletes that row, so
the audit evidence disappears after retry begins.

## Affected work

[Quarantine invalid cleanup DONE evidence](06n-quarantine-invalid-cleanup-done-evidence.md),
commit `2c5d3d348`, especially cleanup claim/reset/handler execution, PostgreSQL
effect row locking, quarantine, reset, and run-event persistence.

## Repair requirements

Serialize cleanup release execution under the exact effect identity with a
crash-releasing store lease/critical section. A concurrent runner must wait,
then re-read exact DONE evidence and skip the handler; it may not steal a live
CLAIMED cleanup solely because no result exists. Preserve crash recovery and
bounded reconciliation. In the same quarantine transaction, append durable
sanitized audit evidence containing the invalid result identity/output/error
and original timestamp before the replaceable result is reset. Use existing
append-only run events; do not add a schema migration. Ordinary effects remain
unchanged.

## Done when

- Two concurrent public-store runners after quarantine invoke the exact release
  once and converge DONE/DONE.
- A crash while holding cleanup execution ownership releases the lease and a
  later runner converges.
- Quarantine audit remains queryable after reset and successful exact retry.
- PostgreSQL and in-memory tests cover concurrency, crash recovery, audit
  persistence, exact DONE recheck, and ordinary-effect isolation.

## Depends on

[Quarantine invalid cleanup DONE evidence](06n-quarantine-invalid-cleanup-done-evidence.md).
