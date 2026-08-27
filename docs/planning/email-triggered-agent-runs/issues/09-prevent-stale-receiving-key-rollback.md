# Prevent a concurrent receiving save from restoring a stale key

## Failed behavior

A domain save that omits the Resend key can validate an older stored key before another client rotates it, then commit second and restore the older encrypted key. The UI reports success even though the newer committed credential has been lost.

## Affected work

This repairs [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md) in change `514b6a8a1..9fff57b6d`, specifically the pre-lock read and upsert in `apps/web/lib/email/receiving-config.ts`.

## Repair requirements

Concurrent Kestrel One and Desktop saves must preserve the newest explicitly supplied credential. A request that omits the key must not overwrite credential ciphertext with a stale pre-lock value, and it must not report success for domain evidence validated with a credential that ceased to be authoritative before commit. Preserve one hosted Organization connection, write-only credentials, encryption, and outbound independence.

## Done when

- A coordinated key-rotation-versus-domain-only-save scenario cannot restore the old key or commit health evidence derived from it.
- A focused PostgreSQL regression check covers both commit orders.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
