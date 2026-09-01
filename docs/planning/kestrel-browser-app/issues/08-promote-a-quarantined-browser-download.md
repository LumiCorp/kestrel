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
- When navigate or interact starts a download, return the shared pending-download descriptor pinned by issue 01. Return no host path, object key, credential, or raw quarantine locator.
- Require `browser.download({sessionId, pendingDownloadId})`. Prepare one approval that names the quarantined file, measured size, untrusted media type, source origin, and resulting Thread file. Bind it to Session, generation, quarantine ID, checksum, exact operation ID, and Thread scope.
- On hosted Kestrel One, initialize one deterministic standard Thread draft only after the approved operation is accepted, upload through `uploadThreadFile({ singleUseDraft: true })`, and then insert or reconcile the exact `browser_download_promotions` result. The ready file and promotion result reconcile independently after response loss. Do not create a Browser-specific staging ledger or `artifact_documents`.
- On Desktop, commit a verified owned temporary file through `DesktopAttachmentStore.importPath`. Publish the local file ID and presentation only after the blob link and attachment index write succeed. No partial file may be visible.
- Present the committed file through `AgentToolArtifactPresentation` and the existing web/mobile artifact projection. The artifact inherits normal Thread authorization and retention. Mobile receives no quarantine access or browser takeover.
- Denial creates no Thread file record or grant. A known failed standard upload leaves the failed draft to generic cleanup and requires a new approved operation, which receives a new deterministic file ID. A retry after a completed upload or promotion-result commit returns the same file ID.
- If commit outcome is unknown, return `BROWSER_ACTION_OUTCOME_UNKNOWN`, do not create a second file, and reconcile the deterministic file and exact operation result before accepting another promotion for that quarantine ID.
- Destroy host quarantine bytes on denial, item expiry, Session close/loss, engine or worker failure, and startup reconciliation after abnormal termination. Standard Thread drafts and unreferenced blobs use the existing seven-day draft retention and 24-hour blob-deletion grace. Delete only storage whose ownership is proven, retain the blob owner until storage deletion succeeds, and preserve the primary failure if cleanup also fails.
- Keep file contents, host paths, object keys, credentials, URL paths/queries, form values, and authentication input out of approvals, logs, traces, audits, analytics, metrics, errors, and cleanup evidence.
- Project the file through the existing server-side `artifact` part in `apps/web/lib/mobile/message-parts.ts`. Do not add a Browser-specific mobile endpoint, viewer, takeover action, or native-client feature.

## Requirements and delivery context

Issues 03 and 05 provide conforming hosts and fail-closed interception. Hosted object storage and PostgreSQL use the standard Thread file draft lifecycle; Browser promotion adds only the exact operation-result row after the ordinary file is ready.

Add shared, Desktop, hosted, PostgreSQL, object-storage, process, Chromium, artifact, server projection, and cleanup tests. Prove byte integrity, canonical limits, isolation, descriptor shape, approval contents, monotonic ready state, idempotency, denial, 30-minute quarantine expiry, unknown-outcome reconciliation, generic cleanup ownership, redaction, and compatibility with the current mobile artifact shape. Run focused suites, `pnpm validate`, `pnpm validate:process`, `pnpm validate:postgres`, and `pnpm validate:chromium` as their boundaries require.

## Done when

- Both hosts intercept all downloads into bounded per-session quarantine with default browser downloads disabled.
- Quarantine cannot be accessed through a Workspace, Project, model, ordinary artifact route, another Session, Thread, user, or tenant.
- The pending descriptor and approval identify the exact file without revealing paths, object keys, credentials, or URL details beyond origin.
- Approval publishes one byte-for-byte verified Thread file. Retry returns the same file ID; an unknown commit is reconciled before any retry.
- Denied, expired, oversized, partial, orphaned, and unpromoted host bytes never become visible and are removed by ownership-proven cleanup.
- Promoted files render through existing authorized web and mobile projections without mobile quarantine or takeover access.
- Both hosts pass one shared download contract suite and required validation gates.

## Integration basis

- Build against the reviewed contracts from [Run safe Browser App sessions on Desktop](03-run-safe-browser-sessions-on-desktop.md) and [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md). Final completion still requires both hosts' interception and release evidence.

## Settled implementation contracts

- Replace deny-only interception with an explicit Chrome DevTools quarantine owned by the Browser Session. Keep default download directories disabled; use `Browser.setDownloadBehavior` with `allowAndName` only for the private per-session quarantine path and enable download events. `Browser.downloadWillBegin` creates the exact identity, `Browser.downloadProgress` enforces measured limits and completion, and `Browser.cancelDownload` plus owned-path deletion handles overflow or failure.
- The Browser service owns the in-memory and restart-reconciled quarantine index. It creates a pending descriptor only after the GUID-named owned file is complete, regular, measured, and SHA-256 verified. Startup and Session teardown enumerate only the owned quarantine root and remove entries whose Session ownership is proven.
- Reuse Issue 07's Browser prepared-effect adapter for `browser.download`. Preparation binds Session, generation, quarantine ID, filename, measured bytes, checksum, untrusted media type, normalized source origin, expiry, operation ID, and resulting Thread scope into approval-hashed adapter metadata. Execution revalidates the same item before opening bytes.
- Desktop promotion uses `DesktopAttachmentStore.importPath` from the owned quarantine file and records the exact operation-to-file result before deleting quarantine bytes. Hosted promotion mints a one-time worker-to-Web capability after approval; the worker streams the exact verified file through a dedicated worker-to-Environment-Router-to-Web route separate from the ordinary App relay.
- Hosted Web derives the Thread file ID from the exact operation and approved quarantine identity, calls `initializeThreadFile`, reconciles an existing deterministic `ready`, `draft`, or `failed` state, and uploads a draft once with `singleUseDraft: true`. A ready file remains authoritative even if representation processing fails.
- The exact `browser_download_promotions` row is inserted or reconciled independently after file readiness. It keeps a successful file live under generic cleanup. One worker-owned claim per `pendingDownloadId` prevents operations from concurrently opening the same quarantine bytes; a proven pre-effect failure releases only the operation claim and requires a new approval, while denial removes the exact host quarantine item.
- Unreferenced blob cleanup marks the existing blob owner first, waits the ordinary 24-hour grace, deletes storage, and removes the database owner only after storage deletion succeeds. Failed standard drafts use the ordinary seven-day draft retention; no Browser reconciliation scheduler or custom cleanup protocol is added.
- Existing `AgentToolArtifactPresentation` and web/mobile artifact projection present the committed Thread file. Do not add a quarantine locator, Browser-specific mobile endpoint, or mobile control surface.

## Implementation evidence

- The custom `browser_download_staged_objects` schema, migration 0100, reserve/stage/cancel service, reconciliation scheduler, advisory lock, and storage-abort machinery were removed. Migration 0099 remains the single additive Browser promotion-result authority.
- Hosted Web now prepares a deterministic Thread draft after accepted execution, uses the ordinary single-use upload path, and reconciles file readiness and the promotion row independently. Missing or unbound response MIME is stored as `application/octet-stream`; no GUID-to-network-response heuristic was added.
- The worker consumes one claim per pending download before opening bytes, retains it across response loss or an unknown operation, releases it after exact commit, and releases only the operation claim after a proven pre-effect transfer failure so a newly approved operation can retry.
- Ready file state is committed before representation processing and is not rolled back by representation failure. Generic file cleanup excludes files referenced by `browser_download_promotions`. Deduplicated unreferenced blobs retain their database owner until the ordinary storage-deletion cleanup succeeds.
- Hosted upload freshness is checked after the object write and again by the PostgreSQL ready-state CAS, so a transfer crossing the approved quarantine expiry cannot publish a ready file or promotion. Once readiness may have committed, response loss or a later read failure returns an unknown outcome and never deletes the blob or regresses the file to `failed`.
- Expired-file cleanup now locks and rechecks each exact file row in the deletion transaction. A concurrent `browser_download_promotions` insertion either becomes visible before the final predicate or conflicts with the locked deletion; it cannot be cascade-deleted after stale candidate selection.
- Environment Router cancellation now runs only for an explicit known pre-effect Web failure. A lost Web response or explicit `BROWSER_ACTION_OUTCOME_UNKNOWN` preserves the worker claim and receipt for exact reconciliation; proven known pre-effect failure still cancels the exact operation claim so a newly approved operation can retry.
- Focused Web lifecycle, artifact-authority, migration-contract, and Environment scheduler suites pass 32/32. Focused hosted worker download claim, replay, denial, and retry cases pass 5/5. Root TypeScript passes. Web TypeScript reaches only the existing runtime-profile protocol-fixture and hosted-personal-OAuth test typing failures outside Issue 08.
- The final repair-focused suites pass 34/34: Web Browser lifecycle/contract/authority 29/29, Environment Router known-versus-unknown cancellation 2/2, and worker claim consumption/release 3/3. Root TypeScript, Router typecheck/build, scoped Web Ultracite, and `git diff --check` pass.
- The PostgreSQL/local-storage regression covers deterministic ready-file response-loss reconciliation, exact replay, `application/octet-stream` defaulting, and promotion-backed cleanup retention. It is present but was not run locally because `KESTREL_ENVIRONMENT_DB_TEST_URL` is unavailable in this worktree environment.
