# Validate exact cleanup DONE evidence

## Failed behavior

The atomic cleanup-success store operation makes DONE prevail over FAILED, but
it accepts a pre-existing DONE result based only on owner and status. It does
not prove that the stored release output names the effect's exact prepared call
or equals the newly supplied exact result, so conflicting DONE evidence can be
silently treated as successful cleanup.

## Affected work

[Atomically commit cleanup release success](06k-atomically-commit-cleanup-release-success.md),
commit `ee3b7f20a`, especially the cleanup-only store operation, prepared-call
payload validation, exact result comparison, and engine DONE recovery.

## Repair requirements

Require a production-shaped prepared tool call on every cleanup release effect
and validate that the supplied DONE output names that exact call. When a DONE
result already exists, accept it idempotently only if owner and canonical exact
output match; otherwise raise a conflict without marking the effect DONE. Apply
the same validation in in-memory and PostgreSQL stores and in recovery. Refuse
ordinary effects and wrong owner, tenant, key, or prepared-call evidence.

## Done when

- Same-output concurrent cleanup success is idempotent and remains DONE/DONE.
- Conflicting existing DONE output is rejected and cannot terminalize cleanup.
- Wrong prepared invocation, owner, tenant, idempotency key, and ordinary effect
  inputs are rejected.
- PostgreSQL and in-memory tests use production-shaped prepared-call/release
  results and prove exact recovery.

## Depends on

[Atomically commit cleanup release success](06k-atomically-commit-cleanup-release-success.md).
