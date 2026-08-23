# Run hosted turns with verified remote attachments and safe failures

## Useful outcome

A Kestrel One user can attach a supported file, send a Thread message, and receive a response grounded in that file when the durable turn runs on Fly. Queue delay and a new execution attempt do not break access, and the worker never receives storage credentials or falls back to its container filesystem.

This slice connects the worker to the resolver, preserves runtime byte verification, presents actionable failures, and completes the hosted rollout proof.

## What changes

Before each new `run.start`, extract the stable attachment IDs from the persisted input message. If the set is nonempty, mint a 60-second turn attachment ticket and call the internal resolver with only the turn ID. Compare the returned IDs, order, count, size, digest, and media metadata with the persisted message parts before passing descriptors to runtime.

Mint fresh access for every new execution attempt. Do not persist tickets, URLs, or resolved descriptors. When the worker reconnects to an already-running environment execution, preserve the current recovery behavior: do not resolve again and do not replay `run.start`.

Retry only `ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE` before runtime starts, within the existing durable turn retry policy. Treat authorization, attachment-set, unavailable-file, and missing-blob outcomes as permanent for the current turn. Preserve the user's original message when the response fails.

Map stable failures to safe user guidance that says whether to retry, restore access, replace a file, or wait for operator repair. Keep the original failure authoritative if presentation or telemetry also fails. Runtime download errors must identify the permitted file ID but omit the signed URL and provider details.

Keep runtime's existing controls: public HTTPS destination checks, URL expiry, attachment count and total-byte limits, exact size and SHA-256 verification, private read-only staging, removal of transient access from stable results, and cleanup.

Make storage selection fail closed in hosted processes. The turn-worker contract must continue forbidding every `STORAGE_*` variable, and a hosted worker must fail before constructing a `.local/storage` path. Explicit local storage remains available for local development and hermetic tests.

## Requirements and delivery context

Use the endpoint and ticket contract delivered by issue 02. Replace the managed-storage call inside durable turn attachment resolution; do not add R2 credentials, an authenticated byte proxy, signed URLs in queue payloads, or a new worker ownership scheme.

Preserve pg-boss's `{turnId}` payload, Thread serialization, stored message links, runtime protocol limits, and execution reattachment semantics. The deployment order is schema and resolver first, then hosted worker adoption, then rejection of hosted local fallback.

Durable events and metrics must cover resolution start, success, stable failure, retryability, affected file IDs, and runtime integrity failures. Correlate web, worker, R2, and runtime stages with turn and request IDs without recording temporary credentials.

Operators must verify that the Vercel web process has durable storage configuration and the Fly worker has no storage credentials. Support guidance must distinguish retryable source failure, user-correctable file access, and operator-owned missing-blob repair. No new routine maintenance or user training is required.

The canonical requirements are in the [Turn Worker Attachment Access Product Brief](../../turn-worker-attachment-access-product-brief.md).

## Done when

- A regression test spans durable turn creation, worker claim, signed web resolution, ordered descriptor transfer, runtime materialization, and agent start.
- Queue delay and a new execution attempt obtain fresh access, while reattachment to a running execution neither resolves attachments nor replays `run.start`.
- Worker tests prove exact resolver-output comparison, full-set rejection, stable retry classification, preservation of the user message, and safe failure presentation.
- Runtime tests continue proving destination safety, expiry, limits, size, SHA-256, permissions, cleanup, and URL redaction.
- Hosted process-contract tests prove the worker has no storage configuration and cannot instantiate local or managed hosted storage; explicit local tests still pass.
- Production configuration evidence shows durable storage in the Vercel web process and no `STORAGE_*` credential in the Fly turn worker.
- A production smoke uploads a real supported PDF, runs its durable turn on Fly, materializes the verified file, and completes a grounded response.
- Resolution and materialization telemetry supports operator and support triage without exposing tickets, signed URLs, paths, credentials, or raw provider errors.
- `pnpm validate` and the PostgreSQL boundary validation gate pass.

## Depends on

- [Resolve each active turn's attachments at the web storage boundary](02-add-turn-attachment-resolver.md)
