# Bound Resend management requests

## Useful outcome

Every Resend management request settles within the established hosted external-API deadline, so a blackholed provider cannot permanently occupy worker maintenance or an Organization deletion lock.

## Failed behavior

`ResendHttpReceivingProvider` calls `fetch` without an abort signal. Webhook reconciliation awaits provider calls sequentially inside single-flight maintenance, and deletion awaits them while holding the durable deletion lock. A promise that never settles prevents later receipt, schedule, turn, push, and deletion retries.

## Affected work

This repairs [Reconcile configured Receiving Connections into staged webhooks](41-reconcile-configured-receiving-webhooks.md) and [Decommission Resend receiving before Organization deletion](44-decommission-resend-before-organization-deletion.md) in `38c2712e9..d95a29238`.

## Repair requirements

- Apply one explicit 10-second deadline to every Resend management HTTP request, matching the established hosted external-API bound used by existing App/mobile provider calls.
- Compose the deadline with any caller-provided abort signal without allowing either signal to disable the other.
- Normalize deadline expiry and abort/network failures to the existing redacted `RESEND_RECEIVING_PROVIDER_UNAVAILABLE` contract.
- A timed-out Organization deletion must record the safe retryable deletion failure and release its lock.
- A timed-out reconciliation candidate must record only redacted failed evidence and allow maintenance to continue to receipts, schedules, turns, and push.
- Use fake timers or an injected timeout signal/fetch seam in tests; do not add slow wall-clock tests.

## Done when

- A never-settling fetch reaches a bounded provider-unavailable outcome without content leakage.
- Maintenance continues after a timed-out candidate and a later tick can run.
- Deletion records failure, preserves encrypted cleanup authority, releases the lock, and succeeds on retry.
- All existing provider status and retry contracts remain green.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

None.
