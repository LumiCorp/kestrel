# Share one atomic ceiling across parent and child invocations

## Failed behavior

A parent lease can invoke while a child holds the parent's remaining request or response-byte capacity. Parent invocation only reads direct parent usage, so combined parent and child authority can exceed the parent ceiling.

## Affected work

GitHub issue #414, commit `b974371d8`, coordinator invocation reservation, and InMemory/Postgres child reservation stores.

## Repair requirements

Parent invocation and child allocation must share store-owned atomic request and response-byte accounting. Operator remaining capacity must include active and committed child allocations.

## Done when

- Parent and all children cannot collectively exceed either ceiling.
- InMemory and Postgres concurrency tests cover parent-versus-child and siblings.
- Remaining-capacity projections include reservations.

## Depends on

None.

