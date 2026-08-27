# Hydrate and admit one received email

## Useful outcome

The receipt worker can retrieve a received email, resolve exactly one eligible private Trigger, and turn provider data into a bounded admitted message with opaque attachment descriptors. Invalid or unauthorized email stops before model work and leaves a safe, stable outcome.

## What changes

- Add the Delivery Attachment schema and additive production migration. Store its receipt, opaque Kestrel ID, server-only provider ID, order and metadata, import state and failure, and eventual Kestrel file ID with uniqueness that allows one ready file per descriptor. Support `available`, `importing`, `ready`, and explicit nonretryable `failed` states.
- Register the receipt consumer in the existing turn-worker process. Retrieve the full email asynchronously with the Receiving Connection's Organization credential.
- Parse To, Cc, Reply-To, and claimed From with an email-address parser. Do not use substring, suffix, keyword, or other heuristic matching.
- Resolve exactly one enabled Trigger by its complete generated address. Reject zero matches and more than one match; do not fan out one email.
- Apply an optional claimed-From filter only as an exact parsed mailbox comparison. A match does not change the actor or Project authority.
- Use the retrieved text body when usable. Otherwise apply one deterministic HTML-to-text conversion. Fail hydration when neither produces a usable body.
- Bound and encode every model-visible field. Treat sender, recipients, reply-to, subject, body, filenames, media declarations, and content IDs as untrusted data.
- Create ordered Delivery Attachment descriptors with opaque Kestrel IDs and server-only Resend IDs. Store provider order, filename, declared media type, provider size, disposition, and content ID, but no temporary download URL.
- Snapshot the matched Trigger revision and move the receipt through queued, hydrating, and admitted states with stable reason evidence.
- Keep provider, parsing, filtering, ambiguity, disabled Trigger, and content failures distinct. Use the existing queue's retry ownership for temporary provider failure; do not add a new heuristic retry cap.
- On every rejected or failed transition that never materializes a Thread, discard hydrated body and content-derived attachment metadata in the same transaction. Retain only the Product Brief's allowed minimal diagnostic metadata.
- Recover interrupted hydration from durable receipt state without duplicating descriptors or changing a terminal disposition.

## Requirements and delivery context

The receipt queue and reconciliation are established by [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md). The Trigger service and its exact private address contract are established by [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md).

Resend's webhook does not contain the full body or attachment sizes. Use the provider retrieval and attachment-list contracts owned by the Organization Receiving Connection. Never treat Resend as Kestrel's durable content store, and never persist its temporary raw-email or attachment URLs.

The receipt remains the authority for hydration and admission only. It must not copy future Thread-turn running or terminal state.

The canonical requirements are in the [Email-Triggered Agent Runs Product Brief](../../email-triggered-agent-runs-product-brief.md).

## Done when

- A valid text email to one enabled Trigger reaches `admitted` with bounded normalized fields, the exact Trigger revision, reserved execution IDs, and ordered opaque attachment descriptors.
- HTML-only email uses deterministic text conversion, while email with no usable body fails before admission.
- Zero or multiple Trigger recipients, an exact claimed-From mismatch, a disabled or rotated Trigger, malformed addresses, and permanent provider failure create no model work and record distinct stable outcomes.
- Temporary provider failure follows existing queue retry and recovery ownership without losing the receipt or duplicating attachment descriptors.
- A nonmaterialized terminal transition removes body, sender, recipients, reply-to, subject, filenames, content IDs, and attachment media metadata atomically.
- The model-visible envelope source data contains no Resend email ID, provider attachment ID, credential, or temporary URL.
- Focused provider, parser, recipient-resolution, filter, body-conversion, bounds, state-transition, scrubbing, retry, and recovery tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

- [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md)
- [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md)
