# Snapshot exact cleanup evidence once before validation and persistence

## Failed behavior

In-memory cleanup results retain a shared nested output until later validation,
and PostgreSQL validates a live object before separately serializing it.
Post-save mutation or stateful getters can therefore make validation and the
durable result observe different evidence, upgrading invalid proof or
persisting a value that was never validated.

## Affected work

[Preserve exact cleanup success before evidence normalization](06y-preserve-exact-cleanup-success.md),
commit `8f4cdedb9`, especially public cleanup result persistence in both stores.

## Repair requirements

Materialize one isolated stable cleanup DONE snapshot, validate that snapshot,
and persist that same snapshot. Reject or quarantine accessors, proxies, and
values that cannot produce stable exact evidence. Invalid evidence must remain
total, bounded, retryable, and atomic.

## Done when

- Mutation after `saveEffectResult` cannot change validation or stored proof.
- Stateful getters cannot validate one value and persist another.
- Both public production stores prove the same snapshot semantics.

## Depends on

[Preserve exact cleanup success before evidence normalization](06y-preserve-exact-cleanup-success.md).
