# Bind hydrated Resend domain details to the requested identity

## Failed behavior

After a complete domain list, the adapter retrieves receiving-enabled domain details but does not verify that the returned domain ID matches the requested summary ID. A contradictory successful body is accepted, and health persistence can misinterpret the configured domain as removed.

## Affected work

This repairs [Reject incomplete Resend domain lists as health evidence](16-reject-incomplete-resend-domain-lists.md) in change `026050c75..ffef42701`, specifically `getDomain` and `listDomains` in `apps/web/lib/email/receiving-provider.ts`.

## Repair requirements

Every retrieved domain detail must be identity-bound to the exact requested provider ID before it becomes domain or health evidence. A mismatch is an invalid upstream response and must not update stored domain evidence.

## Done when

- Direct domain retrieval rejects a successful response with another domain ID.
- List hydration rejects a contradictory detail response and preserves existing stored health.
- Focused provider and PostgreSQL regressions cover the mismatch.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
