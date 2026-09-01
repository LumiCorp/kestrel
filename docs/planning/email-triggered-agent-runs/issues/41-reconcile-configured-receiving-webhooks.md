# Reconcile configured Receiving Connections into staged webhooks

## Useful outcome

Every already-configured Organization Receiving Connection acquires its one disabled staged Resend webhook after the signed-ingress release, without requiring an Admin to notice the upgrade and save the same configuration again.

## Failed behavior

Issue 03 calls `stageReceivingWebhook` only after `saveReceivingConnection`. Migration 0087 adds staging state to existing Receiving Connections but does not create provider resources, so a connection configured before the migration remains `not_staged` indefinitely. Issue 08 owns enabling an existing staged webhook and cannot silently take over registration.

## Affected work

This repairs [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md) in change `1dca25008..65a832172`, specifically provider registration in `apps/web/lib/email/receiving-webhook-staging.ts` and maintenance ownership in `apps/web/lib/turns/queue.ts`.

## Repair requirements

- Discover configured, verified Receiving Connections whose webhook has not been staged and reconcile them through the same recoverable provider-staging authority used by an Admin save.
- Use the existing turn-worker maintenance owner. Do not create another service, perform provider I/O in a schema migration, or move registration into the final activation issue.
- Keep the provider webhook disabled and `inboundEnabled` false after reconciliation.
- Bound and deterministically order reconciliation work. One Organization's provider failure must persist its safe staging outcome without preventing schedule, turn, receipt, or push maintenance for other work.
- Preserve the durable create-intent, attempted-create, provider-ID, encrypted-secret, and stale-result contracts. Never blindly repeat an ambiguous create.
- Emit only redacted internal correlation and outcome evidence; do not log credentials, signing secrets, locators, provider IDs, domains, or endpoint URLs.

## Done when

- A pre-0087-style configured row reaches one verified `staged` webhook without another Admin save.
- Repeated maintenance and worker restart do not create a second webhook.
- Incomplete, unhealthy, already staged, or active connections are not registered by this recovery path.
- A failed Organization reconciliation does not abort unrelated worker maintenance and remains safely retryable through the owning durable state.
- Focused PostgreSQL recovery, duplicate, provider-failure, maintenance-isolation, disabled-state, and redaction tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

None.
