# Turn Worker Attachment Access Change Design

## Executive Summary

Kestrel One should resolve attached files through a dedicated web-owned endpoint immediately before a durable turn starts runtime execution.

The Fly turn worker sends only the durable turn ID with a purpose-built, short-lived signed attachment ticket. The Kestrel One web process derives the ordered files from durable message links. It rechecks Thread access, file state, and blob availability, then returns short-lived Cloudflare R2 download URLs. The worker passes those descriptors to the existing runtime, which verifies and stages the bytes read-only.

This seam fits the current ownership model. The web process already owns storage credentials, file authorization, and URL signing. The turn worker owns durable execution but intentionally has no storage authority. The design preserves that boundary and removes the unsafe hosted fallback to local disk.

## Requested Outcome

A Kestrel One user can attach a supported file and send a message. The durable turn can read the exact file even when another process executes the turn later.

The change must preserve these rules:

- The database stores durable file identity, not temporary download access.
- The system rechecks authorization when execution begins.
- Delayed and retried turns receive fresh access.
- Revoked, deleted, quarantined, corrupt, cross-Thread, and missing files fail before model execution.
- Runtime verifies the file size and SHA-256 digest.
- The turn worker receives no bucket-wide storage credentials.
- Local development can still use explicit local storage.
- A confirmed missing blob remains visible as durable integrity state until an audited repair verifies the restored bytes.

## Relevant Current Behavior

The composer emits a `data-kestrel-file` part for each attachment. The Thread route extracts each file ID and creates the durable turn. Turn creation locks and validates the file rows, checks live Thread grants, enforces count and size limits, persists the user message, and records ordered links in `thread_message_files` ([Thread route](../../apps/web/app/api/threads/%5Bid%5D/route.ts), [turn store](../../apps/web/lib/turns/store.ts)).

The queue sends only the durable turn ID to pg-boss. The Fly worker later reloads the stored messages and acts as the original author ([turn queue](../../apps/web/lib/turns/queue.ts), [process runtime](../../apps/web/lib/turns/process-runtime.ts)). This is the correct durable model: stable IDs survive queue delay, retry, and process loss.

The failure begins when the worker assembles runtime input. It extracts attachment IDs from the latest user message and calls `resolveThreadAttachmentsForExecution` ([runtime core](../../apps/web/lib/agent/kestrel-runtime-core.ts:266)). The file service then creates a storage adapter inside the worker. An R2 adapter returns a signed URL. A local adapter reads the complete object and base64-encodes it ([file service](../../apps/web/lib/files/service.ts:473)).

The turn-worker contract forbids all `STORAGE_*` configuration ([process contract](../../apps/web/lib/runtime/process-contracts.ts:78)). That is an intentional least-privilege boundary. However, missing `STORAGE_PROVIDER` silently selects local storage under the current working directory ([storage configuration](../../apps/web/lib/storage/index.ts:14)). The hosted worker therefore looked for the R2 object under `/workspace/apps/web/.local/storage` and failed with `ENOENT`.

The runtime materializer already accepts a signed URL. It rejects expired or untrusted sources, checks the exact size and SHA-256 digest, stages the file in a private read-only directory, and removes transient source data from the resulting attachment ([runtime materializer](../../src/runtime/attachments/materialize.ts)). This behavior should remain unchanged.

The existing `kestrel.files.open` route proves that the web process can authorize a Thread file and mint a signed URL ([file-open route](../../apps/web/app/api/kestrel/tools/files/open/route.ts:18)). Its authorization contract is for interactive users and environment runtimes. It should not be weakened to accept a generic worker token plus caller-supplied Thread identity.

## Affected Surface

The change affects a narrow cross-process slice:

- The durable turn worker gains a client for one internal attachment-resolution endpoint.
- The Kestrel One web process gains that endpoint and remains the storage authority.
- The file service exposes a batch resolver that accepts database-derived file identity.
- The existing Ed25519 environment key pair signs and verifies a separate attachment-ticket type. The turn worker still forbids all storage secrets.
- Durable messages, file identities, scope grants, message links, and runner attachment payloads keep their current shapes.
- `file_blobs` gains explicit availability state and observation time. No bytes or temporary access enter the database.
- File download, inventory, Knowledge promotion, and runtime resolution compute effective availability from both file lifecycle and blob availability.
- Runtime materialization keeps its existing download and integrity checks.
- Hosted configuration must distinguish explicit local development storage from missing production storage configuration.

A small schema migration is required for blob availability. No file bytes or signed URLs enter PostgreSQL or pg-boss.

## External Findings That Shaped the Design

Cloudflare states that an R2 presigned URL grants one operation on one object without exposing API credentials. A URL can last from one second to seven days. Anyone holding it can reuse it until expiry, so Kestrel must treat it as a temporary bearer credential and keep it out of logs and durable state. This directly supports the proposed worker download path ([Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)).

Cloudflare recommends temporary credentials when a caller needs several S3 operations through an SDK. Kestrel needs one GET for each attachment. Temporary credentials would give the worker more authority and add S3 client responsibility without improving this path ([Cloudflare R2 authentication](https://developers.cloudflare.com/r2/api/tokens/)).

AWS documents the S3 expiry behavior that R2 emulates: expiry is checked when a request starts. An active download can finish after expiry, but a reconnect after expiry fails. Kestrel should mint each URL immediately before runtime start and mint new URLs for a new durable execution attempt ([Amazon S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)).

Fly exposes app secrets to Machines as environment variables. Giving the worker static R2 credentials would expand the impact of a compromised turn worker across the configured bucket scope. This conflicts with the current no-storage-secret process contract ([Fly app secrets](https://fly.io/docs/apps/secrets/)).

## Options and Candidate Seams

### Give the turn worker R2 credentials

This option requires the least code. The existing file service would mint URLs correctly.

It breaks the current process boundary. Every worker Machine would receive storage credentials. It also leaves silent local fallback in place. The option is rejected.

### Resolve and persist access when the message is queued

The web process could create signed URLs during message submission and store them with the turn.

Queue delay and retry can outlive URL expiry. Persisting bearer URLs also turns temporary authority into durable data. Storing inline file bytes would overload PostgreSQL and pg-boss for attachments up to the current per-turn limit. The option is rejected.

### Stream all file bytes through Kestrel One

The worker could call an authenticated web endpoint that streams each blob.

This provides request-time authorization and hides the R2 URL. It also makes Vercel the attachment data plane. Large files would add bandwidth, duration, and availability pressure to the web process. This remains a fallback if policy later requires revocation during an active download or forbids temporary R2 URLs outside the web process.

### Resolve short-lived object access on demand

The worker calls a narrow internal endpoint after claiming the durable turn. The endpoint derives the complete attachment set from the database and returns fresh, ordered runtime descriptors.

This option preserves stable durable state, current process ownership, direct R2 transfer, runtime integrity checks, and safe retry behavior. It is the chosen seam.

## Proposed Delta

### Internal resolver contract

Add a server-only endpoint under the Kestrel One application, separate from the model-visible file-open tool. Conceptually:

```text
POST /internal/turn-worker/{turnId}/attachments/resolve
Authorization: Bearer <signed-attachment-ticket>

200 OK
Cache-Control: no-store
{
  "version": 1,
  "turnId": "...",
  "attachments": [
    {
      "fileId": "file-...",
      "attachmentId": "file-...",
      "threadId": "...",
      "filename": "document.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 12345,
      "sha256": "...",
      "kind": "file",
      "representationStatus": "staged_file",
      "sourceUrl": "<redacted bearer URL>",
      "sourceUrlExpiresAt": "..."
    }
  ]
}
```

The request contains no organization, user, Thread, message, or file IDs beyond `turnId`. The endpoint reloads those values from durable state. It requires the turn to have an input message and an eligible queued or running state.

The authorization value is a new `TurnAttachmentResolutionTicket`, not an Environment execution ticket and not a shared service token. It uses the existing Ed25519 environment key pair through separate sign and verify functions. Its protected header has a distinct ticket type and version. Its payload contains:

- Audience `kestrel-turn-attachment-resolver`.
- The exact durable turn ID.
- Issued and expiry times with a maximum 60-second lifetime.
- A nonce for correlation and duplicate detection.

The verifier requires the expected ticket type, audience, lifetime, signature, path turn ID, and current eligible turn state. The database must also show that the turn is `running` and is the active turn in its Thread queue. TLS and the short lifetime limit interception risk. The nonce supports correlation and duplicate detection; it does not provide one-time replay prevention. Resolution is idempotent, and a repeated valid request can only resolve the same active turn and attachment set.

The endpoint joins `thread_turns.input_message_id` to `thread_message_files` in ordinal order. It verifies:

- The turn, Thread, message, file, blob, and grant belong to one organization.
- Each attachment still has a live Thread grant.
- Each file is ready, not deleted or quarantined, and has a media type and digest.
- The ordered set still satisfies count and total-byte limits.
- The object exists in R2 before URL signing.

The web process signs one GET URL per object. The current 15-minute lifetime remains suitable because signing occurs immediately before runtime starts. The response and all errors use `no-store` headers. Logs include the turn ID, file ID, request ID, and typed outcome, but never a signed URL or attachment ticket.

### Blob availability

`file_blobs` gains fields equivalent to:

```text
availability_status: unknown | available | missing
availability_checked_at: timestamp
```

This state is separate from `scan_status` and `deleted_at`. Scan state describes malware inspection. Deletion state describes garbage-collection intent. Availability describes whether the immutable object exists in managed storage.

A successful upload sets `available`. Existing rows migrate to `unknown` because their present database state does not prove current object existence. The resolver performs one HEAD check before using an unknown blob, then records `available` or `missing`. A confirmed R2 `404` sets `missing` and records the observation time. Cloudflare documents that R2 object reads and deletions are strongly consistent through the S3 API, so the resolver should treat that result as durable evidence rather than a propagation delay ([Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)). Transport errors, authentication failures, throttling, and R2 `5xx` responses do not change availability.

File identities and grants remain intact when a blob is missing. Effective execution availability becomes:

```text
file.lifecycle_state == ready
and blob.availability_status resolves to available
and blob.deleted_at is null
```

An audited reconciliation may return a blob to `available` only after reading the object and verifying its recorded size and SHA-256 digest. This avoids conflating restoration with a successful HEAD request.

All byte consumers must use this effective state. Download routes, runtime resolution, file inventory, and Knowledge promotion must reject a missing blob. User-facing metadata can retain the file identity and explain that its content is unavailable. This prevents one ready file row from bypassing shared blob state.

### Worker behavior

The worker resolves attachments after it claims the turn and reloads messages, but before it calls `agent.stream`. Empty attachment sets require no remote call.

The worker compares the response to the stable message parts and rejects missing, extra, duplicate, or reordered files. It then supplies the returned descriptors to runtime input instead of asking the local process for a storage adapter.

A new durable execution attempt resolves attachments again. Reattachment to an already-running environment execution does not remint URLs or replay `run.start`; the original runtime has already materialized its files.

### Runtime behavior

Runtime downloads each URL immediately during attachment materialization. Existing destination, expiry, size, digest, permission, and cleanup checks remain authoritative.

The runtime must not log the full URL. A download failure reports the file ID and a stable failure code. The signed query string is excluded from errors and telemetry.

### Failure contract

The resolver returns stable classes:

- `ATTACHMENT_ACCESS_UNAUTHORIZED`: the attachment ticket is invalid, expired, mismatched, or incorrectly signed. This is an operational or security failure.
- `ATTACHMENT_SET_INVALID`: durable message links conflict with the turn. This is a permanent contract failure.
- `ATTACHMENT_UNAVAILABLE`: a file is revoked, deleted, quarantined, incomplete, or outside the Thread. This is permanent for the current turn and safe to show in user-facing language.
- `ATTACHMENT_BLOB_MISSING`: R2 confirms that a ready blob does not exist. The resolver records missing availability and emits durable repair evidence.
- `ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE`: R2 or signing could not be reached or confirmed. This is retryable before `run.start`.

The worker may retry only the temporary source failure within the existing job attempt policy. It must not retry authorization, contract, or unavailable-file failures as though they were infrastructure noise.

### Fail closed in hosted processes

`local` remains a valid explicit provider for development and hermetic tests. Missing or unknown `STORAGE_PROVIDER` must not silently select local storage in a hosted web or worker role.

The web and control process configuration gates already require storage settings. The turn-worker gate must continue to forbid them. A hosted attempt to instantiate managed file storage inside the turn worker should raise a clear process-boundary error before any filesystem path is constructed.

```mermaid
sequenceDiagram
    participant U as User
    participant W as Kestrel One web
    participant D as PostgreSQL
    participant Q as Durable turn worker
    participant R as Cloudflare R2
    participant X as Workspace runtime

    U->>W: Send message with file IDs
    W->>D: Validate and persist message, links, and turn
    Q->>D: Claim turn and load stable attachment links
    Q->>W: Resolve turn ID with signed attachment ticket
    W->>D: Recheck turn, links, file state, and grants
    W->>R: Confirm each object exists
    W-->>Q: Ordered descriptors with short-lived GET URLs
    Q->>X: Start run with attachment descriptors
    X->>R: Download each object
    X->>X: Verify size and SHA-256; stage read-only
```

## Transition and Coexistence

Local single-process development can continue to resolve explicit local storage directly. Hosted durable turns must use the internal resolver.

During rollout, old workers still contain the broken direct-storage path. The schema and web endpoint can ship before the worker uses them. Existing blob rows backfill to `unknown`; the resolver establishes availability on first use. This avoids asserting that historical database state proves current object existence.

The coexistence period ends when every active turn-worker Machine uses the resolver and the production contract rejects hosted local fallback. No file or grant cleanup is required.

## Decisions

- The web process remains the storage authority. Confidence: high.
- The turn worker keeps no R2 credentials. Confidence: high.
- Durable state keeps file IDs and digests, not signed URLs or bytes. Confidence: high.
- A dedicated internal batch resolver owns turn materialization. Confidence: high.
- The resolver derives the attachment set from `turnId`; it does not trust caller-supplied file or Thread IDs. Confidence: high.
- Runtime keeps final byte-integrity authority. Confidence: high.
- The current 15-minute signed URL lifetime remains. Confidence: medium. Reopen this choice if production download telemetry shows that requests do not start within that window.
- Use a distinct 60-second attachment ticket signed with the existing Ed25519 environment key pair. Keep its type, audience, claims, sign function, and verifier separate from Environment execution tickets. Confidence: high.
- Add explicit blob availability state. Confirmed R2 `404` marks the shared blob missing, while file identities and grants remain available for diagnosis and restoration. Confidence: high.
- Treat the signed ticket as service authentication, not Machine ownership. Require the database turn to be running and active for its Thread, and keep resolution idempotent within the short ticket lifetime. Confidence: high.

## Research and Prototype Findings

The trace found no missing protocol mechanism. `RunnerTurnAttachment` already accepts `sourceUrl` and `sourceUrlExpiresAt`. Runtime already downloads and verifies those sources. The web storage adapter already signs R2 GET URLs. PostgreSQL already retains the stable, ordered file links needed for batch resolution.

The design therefore does not need a prototype. The uncertainty was boundary ownership, not platform capability.

## Remaining Design Questions

No question blocks this design. The 15-minute signed URL lifetime should change only if production telemetry shows that attachment requests routinely fail to start within that window.
