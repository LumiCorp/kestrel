# Reject webhook list and retrieve status contradictions

## Failed behavior

Webhook recovery requires the retrieved webhook to be enabled but does not require its status to agree with the selected list projection. A list result marked disabled followed by a retrieve result marked enabled is accepted as recovered evidence.

## Affected work

This repairs [Prove durable paginated webhook recovery](29-prove-durable-paginated-webhook-recovery.md) in change `14b12c2fe..2fb084dda`, specifically final list-to-retrieve reconciliation in `apps/web/lib/email/receiving-provider.ts`.

## Repair requirements

The retrieved webhook must agree exactly with the selected list projection for provider identity, endpoint, event set, and status, and the mutually agreed status must be enabled before recovery succeeds. Either direction of a status contradiction fails closed with stable redacted evidence. Recovery remains GET-only.

## Done when

- Focused tests reject list enabled to retrieve disabled and list disabled to retrieve enabled.
- Matching enabled evidence still recovers the signing secret.
- No contradiction can trigger another POST or expose provider details.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
