# Promote a quarantined browser download

## Useful outcome

On Desktop and Kestrel One, every browser download remains in bounded quarantine until a person approves `browser.download`. Approval publishes one verified Thread-authorized file. Denied, expired, oversized, partial, or orphaned bytes never become visible.

This slice delivers browser download promotion from the [Kestrel Browser App Product Brief](../../kestrel-browser-app-product-brief.md).

## What changes

- Use the host-owned interception hooks delivered by issues 03 and 05 as the only browser download path. Keep engine default download directories disabled.
- Stream each download into per-session quarantine. Limit one item to `CONVERSATION_ATTACHMENT_MAX_FILE_BYTES` (100 MiB), one session to `CONVERSATION_ATTACHMENT_MAX_COUNT` items (20), and total quarantined bytes to `CONVERSATION_ATTACHMENT_MAX_TURN_BYTES` (500 MiB). Import these limits from `packages/conversation/src/attachments.ts`; do not copy literals into runtime policy.
- Expire each item 30 minutes after completion or when its Browser Session ends, whichever comes first. Enforce all limits and expiry from measured streamed bytes and trusted time, not response headers.
- Store only download ID, sanitized filename, measured bytes, SHA-256, response-declared media type as untrusted metadata, normalized source origin, creation time, and expiry. Source origin contains scheme, host, and non-default port only; never username, password, path, query, or fragment.
- Do not infer authority or safety from filename, extension, declared media type, or content. Default a missing media type to `application/octet-stream`. Managed-file representation processing may run only after approved promotion.
- When navigate or interact starts a download, return the shared pending-download descriptor pinned by issue 01: `downloadId`, sanitized filename, measured bytes, untrusted media type, normalized source origin, checksum, creation time, and expiry. Return no host path, object key, credential, or raw quarantine locator.
- Require `browser.download({sessionId, pendingDownloadId})`. Prepare one approval that names the quarantined file, measured size, untrusted media type, source origin, and resulting Thread file. Bind it to session, generation, quarantine ID, checksum, and exact operation ID.
- On hosted Kestrel One, write verified bytes to an unreferenced owned object key. Then commit one visibility transaction that creates the ready `kestrel_files` record, `file_blobs` record, live Thread `file_scope_grants` row, and exact-effect result. Use `apps/web/lib/files/service.ts` and `storage-provider.ts`; do not create `artifact_documents`.
- On Desktop, commit a verified owned temporary file through `DesktopAttachmentStore.importPath`. Publish the local file ID and presentation only after the blob link and attachment index write succeed. No partial file may be visible.
- Present the committed file through `AgentToolArtifactPresentation` and the existing web/mobile artifact projection. The artifact inherits normal Thread authorization and retention. Mobile receives no quarantine access or browser takeover.
- Denial creates no file record or grant. If the visibility commit fails, expose no artifact and retain the quarantine item only until its existing expiry for retry or cleanup. A retry after a completed commit returns the same file ID.
- If commit outcome is unknown, return `BROWSER_ACTION_OUTCOME_UNKNOWN`, do not create a second file, and reconcile the existing operation before accepting another promotion for that quarantine ID.
- Destroy unpromoted bytes on denial, item expiry, session close/loss, engine or worker failure, and startup reconciliation after abnormal termination. Delete only storage whose session/quarantine ownership and checksum are proven. Preserve the primary failure if cleanup also fails.
- Keep file contents, host paths, object keys, credentials, URL paths/queries, form values, and authentication input out of approvals, logs, traces, audits, analytics, metrics, errors, and cleanup evidence.
- Project the file through the existing server-side `artifact` part in `apps/web/lib/mobile/message-parts.ts`. Verify compatibility against the current Kestrel One Mobile artifact contract without adding a Browser-specific mobile endpoint, viewer, takeover action, or native-client feature to this issue.

## Requirements and delivery context

Issues 03 and 05 provide conforming hosts and fail-closed interception. Hosted object storage and PostgreSQL cannot form one transaction; the visibility transaction plus unreferenced object and compensation is the required atomicity boundary.

Add shared, Desktop, hosted, PostgreSQL, object-storage, process, Chromium, artifact, server projection, and cleanup tests. Prove byte integrity, canonical limits, isolation, descriptor shape, approval contents, atomic visibility, idempotency, denial, 30-minute expiry, unknown-outcome reconciliation, abnormal termination, safe cleanup, redaction, and compatibility with the current mobile artifact shape. Run focused suites, `pnpm validate`, `pnpm validate:process`, `pnpm validate:postgres`, and `pnpm validate:chromium`.

## Done when

- Both hosts intercept all downloads into bounded per-session quarantine with default browser downloads disabled.
- Quarantine cannot be accessed through a Workspace, Project, model, ordinary artifact route, another session, Thread, user, or tenant.
- The pending descriptor and approval identify the exact file without revealing paths, object keys, credentials, or URL details beyond origin.
- Approval publishes one byte-for-byte verified Thread file. Retry returns the same file ID; an unknown commit is reconciled before any retry.
- Denied, expired, oversized, partial, orphaned, and unpromoted bytes never become visible and are removed by ownership-proven cleanup.
- Promoted files render through existing authorized web and mobile projections without mobile quarantine or takeover access.
- Both hosts pass one shared download contract suite and required validation gates.

## Integration basis

- Build against the reviewed contracts from [Run safe Browser App sessions on Desktop](03-run-safe-browser-sessions-on-desktop.md) and [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md). Final completion still requires both hosts' interception and release evidence.

## Settled implementation contracts

- Replace deny-only interception with an explicit Chrome DevTools quarantine owned by the Browser Session. Keep default download directories disabled; use `Browser.setDownloadBehavior` with `allowAndName` only for the private per-session quarantine path and enable download events. `Browser.downloadWillBegin` creates the exact identity, `Browser.downloadProgress` enforces measured limits and completion, and `Browser.cancelDownload` plus owned-path deletion handles overflow or failure.
- The Browser service owns the in-memory and restart-reconciled quarantine index. It creates a pending descriptor only after the GUID-named owned file is complete, regular, measured, and SHA-256 verified. Startup and Session teardown enumerate only the owned quarantine root and remove entries whose Session ownership is proven.
- Reuse Issue 07's Browser prepared-effect adapter for `browser.download`. Preparation binds Session, generation, quarantine ID, filename, measured bytes, checksum, untrusted media type, normalized source origin, expiry, operation ID, and resulting Thread scope into approval-hashed adapter metadata. Execution revalidates the same item before opening bytes.
- Desktop promotion uses `DesktopAttachmentStore.importPath` from the owned quarantine file and records the exact operation-to-file result before deleting quarantine bytes. Hosted promotion mints a one-time worker-to-Web capability after approval; the worker streams the exact verified file through a dedicated worker-to-Environment-Router-to-Web route separate from the ordinary App relay.
- Hosted Web writes an owned unreferenced object, verifies length and checksum, then uses one PostgreSQL transaction to create the blob, ready file, live Thread grant, and exact operation result. Operation ID plus quarantine identity is the idempotency key. Unknown commit outcome reconciles that row before any retry; failed visibility leaves only the unreferenced owned object for bounded compensation.
- Existing `AgentToolArtifactPresentation` and web/mobile artifact projection present the committed Thread file. Do not add a quarantine locator, Browser-specific mobile endpoint, or mobile control surface.

## Implementation evidence

- Desktop now admits completed CDP downloads only from the private Browser Session quarantine, enforces the shared count and measured-byte limits, verifies the exact owned file and SHA-256 before preparation and execution, and publishes through the existing `DesktopAttachmentStore`. The exact operation result is recorded before quarantine cleanup, so a cleanup failure cannot mask a durable promotion or create a second file on retry. Admission, overflow, cancellation, expiry, and Session teardown remove only ownership-proven quarantine bytes.
- Hosted execution now uses an exact fixed-key preparation capability and a dedicated worker-to-Environment-Router-to-Web byte stream. Web stages a verified, unreferenced owned object before acknowledging Browser dispatch, then commits the ready file, blob, live Thread grant, and exact promotion result in one additive PostgreSQL transaction. Concurrent/replayed promotion returns the same file; an unknown commit is reconciled from the exact result row; a proven uncommitted object is compensated without deleting referenced data.
- Approval and pending-result surfaces expose only the sanitized filename, measured bytes, untrusted response media type, normalized source origin, checksum, and exact identities. Object keys, host paths, credentials, URL path/query data, and quarantine locators remain private. The committed file uses the existing artifact authority and web/mobile projection; no Browser-specific mobile capability was added.
- The focused shared, Desktop, hosted worker, Kestrel One, Web lifecycle, artifact-authority, and migration contract command passed 193 tests with one optional real-Chromium probe skipped. Environment Router relay/download tests passed 17/17; the mobile artifact projection regression passed 1/1; and the exact PostgreSQL plus local-object-store promotion regression passed 1/1, including concurrent idempotency, response-loss reconciliation, and uncommitted-object compensation.
- Root and Environment Router TypeScript checks passed. Root and Router builds, scoped Web lint, frozen-lockfile installation, migration history-lock verification, and `git diff --check` passed. The Issue 08 Web lifecycle, artifact, and migration suites compile and pass; the full Web TypeScript check remains blocked by existing runtime-profile protocol-fixture and hosted-personal-OAuth test typing failures outside this issue.
- The repository-wide `pnpm validate` reached the hermetic-lane manifest check and stopped on the pre-existing unassigned `tests/unit/hosted-browser-viewer.test.ts`. `pnpm validate:postgres` passed unified migration compatibility twice, then stopped on eight unrelated existing Email Receiving/OAuth tests. The exact Issue 08 PostgreSQL/object-storage regression passed independently. Broader process and Chromium gates were not rerun in this bounded implementation turn.
