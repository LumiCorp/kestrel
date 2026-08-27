# Decommission Resend receiving before Organization deletion

## Useful outcome

Deleting an Organization removes its Resend receiving webhook before Kestrel erases the credential and provider identity needed to manage that external resource.

## Failed behavior

Organization deletion currently reconciles managed compute and Environments, then deletes the Organization. The Receiving Connection cascades away with its encrypted API key, webhook ID, signing secret, and locator, but the provider webhook remains staged or active and continues calling a dead route that Kestrel can no longer decommission.

## Affected work

This repairs [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md) in change `1dca25008..65a832172`, specifically provider-resource lifecycle ownership across `apps/web/lib/organizations/deletion.ts`, `apps/web/lib/email/receiving-config.ts`, and `apps/web/lib/email/receiving-provider.ts`.

## Repair requirements

- Make ingress unavailable durably before any provider decommission request. Organization deletion must accept no new receipt while cleanup is pending or retrying.
- Reconcile a persisted or ambiguous webhook create through its existing intent before removal. Never assume that a missing local provider ID proves no provider webhook exists.
- Remove the provider webhook idempotently with the stored Organization credential and verify the provider-owned resource is absent before deleting the Organization row.
- Integrate decommissioning into the existing durable Organization deletion operation and lock. Provider timeout, credential failure, ambiguous evidence, or verification failure must keep the operation retryable and preserve the encrypted authority needed for another attempt.
- A successful provider deletion followed by process or database failure must be safe to retry; provider `404` remains idempotent absence evidence.
- Keep deletion status and support evidence redacted. Do not expose credentials, secrets, locator, provider ID, domain, endpoint, or email metadata.

## Done when

- Staged and active webhook fixtures are disabled at Kestrel ingress, removed at Resend, verified absent, and only then cascaded with the Organization.
- Ambiguous-create evidence is reconciled without a second create and the discovered provider webhook is removed.
- Transient provider failure leaves the deletion operation retryable and preserves the Receiving Connection; retry completes without duplicate external mutation.
- Missing or already-removed provider resources complete idempotently.
- Focused PostgreSQL Organization-deletion, provider-retry, ambiguous-create, ingress-disablement, cascade, and redaction tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

None.
