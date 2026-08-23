# Reconcile interrupted requested and child issuance

## Failed behavior

The coordinator persists requested before fallible validation and child reservation. Exceptions can strand requested leases outside recovery. A child reservation followed by failed issuance can also strand capacity.

## Affected work

GitHub issue #414, commit `b974371d8`, coordinator request handling, and recoverable-lease store queries.

## Repair requirements

Every post-request failure must terminalize and clean or remain discoverable for safe idempotent recovery. Child reservation and issuance must be transactional or compensatable. Recovery must never mint replacement authority.

## Done when

- Injected failures after requested persistence, currentness, credential resolution, child reservation, and issued append settle safely.
- Recovery finds and settles remaining requested rows.
- Child capacity is not stranded.

## Depends on

None.

