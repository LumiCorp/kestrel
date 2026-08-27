# Bind PostgreSQL result insertion to the locked effect identity

## Failed behavior

PostgreSQL captures and locks one no-intent effect identity, but the generic SQL
insert later re-reads `result.idempotencyKey` and `result.status`. A stateful or
mutated result can use an ordinary same-owner effect as the checked decoy and
insert exact-looking DONE evidence under a cleanup effect ID, which later marks
cleanup complete without release.

## Affected work

[Require immutable cleanup intent for all result statuses](06z6-require-cleanup-intent-for-all-results.md),
commit `50e23e38f`, specifically generic PostgreSQL result insertion after the
effect-row lock.

## Repair requirements

Bind the inserted result identity and status to the immutable values already
used to select and validate the locked durable effect. Do not re-read
caller-controlled identity/status after awaits. Keep ordinary payload
persistence semantics otherwise unchanged.

## Done when

- An ordinary decoy result cannot insert a row under a cleanup target after
  mutation or stateful property reads.
- Inserted idempotency key/status always belong to the locked effect decision.
- Explicit cleanup intent behavior remains unchanged.

## Depends on

[Require immutable cleanup intent for all result statuses](06z6-require-cleanup-intent-for-all-results.md).
