# Quarantine invalid cleanup DONE evidence

## Failed behavior

Pending or claimed cleanup effects accept any persisted DONE result because the
ordinary replay validator skips release effects. Execution then reports cleanup
complete without proving the exact prepared call was released. Conversely, a
FAILED cleanup effect with malformed legacy DONE evidence now fails closed but
has no public store transition to preserve/quarantine that evidence and retry,
so it remains stranded forever.

## Affected work

[Validate before cleanup DONE repair](06m-validate-before-cleanup-done-repair.md),
commit `183880df4`, especially EffectRunner DONE replay/claim-race branches,
pending-effect terminalization, cleanup reset, and effect-result persistence.

## Repair requirements

Run the shared exact cleanup DONE validator before every DONE result is accepted
or any cleanup effect is marked DONE, including existing-result replay,
claim-race replay, and pending-effects terminalization. Add an atomic
cleanup-only store operation that validates exact marker/owner/tenant identity,
preserves malformed output as audit evidence, marks it invalid/retryable, and
resets the matching effect so the idempotent exact release can run. Ordinary
effect replay and first-writer semantics remain unchanged.

## Done when

- PENDING, CLAIMED, or FAILED cleanup plus malformed DONE cannot terminalize.
- Malformed DONE is quarantined through the public in-memory/PostgreSQL store
  contract, remains auditable, and allows one exact release retry to converge.
- Existing exact DONE remains immutable and terminal; conflicting ordinary
  effects are refused.
- Engine/Web/PostgreSQL tests use only public store APIs and cover malformed
  pending, claim-race, failed, quarantine, retry, and final convergence.

## Depends on

[Validate before cleanup DONE repair](06m-validate-before-cleanup-done-repair.md).
