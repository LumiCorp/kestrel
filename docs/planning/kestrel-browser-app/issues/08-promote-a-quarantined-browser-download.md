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

## Depends on

- [Run safe Browser App sessions on Desktop](03-run-safe-browser-sessions-on-desktop.md)
- [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md)
