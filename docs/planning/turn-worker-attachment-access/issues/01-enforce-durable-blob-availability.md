# Make blob availability durable across every byte consumer

## Useful outcome

Kestrel can tell whether the immutable bytes behind a file identity are available. A confirmed missing object becomes durable integrity state instead of surfacing later as an unexplained filesystem or provider error.

This slice establishes the data and service contract required before the turn resolver can issue temporary access. It also protects existing download, inventory, file-open, and Knowledge flows from treating a ready file row as proof that bytes exist.

## What changes

Add an availability state and observation time to each shared file blob. Existing blobs enter `unknown`; completed uploads enter `available`. Do not scan all historical objects during migration.

Resolve `unknown` lazily before byte access. A successful storage existence check records `available`. Only an exact R2 `404` records `missing`. Transport, authentication, throttling, and server failures leave the durable state unchanged and remain temporary source failures.

Define one shared effective-availability rule: the file is ready, its blob is not deleted, and blob availability resolves to `available`. Apply it to file download, inventory, Knowledge promotion, model-facing file-open, and runtime attachment resolution. Preserve every file identity, grant, message link, representation, digest, and audit record when a shared blob is missing.

Provide an explicit operator repair path. It may restore `available` only after reading the complete object and verifying its recorded byte count and SHA-256 digest. Record the repair as an auditable action. Do not infer repair from changes to file lifecycle, scan state, deletion state, or grants.

## Requirements and delivery context

PostgreSQL remains authoritative for file identity, relationships, digest, and availability. The migration must be additive and compatible with current workers and routes. It must not rewrite messages, revoke grants, delete representations, or backfill content or URLs.

Blob availability, malware scan state, file lifecycle, and deletion intent must remain separate concepts. One blob can back several file identities, so a missing state must block every byte consumer for every reference to that blob.

Use the existing storage adapter's exact-not-found distinction. Do not turn other storage errors into missing state. Preserve current file types, count limits, byte limits, Thread authorization, and local-development behavior.

Expose stable service outcomes needed by later slices: `ATTACHMENT_UNAVAILABLE`, `ATTACHMENT_BLOB_MISSING`, and `ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE`. These outcomes must not expose object keys, filesystem paths, credentials, provider errors, or signed URLs.

The canonical requirements are in the [Turn Worker Attachment Access Product Brief](../../turn-worker-attachment-access-product-brief.md).

## Done when

- The additive migration preserves existing file, blob, grant, message-link, and representation records and initializes historical blobs as `unknown`.
- A completed upload records `available`, and the first successful check of an unknown blob records `available` with an observation time.
- An exact storage `404` records the shared blob as `missing`; transient failures do not change its durable state.
- Download, inventory, Knowledge promotion, file-open, and runtime-resolution tests prove that all consumers enforce the shared effective-availability rule.
- A missing shared blob blocks every referencing file without deleting evidence or changing unrelated lifecycle fields.
- The repair operation restores availability only after a complete read passes exact size and SHA-256 verification, and the operation leaves an audit record.
- PostgreSQL boundary tests cover migration, concurrent checks, shared blobs, missing objects, transient errors, and verified restoration.
