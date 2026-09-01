# Prevent an older stored-key check from overwriting newer durable health

## Failed behavior

Stored-key health checks verify only that the encrypted key is unchanged before persisting. Two checks using the same key therefore write in provider-completion order, so an older slow failure or empty result can overwrite a newer successful recovery and become the next server-owned projection.

## Affected work

This repairs [Prevent an older One receiving check from repainting newer health](17-prevent-stale-one-receiving-refreshes.md) and [Keep receiving health evidence truthful after failed checks](10-persist-and-present-receiving-health.md) in change `026050c75..ffef42701`, specifically stored-health persistence in `apps/web/lib/email/receiving-config.ts`.

## Repair requirements

Every stored-key check needs a server-owned monotonic invocation identity established before provider I/O. Only the newest started check for the unchanged Organization credential may persist success, failure, domain, or timestamp evidence. Key rotation and candidate-key isolation remain authoritative.

## Done when

- A newer successful recovery cannot be overwritten by an older late failure or empty result.
- A newer failure cannot be cleared by an older late success.
- Deferred-provider PostgreSQL regressions cover both completion orders with the same encrypted key.
- The affected issues' original outcomes and constraints still hold.

## Depends on

None.
