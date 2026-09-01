# Let the triggered agent read an email attachment

## Useful outcome

The triggered agent can call `kestrel_one.email_get_attachment` with an opaque attachment ID and receive the existing bounded Kestrel file representation in the same call. Kestrel imports only the file the agent needs, and later calls reuse it.

## What changes

- Add the read-only `kestrel_one.email_get_attachment({ attachmentId })` shared tool and its strict input contract.
- Expose the tool only when the current Thread is linked to a materialized Delivery Receipt. Do not add it to the general Email App resources or expose mailbox listing, message retrieval, arbitrary provider access, or outbound email.
- Carry the tool through both hosted and Desktop execution profile paths and the existing Environment App relay. The relay must allow only the exact execution-scoped attachment operation.
- Before contacting Resend, bind the execution ticket, Organization, Project, Thread, receipt, Execution Owner, and Delivery Attachment. Recheck current owner Project access and Receiving Connection availability.
- Reject an ID from another Organization, Project, Thread, receipt, or email before making a provider request.
- Lock the Delivery Attachment on first use. Request a fresh temporary provider URL and stream its bytes through `initializeThreadFile` and `uploadThreadFile` as the Execution Owner.
- Preserve the existing 100 MiB per-file limit, declared byte-count verification, hashing, media detection, blob deduplication, quarantine, representation processing, Thread grant, immutable source, and file-availability rules.
- Store the resulting Kestrel file ID on the Delivery Attachment. Concurrent first calls must converge on one ready file.
- Return the same bounded representation as `kestrel.files.open`: filename, detected media type, verified size and hash, representation kind, extracted text when available, and an authorized immutable source when required.
- Repeated calls must open the ready Kestrel file without contacting Resend. Later turns in the same Thread can use ordinary `kestrel.files.open`.
- Return a transient retrieval failure to `available` so a later call can request a fresh URL. Keep explicit provider, size, integrity, quarantine, and representation failures concrete and inspectable. Do not add a heuristic retry cap.
- Make this receipt-scoped read automatic. It needs no separate human approval because it reads input already admitted to the Thread. Existing policy still governs every later business-system action.
- Never persist or expose the Resend email ID, provider attachment ID, credential, download URL, or signed query string in the model context, tool result, logs, analytics, durable events, or errors.
- Use the existing file-open result for images and other non-text representations. Do not add Email-specific OCR or a native image tool-result contract.

## Requirements and delivery context

Register the tool through the shared tool catalog and runtime input contracts. Conditional tool discovery must be derived from durable Thread-receipt state in both Kestrel One runtime profile paths, not from model-selected input.

Use the execution-scoped transport and Environment router rather than giving hosted or Desktop runtimes a Resend credential. The control-plane route must verify the existing Environment execution ticket and current durable scope before provider access.

The import owner is the existing Thread-file service in `apps/web/lib/files/service.ts`. Reuse `initializeThreadFile`, `uploadThreadFile`, and the `kestrel.files.open` representation path. Do not introduce a second file store, provider URL attachment, Project-wide grant, or pre-run staging Thread.

The canonical requirements are in the [Email-Triggered Agent Runs Product Brief](../../email-triggered-agent-runs-product-brief.md).

## Done when

- A Triggered Thread lists the tool and an ordinary Thread does not.
- The agent imports a text-extractable PDF invoice by opaque ID and receives readable, verified content in that same tool call through hosted and Desktop paths.
- Concurrent first calls create one Thread-scoped Kestrel file, and repeated calls make no second Resend request.
- A later turn in the same Thread can reopen the imported file through `kestrel.files.open`.
- Cross-Organization, Project, Thread, receipt, owner, and attachment requests fail before provider access.
- Expired provider access is refreshed at call time. Transient failure remains retryable through existing ownership, while size, integrity, quarantine, provider, and representation failures remain distinct.
- The existing file limit, byte verification, media detection, deduplication, representation, and immutable-source tests remain authoritative.
- Tool discovery, catalog, input, relay, execution-ticket, import, concurrency, reuse, failure, authorization, and redaction tests pass.
- `pnpm validate`, `pnpm validate:postgres`, and `pnpm validate:process` pass.

## Depends on

- [Materialize an admitted email as a durable Project run](05-materialize-email-triggered-project-run.md)
