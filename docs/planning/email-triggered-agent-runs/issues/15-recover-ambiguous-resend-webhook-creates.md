# Recover an ambiguous Resend webhook create without creating another webhook

## Failed behavior

If Resend accepts a webhook create but Kestrel loses or cannot parse the response, the adapter has no webhook ID in memory. Retrying create can register a second enabled webhook while the first remains untracked. The focused tests retain the first successful response and therefore do not cover this process-boundary failure.

## Affected work

This repairs [Make Resend webhook staging recoverable after every provider step](11-stage-resend-webhooks-recoverably.md) in change `75509729d..b09009a6f`, specifically the create boundary in `apps/web/lib/email/receiving-provider.ts` and the later staging contract prepared for signed ingress.

## Repair requirements

Treat the exact opaque Kestrel endpoint and `email.received` event set as durable create intent before calling Resend. When create has an ambiguous outcome, reconciliation must use Resend's webhook list and retrieve capabilities to recover the matching provider ID and signing secret before any further create attempt. A retry must fail closed on no match or multiple conflicting matches and must never enable delivery from an untracked webhook. Keep the adapter unused by production until signed ingress owns durable staging and activation.

Resend currently documents idempotency only for email-send endpoints, while webhook retrieve and list expose recoverable webhook configuration and signing-secret evidence. Do not assume undocumented webhook-create idempotency.

## Done when

- A restart-style test loses the first create response and does not retain its in-memory result, then recovers the exact webhook by durable endpoint intent without a second POST.
- Malformed create responses, zero matches, and multiple matching webhooks fail closed with stable redacted evidence.
- Reconciliation retrieves the signing secret and verifies the exact endpoint, status, and `email.received` event set before later staging may continue.
- No production call site registers or activates a webhook in this repair.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
