# Make blob restoration and its audit event atomic

## Failed behavior

The blob repair verifier commits `availability_status='available'` before inserting the `restore_verified` audit event. If audit insertion fails, the route returns an error while the blob remains available without the required audit record.

## Affected work

This blocks [Make blob availability durable across every byte consumer](01-enforce-durable-blob-availability.md) and follows repair wave commit `6ee822348`. The owning path is `apps/web/lib/files/availability.ts:verifyRestoredFileBlob`.

## Repair requirements

The availability transition and its audit event must commit as one audited operation. If the audit write cannot commit, the blob must not become available. Preserve complete-read verification, exact size and SHA-256 checks, organization and actor attribution, safe errors, and non-destructive evidence.

## Done when

- A successful repair produces both the `available` state and its `restore_verified` audit record.
- An injected audit-write failure leaves the blob unavailable and returns a safe failure.
- Authorization, integrity mismatch, missing object, and temporary storage behavior remain unchanged.
- A focused regression test proves the no-unaudited-transition invariant.

## Depends on

None.
