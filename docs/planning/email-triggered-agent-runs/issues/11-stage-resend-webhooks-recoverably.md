# Make Resend webhook staging recoverable after every provider step

## Failed behavior

The provider adapter creates an enabled Resend webhook, then disables and retrieves it before returning the webhook ID and one-time signing secret. If either follow-up request fails, Kestrel loses the only recovery identity and secret while the provider may retain an enabled webhook; retrying can create another webhook.

## Affected work

This repairs [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md) in change `514b6a8a1..9fff57b6d`, specifically `ResendHttpReceivingProvider.createWebhook` in `apps/web/lib/email/receiving-provider.ts` and the adapter contract prepared for later ingress activation.

## Repair requirements

Webhook creation must expose a durable boundary immediately after Resend returns the new webhook ID and signing secret. Disabling, retrieving, and reconciling that webhook must be separately recoverable, and retry after a partial failure must resume from the known provider ID rather than blindly create another webhook. No implementation slice may leave delivery enabled without a tracked Organization connection and secret.

## Done when

- Failures immediately after create and immediately after disable retain enough typed evidence for durable reconciliation.
- Retrying either partial-failure state does not issue another create request.
- Focused adapter tests cover create, partial failure, reconciliation, and removal without exposing the signing secret publicly.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
