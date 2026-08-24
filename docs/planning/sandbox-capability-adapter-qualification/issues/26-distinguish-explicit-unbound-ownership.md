# Distinguish explicit unbound ownership

Status: repaired

## Defect

Legacy rows with unknown tenant ownership and newly created tenant-unbound runs both used a null tenant ID. Prestarted-run validation therefore could not fail closed for legacy authority without also rejecting supported new tenant-unbound execution.

## Repair

Persist a closed ownership state (`legacy_unknown`, `explicit_unbound`, or `tenant_bound`) on runs and effects. New writes declare their state; legacy rows retain `legacy_unknown`. Prestarted validation requires the run and all effects to carry one exact compatible state.

## Evidence

In-memory and PGlite tests prove new explicit-unbound runs validate and legacy-unknown rows remain rejected.

