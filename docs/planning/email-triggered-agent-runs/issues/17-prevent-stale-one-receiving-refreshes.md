# Prevent an older One receiving check from repainting newer health

## Failed behavior

Kestrel One has no request epoch for receiving operations and clears its busy state before post-check reconciliation finishes. An older failed check can finish after a newer successful check and repaint recovered health and error state with stale evidence.

## Affected work

This repairs [Keep receiving health evidence truthful after failed checks](10-persist-and-present-receiving-health.md) in change `485870e58..f00316da3`, specifically `apps/web/components/settings/receiving-client.tsx`.

## Repair requirements

Only the newest receiving operation and its reconciliation refresh may update connection, domain choices, error, or busy state. Busy state must remain truthful through reconciliation, and unmount or supersession must not produce stale state writes. Preserve write-only keys and server-owned readiness.

## Done when

- A delayed failed check cannot repaint a later successful recovery.
- A delayed successful check cannot clear a later failure or replace its domain choices.
- Busy state remains active through the winning operation's refresh and clears once.
- An executable presentation regression covers the operation ordering.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
