# Reject superseded stored-key receiving saves

## Failed behavior

A stored-key save claims a health-check sequence before provider I/O. If a newer same-key check advances that sequence before the save commits, the save silently skips its database write and then returns the current connection. The API therefore reports success even though it did not select the requested domain.

## Affected work

This repairs [Prevent an older stored-key check from overwriting newer durable health](20-order-stored-receiving-health-checks.md) in change `5528e275b..2e3e8ce68`, including the stored-key save transaction in `apps/web/lib/email/receiving-config.ts` and its route-visible outcome.

## Repair requirements

A stored-key save whose sequence is superseded must fail with a stable, redacted, retry-safe configuration error. It must not mutate the connection, return a successful current-state projection, or produce a successful update audit event. Ordinary same-key checks may still supersede older health-only checks without surfacing an error. Credential rotation and candidate-key isolation must remain unchanged.

## Done when

- A deferred PostgreSQL regression proves a stored-key save superseded by a newer same-key check does not persist the requested domain and rejects instead of returning success.
- The receiving API maps the rejection to a stable non-success response without secret-bearing details.
- Same-key inspection ordering, credential rotation, and candidate-key tests remain green.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
