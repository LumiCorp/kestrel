# Resolve each active turn's attachments at the web storage boundary

## Useful outcome

The storage-owning Kestrel One web process can authorize an active durable turn and return temporary access to exactly the ordered files linked to its input message. The turn worker receives no R2 credential and supplies no caller-selected organization, Thread, user, message, or file identity.

This slice creates the authenticated control-plane seam that hosted workers need before they can stop resolving managed files inside their own process.

## What changes

Add a distinct `TurnAttachmentResolutionTicket` to `@lumi/kestrel-environment-auth`. It must have its own protected-header type, version, audience `kestrel-turn-attachment-resolver`, strict claim parser, signer, and verifier. Its claims contain only the exact turn ID, issued time, expiry, and nonce. Its lifetime cannot exceed 60 seconds.

Use the existing Ed25519 environment key pair, but keep attachment-ticket parsing separate from environment execution tickets. Each parser must reject the other credential type. Treat the nonce as correlation and duplicate-detection data, not one-time replay prevention. Repeated resolution for the same active turn must be safe and idempotent.

Add a dedicated internal batch endpoint owned by the web process. The request names only the durable turn ID. The endpoint verifies the ticket and route match, then derives the organization, author, Thread, input message, and ordered attachment set from PostgreSQL. It requires the turn to be `running` and the active turn for its Thread.

Recheck live grants, file lifecycle, scan and deletion state, effective blob availability, attachment limits, duplicates, and stored ordinal order. Reject the complete set if any member is invalid. After confirming each object exists, return a versioned ordered descriptor list compatible with `RunnerTurnAttachment`, with one object-specific R2 GET URL per file and a 15-minute lifetime.

## Requirements and delivery context

Build on the effective-availability service established in issue 01. Reuse the existing durable turn, input-message, `thread_message_files`, file visibility, storage signing, and `RunnerTurnAttachment` contracts. Do not weaken or repurpose `/api/kestrel/tools/files/open`; its browser and runner identity rules remain unchanged.

The endpoint must use `Cache-Control: no-store`. Tickets and signed URLs must never enter PostgreSQL, pg-boss, durable events, logs, error messages, or analytics. Logs may include turn ID, file ID, request ID, stage, and stable result code.

Return the stable codes `ATTACHMENT_ACCESS_UNAUTHORIZED`, `ATTACHMENT_SET_INVALID`, `ATTACHMENT_UNAVAILABLE`, `ATTACHMENT_BLOB_MISSING`, and `ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE`. Only the temporary-source result is retryable. An empty attachment set does not require this endpoint.

The endpoint and schema must be deployable before workers adopt the new path. Existing workers must continue operating during this expansion phase.

The canonical requirements are in the [Turn Worker Attachment Access Product Brief](../../turn-worker-attachment-access-product-brief.md).

## Done when

- Ticket tests reject wrong type, audience, route turn ID, signature, expiry, excessive lifetime, malformed claims, and cross-parser use.
- The endpoint derives the complete attachment set from durable records and returns descriptors in stored message order without accepting caller-selected file scope.
- Resolver tests cover active-turn enforcement, organization and Thread binding, revoked grants, duplicates, reordering, limits, quarantine, deletion, missing blobs, and temporary storage failures.
- Repeating a valid request for the same active turn is safe, while an inactive, completed, queued, or mismatched turn returns no attachment metadata.
- Each successful response contains fresh 15-minute object-specific GET access and `Cache-Control: no-store`.
- Automated redaction checks prove tickets and signed query strings do not appear in durable state, logs, telemetry, or errors.
- Resolution events and metrics distinguish success and each stable failure class by safe correlation fields.

## Depends on

- [Make blob availability durable across every byte consumer](01-enforce-durable-blob-availability.md)
