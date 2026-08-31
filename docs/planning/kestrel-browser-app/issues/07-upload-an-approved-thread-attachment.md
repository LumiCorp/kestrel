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

## Integration basis

- Build against the reviewed contracts from [Run safe Browser App sessions on Desktop](03-run-safe-browser-sessions-on-desktop.md) and [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md). Final completion still requires both hosts' transfer and release evidence.

## Settled implementation contracts

- Add one Browser-specific prepared-effect adapter for `browser.upload`. Trusted tool-registry preparation calls an optional Browser host preparation method and stores only resolved turn, Thread, file, filename, declared media type, measured size, SHA-256, Session generation, snapshot, document revision, target ref, and target label in adapter metadata. Prepared approval authority already hashes input-adapter metadata, so approval and execution bind the same effect without changing the model-visible input schema.
- Project the active durable turn ID and its already-resolved attachment metadata from trusted runtime context into preparation. The model cannot supply or replace this context. Desktop preparation requires an exact match in that active set and independently re-resolves the file through `DesktopAttachmentStore.resolve`; hosted preparation re-runs `resolveTurnAttachments` for the exact active turn. Both hosts repeat those checks after approval and before opening bytes.
- Extend the Browser engine adapter with a read-only file-input description and an exact upload operation. Preparation validates snapshot/document revision, proves `targetRef` resolves to `input[type=file]`, and derives its display label. Execution repeats that target check, materializes the approved stream only inside the owned per-session runtime, invokes pinned agent-browser as `upload <targetRef> <ownedPath>`, and removes only that owned staging file.
- Desktop supplies the existing `DesktopBrowserUploadStreamHook` from `DesktopAttachmentStore`. Hosted Web mints a one-time, body-bound upload capability only after approval and streams storage bytes through a dedicated Web-to-Environment-Router-to-worker route. This byte route is separate from the ordinary 20 MiB App relay and exposes no object URL or storage credential to the Browser, model, or client.
- The prepared-effect adapter drives the existing approval presentation and web/mobile interaction projection. Do not add another approval system or a mobile Browser surface.

## Implementation evidence

- Trusted runtime preparation now projects only the exact active durable turn ID
  and metadata for its resolved attachments. `browser.upload` adds one strict
  prepared-effect adapter whose turn, Thread, attachment, immutable hash,
  measured size, Session generation, snapshot/document revision, file-input
  reference, and derived target label are hashed by the existing approval
  authority. Model input cannot replace that attachment context.
- Desktop independently re-resolves the approved file through
  `DesktopAttachmentStore`, revalidates the exact file input before access and
  again before dispatch, measures and hashes the stream into one unique owned
  Session staging file, invokes pinned agent-browser as
  `upload <targetRef> <ownedPath>`, and removes only that owned file while
  preserving the primary failure.
- Hosted Web re-runs the existing active-turn attachment resolver before
  preparation and execution, signs a one-time fixed-key capability for the
  exact prepared effect, and streams storage bytes through a dedicated
  authenticated Web-to-Environment-Router-to-worker route. The Router and
  worker enforce the shared 100 MiB conversation attachment limit, exact body
  length, hash, operation, actor, tenant, turn, Session, generation, snapshot,
  and target bindings. Transfer authority is consumed when byte transfer
  begins; no object URL, storage credential, host path, or file bytes enter the
  ordinary App relay or approval/result surfaces.
- Existing web and mobile interaction envelopes carry the same approval. Its
  presenter shows only the filename, measured size and canonical maximum,
  untrusted declared media type, and Browser target label; it cannot be
  remembered and contains no path, URL, credential, hash, or file bytes.
- The exact combined shared/Desktop/hosted/Web/Router/approval command passes
  174 tests: 173 passed, one optional real-Chromium CDP probe skipped, zero
  failed. Root and Environment Router typechecks/builds, root build, frozen
  lockfile verification, scoped changed-file lint, and `git diff --check` pass.
- Repository-wide gate status is recorded without treating unrelated failures
  as upload evidence: `pnpm validate` passes preflight and builds before the
  existing unassigned `tests/unit/hosted-browser-viewer.test.ts` manifest
  blocker; `pnpm validate:process` passes its first TUI journey but was
  interrupted after a silent PTY wait; `pnpm validate:postgres` passes the
  Browser lifecycle contract and then fails in existing Email Receiving/OAuth
  suites; `pnpm validate:chromium` passes the production build and 28 of 32
  product tests, with four unrelated appearance, brand, Thread-shell, and
  workflow-canvas failures.

### Independent-review repair evidence

- Desktop now opens, measures, hashes, syncs, and revalidates the exact active-turn
  attachment before acknowledging Browser dispatch. Cancellation is projected
  through staging and the pinned CLI process, and owned staging is removed on
  cancellation or failure.
- Hosted upload acceptance now separates byte staging from Browser dispatch.
  Web transfers and destroys the source stream, the Router returns an exact
  operation-bound staging continuation, and Kestrel One acknowledges only after
  that transfer succeeds. A failed transfer is known pre-effect only after the
  worker proves cancellation of the exact operation; otherwise it remains an
  unknown outcome.
- The worker indexes staging by exact operation identity, removes the exact file
  on cancellation, supports a same-attachment retry under a new operation ID,
  and reconciles only its own filename-shaped staging residue on reconstruction.
  Worker cancellation aborts both a waiting transfer and accepted execution.
- Prepared authority now binds the owning record's distinct untrusted declared
  media type and detected media type. Stable success metadata is limited to the
  attachment ID, sanitized filename, measured byte count, SHA-256, Session
  generation, and target reference. Typed Browser errors remain typed through
  the hosted transfer client, and error bodies remain bounded.
- Label parsing accepts only the pinned CLI's structured attribute value. A null
  or malformed accessible label becomes the generic `File input`; wrapper JSON,
  origins, URLs, and target references are never used as labels.
- The focused combined shared/Desktop/hosted/Web/Router/approval suite passes
  199 tests (198 passed and one optional real-Chromium CDP probe skipped). The
  hosted source-stream suite passes 2 of 2. Root typecheck/build, Environment
  Router typecheck/build, frozen-lockfile verification, scoped Web lint, and
  `git diff --check` pass.

### Remaining exact-target blocker

The pinned agent-browser v0.35.0 public CLI does not expose a read-only mapping
from `targetRef` to element tag/local name. `snapshot --json` publishes the
reference's role and accessible name while retaining its backend node identity
inside the daemon; `get attr` resolves the reference internally but can only
return an attribute; and `get html` returns inner HTML. Kestrel's owned CDP seam
has the active target but not agent-browser's private reference map. Therefore
the current exact `type="file"` attribute check cannot also prove the referenced
node is actually an `input`. Completion remains blocked until the pinned wrapper
adds an exact read-only tag/local-name or reference-description command (or an
equivalent exact ref-to-node identity seam). A selector/role heuristic and a
mutating upload preflight are explicitly not accepted substitutes.
