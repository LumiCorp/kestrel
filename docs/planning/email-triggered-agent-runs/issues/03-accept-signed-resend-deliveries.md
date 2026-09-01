# Accept signed Resend deliveries durably

## Useful outcome

Kestrel One can accept a Resend `email.received` webhook, prove that Resend sent it, and durably record one queued Delivery Receipt before returning success. Provider retries and manual replays do not create duplicate receipt work.

The route remains unavailable for production delivery until the later admission, materialization, attachment, and maintenance slices are ready.

## What changes

- Add the Delivery Receipt schema and additive production migration. Store the Receiving Connection, Svix ID, Resend email ID, event time, state and stable reason, separately clearable normalized email fields, reserved Thread, message, and turn IDs, and eventual Trigger and materialization links. Support `queued`, `hydrating`, `admitted`, `materialized`, `rejected`, and `failed` states without copying later turn execution state.
- Add a dedicated Kestrel One Resend inbound route keyed by the Receiving Connection's opaque locator. Do not route through the generic platform webhook or SDK agent handler.
- Resolve the Receiving Connection and decrypt its signing secret from the path locator before inspecting unverified payload data.
- When inbound receiving is disabled, accept no new receipt and expose no tenant content. Disabling inbound must stop at the route rather than relying on later rejection.
- Read the untouched request body once. Verify the Svix ID, timestamp, and signature before parsing JSON or selecting Organization data from the event.
- Strictly validate the verified payload as the documented `email.received` event. Reject stale or invalid signatures, malformed payloads, and unsupported event types without creating a tenant-selected receipt.
- Insert one queued Delivery Receipt with stable reserved Thread, message, and turn IDs. Do not retain the raw signed body.
- Deduplicate receipts by both Receiving Connection and Svix ID and Receiving Connection and Resend email ID. A manual replay with a new Svix ID but the same Resend email ID must return the existing durable receipt.
- Create a dedicated pg-boss receipt queue in the existing turn-worker process. Treat the queued database record as dispatch intent.
- Return promptly after the receipt and dispatch intent are durable. If the queue send fails or its result is uncertain, existing-style maintenance must find queued receipts and dispatch missing jobs.
- Make concurrent delivery and replay converge on the existing receipt and return its durable state without creating another job identity.
- Add provider-aware route ownership. Do not weaken or reuse the existing Discord-specific webhook assertions.
- After the route and durable receipt path are available, register or reconcile the Organization's single provider webhook in a disabled staged state and persist its encrypted signing secret. This issue owns registration; the final activation issue only enables that existing webhook.
- Record bounded ingress timing, outcome, and internal correlation IDs without logging the route locator, signature, raw body, Trigger address, provider IDs, or email metadata.

## Requirements and delivery context

The current generic webhook route does not own raw Resend verification or durable receipt state. Add a dedicated route and explicit entry in `apps/web/app/route-ownership.manifest.ts`.

Use the existing pg-boss owner in `apps/web/lib/turns/queue.ts` and `apps/web/scripts/turn-worker.ts`. Follow its durable reconciliation and single-flight maintenance patterns. Do not add another execution service or make the HTTP request wait for email retrieval or model work.

Webhook verification proves only that Resend sent the event. Neither route code, logs, UI, nor errors may claim that the email's `From` value is authenticated.

The canonical requirements are in the [Email-Triggered Agent Runs Product Brief](../../email-triggered-agent-runs-product-brief.md).

## Done when

- A valid signed `email.received` request creates one queued receipt and returns only after durable intent exists.
- Concurrent copies, a repeated Svix ID, a manual replay with a different Svix ID for the same Resend email, and an uncertain queue-send result converge on one receipt and one recoverable job intent.
- A disabled Receiving Connection creates no new receipt, while already materialized Threads and turns remain unchanged.
- An invalid or stale signature, malformed JSON, unsupported event, unknown locator, or cross-tenant locator creates no tenant-selected receipt.
- Raw bodies, signatures, locators, private addresses, provider IDs, and email content do not appear in logs, analytics, durable events, or user-visible errors.
- Worker restart and maintenance recover a queued receipt whose pg-boss job is absent.
- One staged provider webhook exists with its signing secret encrypted, and it stays disabled until the complete feature readiness check passes.
- Focused signature, validation, idempotency, concurrency, route ownership, queue recovery, and redaction tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

- [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md)
