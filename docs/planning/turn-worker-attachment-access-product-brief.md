# Turn Worker Attachment Access Product Brief

## Product Narrative

Kestrel One users can attach files to Thread messages. The upload and message can succeed, yet the durable agent turn can still fail before reading the file. The current turn worker has no Cloudflare R2 storage configuration by design. Shared attachment code mistakes that missing configuration for local development storage and tries to open a file inside the worker container.

Kestrel One must make attached files durable across the web and worker process boundary. When a durable turn begins, the worker must ask the Kestrel One web process for temporary access to the exact files linked to that turn. The web process must derive the attachment set from durable records, recheck current access and storage state, and return short-lived object-specific download URLs. Runtime must verify the downloaded bytes before exposing them to the agent.

Users should experience one dependable flow: attach a file, send the message, and receive a response grounded in that file. Operators should retain a clear process boundary. The web process owns storage access and authorization. The turn worker owns durable execution and receives no bucket credentials.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- A hosted durable turn can read every valid file attached to its input message.
- Queue delay, process separation, and a new execution attempt do not break attachment access.
- The system rechecks the complete ordered attachment set immediately before runtime starts.
- Runtime receives temporary object access and verifies exact size and SHA-256 before use.
- The turn worker remains free of R2 credentials and cannot silently fall back to hosted local storage.
- Missing, revoked, deleted, quarantined, corrupt, cross-Thread, incomplete, or inconsistent files fail with stable classifications before model work begins.
- A confirmed missing R2 blob remains visible as durable integrity state until an audited repair verifies restored bytes.
- Users receive safe, actionable failure language rather than filesystem paths, signed URLs, or internal runtime errors.

The delivery boundary covers Kestrel One hosted Thread attachments from durable message persistence through turn-worker resolution and runtime materialization. It includes attachment download, inventory, Knowledge promotion, blob availability, service authentication, failure presentation, observability, migration, and production configuration checks.

This initiative does not:

- Give turn workers direct R2 credentials.
- Store attachment bytes or signed URLs in PostgreSQL or pg-boss.
- Redesign the composer, supported file-type matrix, Knowledge extraction formats, or Desktop Local Core attachment storage.
- Change per-message attachment count or byte limits.
- Weaken the interactive or model-facing `kestrel.files.open` authorization contract.
- Proxy normal attachment bytes through the Kestrel One web process.
- Add Machine-specific worker ownership or global one-time ticket replay prevention.
- Create an automatic destructive repair for missing blobs.

## Defining Scenarios

### A user sends a valid attached file

The user attaches a ready file and sends a Thread message. Kestrel validates the live Thread grant, file metadata, digest, count, and total bytes. It persists the message, ordered message-to-file links, and durable turn.

The turn worker claims the active Thread turn. It signs a 60-second attachment-resolution ticket for that exact turn and calls the internal Kestrel One resolver. The resolver derives the organization, author, Thread, input message, and ordered files from PostgreSQL. It confirms effective availability and returns 15-minute R2 GET URLs in the same order as the message.

Runtime downloads each object immediately. It checks the trusted destination, expiry, exact size, and SHA-256 digest. It stages the file read-only and starts the agent with the verified attachment. The user receives a normal response grounded in the file.

### A queued turn starts later or begins a new attempt

The durable queue retains file identities and message links, not temporary URLs. When a new execution attempt begins, the worker resolves the attachment set again and receives fresh URLs.

If the worker reconnects to an already-running environment execution, it does not resolve attachments again or replay `run.start`. The running runtime already owns its materialized files.

### File access changes before execution

A file is revoked, deleted, quarantined, marked missing, or moved outside the Thread's effective access before the turn starts. The resolver rechecks current durable state and rejects the complete attachment set.

The worker does not start model execution. The turn records a permanent attachment failure. The user sees that an attached file is no longer available and can send a new message after correcting the file.

### R2 confirms that a blob is missing

The database contains a ready file identity, but an R2 HEAD request returns `404`. R2's S3 API is strongly consistent, so Kestrel records the shared blob as `missing` with the observation time.

The resolver returns `ATTACHMENT_BLOB_MISSING`. Every file identity and grant remains intact for diagnosis and restoration. Download, inventory, Knowledge promotion, and later runtime resolution treat the shared blob as unavailable.

An operator can restore the object through an audited repair path. Kestrel returns the blob to `available` only after reading the restored object and verifying its recorded size and SHA-256 digest.

### Storage cannot be checked temporarily

R2 returns a transport error, authentication error, throttle, or `5xx` response. Kestrel does not change durable blob availability.

The resolver returns `ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE`. The worker may retry before `run.start` within the existing durable job policy. If retries end, the user sees a temporary attachment-service failure and can try again without re-uploading the file.

### A resolver request is invalid

The attachment ticket is expired, incorrectly signed, has the wrong audience, names a different turn, or targets a turn that is not active and running. The web process rejects the request and returns no attachment metadata or signed URLs.

Kestrel records a security or configuration failure without logging the ticket. Operators receive enough correlation data to identify the process and turn.

### Local development uses explicit local storage

A local single-process environment explicitly selects the `local` storage provider. Existing local attachment resolution remains available for development and hermetic tests.

A hosted process with missing or unknown storage configuration fails its process contract. It must not construct a path under `.local/storage` as a fallback.

## Business and Process Requirements

- Kestrel One must report an attachment as usable only when its file lifecycle and shared blob availability allow byte access.
- A ready file identity alone must not prove that its blob is readable.
- Durable turns must retain stable file identity and order across queue delay, retry, and process loss.
- The system must recheck attachment authorization and availability before each new runtime execution attempt.
- One invalid attachment must reject the complete ordered set before model execution.
- Reattachment to an existing runtime execution must not replay attachment resolution or `run.start`.
- Temporary storage failures must remain distinct from permanent authorization, contract, integrity, and availability failures.
- A confirmed missing blob must affect every file identity that references the shared blob.
- Missing-blob handling must preserve file identities, grants, message links, representations, digests, and audit evidence.
- Blob restoration must require an explicit audited operation and byte-integrity verification.
- Users must receive safe language that identifies the affected file when permitted and explains whether correction or retry is appropriate.
- Users must never receive internal filesystem paths, storage credentials, attachment tickets, signed URLs, or raw provider errors.
- Support must be able to distinguish unavailable files, missing blobs, temporary storage failures, invalid attachment sets, and resolver-authentication failures.
- The existing supported file types and attachment limits must remain unchanged.
- The existing user message must remain in the Thread when its agent response fails because of an attachment.

## Technology Requirements

### Ownership and resolution boundary

- The Kestrel One web process must remain the managed-file storage authority.
- The durable turn worker must remain the execution authority and must not receive `STORAGE_*` credentials.
- Hosted attachment resolution must use a dedicated internal batch endpoint separate from browser and model-facing file routes.
- The resolver request must contain only the durable turn ID as resource identity.
- The resolver must derive the organization, author, Thread, input message, and ordered file IDs from durable database records.
- The resolver must require the turn to be `running` and the active turn in its Thread queue.
- The resolver must join the turn's input message to `thread_message_files` in stored ordinal order.
- The resolver must reject missing, extra, duplicate, or reordered attachments.
- The resolver must return a versioned ordered list compatible with `RunnerTurnAttachment`.
- Empty attachment sets must not require a resolver call.

### Attachment-ticket authentication

- `@lumi/kestrel-environment-auth` must define a separate `TurnAttachmentResolutionTicket` credential type.
- The ticket must use a distinct protected-header type, version, and audience `kestrel-turn-attachment-resolver`.
- The ticket payload must contain the exact turn ID, issued time, expiry, and nonce.
- The maximum ticket lifetime must be 60 seconds.
- The ticket must use the existing Ed25519 environment key pair through dedicated sign, parse, and verify functions.
- Environment execution ticket parsers must not accept attachment tickets, and attachment-ticket parsers must not accept execution tickets.
- The resolver must require the ticket turn ID to match the route turn ID.
- The nonce supports correlation and duplicate detection. The system must not claim that the nonce provides one-time replay prevention.
- Resolution must be idempotent for the same active turn during the ticket lifetime.
- Logs and errors must never contain the attachment ticket.

### Durable attachment and blob state

- PostgreSQL must remain the authority for stable file identities, message links, grants, digests, and blob availability.
- `file_blobs` must gain `availability_status` with `unknown`, `available`, and `missing` states.
- `file_blobs` must record when availability was last confirmed or found missing.
- A completed new upload must set blob availability to `available`.
- Existing blob rows must migrate to `unknown`; migration must not claim that historical database state proves object existence.
- An unknown blob must receive a storage existence check before byte access.
- A successful existence check must set the blob to `available` and record the observation time.
- Only an exact R2 `404` may set a blob to `missing`.
- Transport errors, authentication errors, throttling, and `5xx` responses must not change durable availability.
- Malware scan state, deletion intent, file lifecycle, and blob availability must remain separate fields with separate meanings.
- Effective byte availability must require a ready file, a non-deleted blob, and blob availability that resolves to `available`.
- Download, inventory, Knowledge promotion, file-open, and runtime-resolution surfaces must enforce effective byte availability.
- Missing availability must not revoke grants or delete file, message-link, or representation records.
- Restoring a blob to `available` must require a complete read plus exact size and SHA-256 verification.

### R2 access and runtime materialization

- The web process must confirm object existence before signing a runtime descriptor.
- The web process must mint one object-specific presigned GET URL per attachment.
- The URL lifetime must be 15 minutes and begin immediately before `run.start`.
- Signed URLs must not enter PostgreSQL, pg-boss, durable events, application logs, error messages, or analytics.
- Resolver responses and errors must use `Cache-Control: no-store`.
- The turn worker must compare resolver output with the stable message attachment parts before starting runtime.
- Runtime must retain its existing public-HTTPS destination restrictions and expiry checks.
- Runtime must enforce attachment count, total bytes, exact file size, and SHA-256 before exposing bytes to the agent.
- Runtime must stage materialized files in a private read-only directory and remove transient source access from the stable attachment result.
- Runtime and worker telemetry must identify failures by turn ID, file ID, stage, and stable code without including signed query strings.

### Failure and retry contract

- Resolver and worker boundaries must preserve these stable failure codes:
  - `ATTACHMENT_ACCESS_UNAUTHORIZED`
  - `ATTACHMENT_SET_INVALID`
  - `ATTACHMENT_UNAVAILABLE`
  - `ATTACHMENT_BLOB_MISSING`
  - `ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE`
- Only `ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE` is retryable before `run.start`.
- Authorization, set-integrity, unavailable-file, and missing-blob failures must be permanent for the current turn.
- Runtime download failures must identify the file ID and omit the signed URL.
- User-facing failure presentation must map stable internal codes to safe correction or retry guidance.
- The original failure must remain authoritative if failure presentation or telemetry also fails.

### Hosted and local process contracts

- The turn-worker process contract must continue to forbid all storage configuration.
- Web and control processes that own storage must continue to require complete storage configuration.
- Missing or unknown `STORAGE_PROVIDER` must not default to `local` in a hosted process.
- A hosted attempt to instantiate managed storage in the turn worker must fail before constructing a filesystem path.
- Explicit local storage must remain supported for local development and hermetic tests.
- Production configuration validation must prove that the Vercel web process uses durable storage and the Fly turn worker has no storage credentials.

### Migration and coexistence

- The blob availability migration must be additive and preserve existing file, blob, grant, message-link, and representation records.
- Existing blobs must enter `unknown` without a broad synchronous R2 scan during migration.
- The resolver must establish availability lazily on first use.
- The schema and resolver endpoint must be compatible with old workers during the deployment window.
- Hosted workers must switch to remote resolution only after the schema and endpoint are available.
- The transition ends when every active worker uses remote resolution and hosted local fallback is rejected.
- No file-content backfill, URL backfill, grant cleanup, or message rewrite is required.

### Observability and verification

- Durable events must record resolution start, success, stable failure code, retryability, and affected file IDs without recording temporary credentials.
- Operators must be able to correlate web resolution, worker execution, R2 checks, and runtime materialization by turn and request IDs.
- Metrics must distinguish successful resolution, missing blobs, unavailable files, temporary source failures, unauthorized requests, and runtime integrity failures.
- Regression coverage must span durable turn creation, worker claim, signed resolution, ordered descriptor transfer, and runtime materialization.
- Ticket tests must cover wrong type, audience, turn ID, signature, expiry, excessive lifetime, malformed claims, and cross-parser rejection.
- Resolver tests must cover active-turn enforcement, organization and Thread binding, grant revocation, ordering, duplicates, limits, quarantine, deletion, and shared-blob behavior.
- Storage tests must cover `unknown` to `available`, exact `404` to `missing`, and no state change for transient errors.
- Consumer tests must prove that download, inventory, Knowledge promotion, file-open, and runtime resolution all enforce effective availability.
- Runtime tests must continue to cover trusted destinations, expiry, size, SHA-256, permissions, cleanup, and URL redaction.
- Hosted process-contract tests must prove that turn workers cannot instantiate local or managed hosted storage.
- A production smoke must upload a real supported file, start a durable turn on the Fly worker, materialize it in runtime, and complete a grounded response.
- The portable `pnpm validate` gate and PostgreSQL boundary gate must pass before the change is ready to publish.

## People and Operating Requirements

- Thread users own file selection and correction when a file has been revoked, deleted, quarantined, or otherwise made unavailable.
- Thread users must not need to understand R2, worker processes, signed URLs, or runtime materialization.
- Kestrel owns attachment authorization, temporary access, byte verification, retry classification, and safe user-facing failures.
- Kestrel operators own production storage configuration, attachment-ticket key health, resolver availability, and worker rollout state.
- Operators must investigate `ATTACHMENT_BLOB_MISSING` as a data-integrity event rather than a normal retryable failure.
- Operators must use an audited repair path to restore missing blobs and must verify size and SHA-256 before restoring availability.
- Operators must not repair a missing blob by editing file lifecycle, scan state, deletion state, or grants directly.
- Support staff must be able to identify whether a user should retry, replace a file, restore access, or wait for operator repair.
- Security review owns the attachment-ticket type and audience separation, credential redaction, and confirmation that workers retain no storage credentials.
- Release operators must verify the schema and resolver are live before activating the new worker behavior.
- No new user training or ongoing manual attachment-maintenance role is introduced.

## Success and Readiness

Success is observable when:

- The previously failing hosted scenario completes: a user attaches a PDF, sends a message, and receives a response grounded in that PDF.
- The Fly turn worker resolves attachments without any `STORAGE_*` credential or local filesystem fallback.
- Queue delay and a new execution attempt produce fresh URLs without persisting temporary access.
- Reattachment to a running execution does not remint access or replay `run.start`.
- Revoked, deleted, quarantined, cross-Thread, and inconsistent attachment sets fail before model work.
- A confirmed R2 `404` records the shared blob as missing and blocks every byte consumer without deleting evidence.
- A transient R2 failure leaves durable blob availability unchanged and follows the retryable failure path.
- A restored blob becomes available only after its size and SHA-256 pass verification.
- No logs, durable records, error messages, or analytics contain attachment tickets or signed URLs.
- Production configuration proves durable web storage and storage-free workers.
- Focused ticket, resolver, migration, consumer, worker, and runtime tests pass.
- The real production attachment smoke passes.
- `pnpm validate` and the PostgreSQL boundary gate pass.

**Readiness: Ready for issue creation.**

The product behavior, cross-process seam, security boundary, data state, migration, failure rules, operating ownership, and success evidence are settled. The 15-minute URL lifetime may be tuned later from production telemetry without changing these requirements.

## Source Artifacts

- [Turn Worker Attachment Access Change Design](../design/turn-worker-attachment-access-change-design.md)
- [Turn Worker Attachment Access Design Notebook](../../.design/turn-worker-attachment-access/notebook.md)
- [Observed failing Kestrel One Thread](https://kestrelagents.dev/threads/bcca3793-f6b4-4086-89a7-864ef63a6d9a)
