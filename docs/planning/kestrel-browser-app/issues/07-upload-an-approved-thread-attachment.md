# Upload an approved Thread attachment

## Useful outcome

On Desktop and Kestrel One, an agent can call `browser.upload` for one file explicitly attached to the active turn. After one approval, Kestrel transfers only that file into one current snapshot-scoped file input. The browser receives no host path, directory, mount, or storage credential.

This slice delivers approved upload from the [Kestrel Browser App Product Brief](../../kestrel-browser-app-product-brief.md).

## What changes

- Keep the shared input exact: `sessionId`, `snapshotId`, `targetRef`, and `attachmentId`. The target must be a file-input reference from that snapshot and document revision.
- Allow only a file linked to the active turn's input message. A general historical Thread file is not eligible merely because the user can access the Thread.
- On hosted Kestrel One, authorize through `apps/web/lib/files/turn-attachment-resolver.ts`, its internal resolver route, and `apps/web/lib/turns/attachment-resolver-client.ts`. On Desktop, authorize through `DesktopAttachmentStore.resolve` in `src/localCore/desktopAttachments.ts` and the active turn's resolved attachment.
- Bind preparation and approval to turn ID, Thread ID, file ID, immutable SHA-256, measured size, session generation, snapshot ID, and file-input reference. Use the revalidation pattern in `apps/web/lib/integrations/gmail-mutation-preparation.ts` and its Desktop equivalent.
- Re-resolve the attachment and target after approval and immediately before file access. If identity, hash, size, session generation, snapshot, or target no longer matches, fail before reading bytes. A stale target returns `BROWSER_TARGET_STALE` and transfers zero bytes.
- Require one approval that displays the attachment filename, 100 MiB maximum, measured size, declared media type as untrusted metadata, and browser target label. Do not display a host path.
- Accept exactly one file no larger than `CONVERSATION_ATTACHMENT_MAX_FILE_BYTES` from `packages/conversation/src/attachments.ts` (currently 100 MiB). Measure streamed bytes and verify size and SHA-256; fail closed on metadata mismatch.
- Mint host-to-browser file authority only after approval. Bind it to the exact prepared effect and consume it when byte transfer begins. It cannot be reused for another file, target, session, Thread, turn, user, or tenant.
- Stream bytes through the hooks delivered by issues 03 and 05. Keep any materialized path inside the trusted host. Large hosted bytes must not pass through the ordinary App relay.
- A pre-dispatch failure transfers zero bytes. A completed duplicate returns the recorded result. A timeout after acknowledged transfer begins returns `BROWSER_ACTION_OUTCOME_UNKNOWN` and must not mint replacement authority automatically.
- Remove only Kestrel-owned partial staging after cancellation, size mismatch, expiry, session loss, or failure. Preserve the primary failure if cleanup also fails.
- Return safe success metadata only: attachment/file ID, sanitized filename, byte count, checksum, session generation, and target reference. Exclude file contents, paths, credentials, and form data from all durable and diagnostic surfaces.
- Project the approval through existing web and mobile interaction contracts. Do not add mobile browser control.

## Requirements and delivery context

Issues 03 and 05 provide conforming hosts and bounded stream hooks. `src/runtime/attachments/materialize.ts` materializes already-authorized attachments; it is not an authorization owner and must not receive a new browser authority role.

Add shared, Desktop, hosted, process, PostgreSQL, Chromium, approval, and cleanup tests. Prove active-turn eligibility, exact target revalidation, 100 MiB enforcement, byte/hash integrity, one-time use, cross-scope rejection, duplicate delivery, pre/post-dispatch failure, cancellation, session loss, cleanup ownership, redaction, and web/mobile approval projection. Run focused suites, `pnpm validate`, `pnpm validate:process`, `pnpm validate:postgres`, and `pnpm validate:chromium`.

## Done when

- Both hosts upload the exact approved active-turn attachment into the exact current file-input reference.
- No other attachment, path, directory, mount, or credential becomes available.
- Approval names the file, measured size, and target before any authority or bytes are issued.
- Denial, stale target, changed hash/size, cross-scope replay, limit failure, cancellation, and session loss transfer no unauthorized bytes.
- Duplicate and unknown outcomes follow the shared exact-effect contract without a second upload.
- Failed staging cleanup cannot delete outside the owned transfer scope.
- Both hosts pass one shared upload contract suite and required validation gates.

## Depends on

- [Run safe Browser App sessions on Desktop](03-run-safe-browser-sessions-on-desktop.md)
- [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md)
