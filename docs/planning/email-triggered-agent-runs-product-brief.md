# Email-Triggered Agent Runs Product Brief

## Product Narrative

Kestrel One Projects already know how an agent should work: they carry Project
context, choose an Environment and model, connect business Apps, and define the
approval, spending, evidence, recovery, and concurrency rules for execution.
What they lack is a simple way for ordinary business email to start that work.

The first release adds a private, Project-scoped Email Trigger. An Organization
Admin connects a Resend receiving domain once from Kestrel One or signed-in
Kestrel Desktop. Both surfaces manage the same hosted Organization resource; no
receiving dependency or credential lives on Desktop. A Project editor creates
a Trigger, describes what the agent should do, and receives an unguessable,
rotatable email address. When that address receives an email, Kestrel One
creates one private Thread and one durable, noninteractive agent turn using the
Project's current context and ordinary execution rules.

The email becomes untrusted user input, not authority. Its sender, recipients,
subject, body, and attachment descriptors are presented to the agent in a
deterministic envelope. When the agent needs an attachment, it calls a narrow
read-only `kestrel_one.email_get_attachment` tool with the opaque attachment ID
from that envelope. Kestrel retrieves, verifies, imports, and opens only that
attachment through the existing Thread-file system. The agent never receives a
Resend identifier or temporary provider URL.

This produces a small but useful business-workflow primitive. The triggered
agent can inspect an emailed invoice, support request, order, or form and then
use the Project's already-connected Apps to do useful work under the same
controls as any other Kestrel run. The MVP does not add workflow recipes or an
email-specific autonomy system.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- An Organization Admin can configure and verify the same inbound Resend
  receiving connection from Kestrel One or Kestrel Desktop, separately from
  the existing outbound email configuration.
- A change saved from either management surface is reflected by the other, and
  receiving continues when Desktop is closed or offline.
- A Project editor can create, inspect, rotate, disable, and delete a private
  Email Trigger with a name, instruction, model, and optional claimed-From
  filter.
- Each accepted email creates exactly one private Project Thread and one
  durable noninteractive Build turn.
- The turn runs as the Trigger creator and uses the Project's current context,
  Environment, model availability, Apps, approval policy, spending controls,
  recovery, evidence, and concurrency behavior.
- A disconnected Desktop-backed Environment causes the ordinary durable wait;
  it does not lose the email or require Desktop to expose a webhook.
- Resend retry or manual replay does not create another Thread or turn for the
  same received email.
- The agent receives normalized email fields, a usable text body, and ordered
  opaque attachment descriptors without seeing provider credentials,
  identifiers, or download URLs.
- The agent can lazily import and read one attachment with
  `kestrel_one.email_get_attachment`, and a repeated call reuses the same
  Thread-scoped Kestrel file.
- Users and operators can inspect trigger, receipt, hydration, rejection,
  materialization, Thread, turn, and attachment-import outcomes without
  treating email metadata as Kestrel authority.

The delivery boundary begins at the Kestrel One and Kestrel Desktop management
surfaces for Organization-level Resend inbound setup and the public Kestrel One
webhook. It includes the shared hosted configuration API, typed Desktop bridge,
signed ingress, durable receipt and attachment state, email-content hydration,
exact Trigger resolution, admission, turn materialization, hosted/Desktop
execution routing, Thread presentation, lazy attachment import, failure
handling, redaction, observability, and end-to-end verification.

The MVP is deliberately private. Possession of the generated address is the
admission capability. The persisted access mode is explicitly `private`, and
neither the API nor UI exposes a public setting in this release.

This initiative does not:

- Add public or unauthenticated Trigger semantics beyond the private-address
  capability.
- Treat an exact claimed-From match as sender authentication.
- Add customer-service, invoice-processing, or other workflow recipes.
- Send email, reply to the sender, or continue an existing Thread from an email
  reply.
- Create a generic webhook or workflow builder.
- Add a service principal or let the email sender become a Kestrel actor.
- Add an email-specific App permission, approval, spending, or concurrency
  policy.
- Give Desktop a public webhook, inbound mail listener, or tunneling
  responsibility.
- Store Resend credentials, webhook secrets, route locators, or a second copy
  of Receiving Connection state in Desktop settings or renderer persistence.
- Download every attachment before the turn starts.
- Guarantee extracted text for a format that the existing Kestrel file-open
  representation cannot read. Native image reasoning and a new image-capable
  tool-result contract are outside this MVP.
- Change the existing 100 MiB per-file limit, file quarantine rules,
  representation rules, or immutable-source behavior.

## Defining Scenarios

### An Admin configures receiving from Kestrel One or Desktop

An Organization Admin opens **Organization → Email → Inbound receiving** in
Kestrel One or **Settings → Connections → Inbound receiving** in Kestrel
Desktop. Desktop shows a visible Organization selector from the signed-in
account, auto-selects it when there is only one Organization, and requires a
choice when there are several. Both show the same hosted connection state and
clearly separate outbound sending from inbound receiving. The Admin supplies a
write-only Resend Full access key, selects a verified receiving subdomain,
saves, and sees credential sufficiency, domain/MX health, webhook staging or
activation state, and current health evidence.

The saved key is never shown again. A change from either surface appears in the
other after refresh. Desktop sends the mutation through its authenticated,
typed Kestrel One bridge, clears the key field, and persists neither the secret
nor a configuration copy. A signed-out Desktop asks the user to sign in; a
non-Admin sees status without edit authority. Closing Desktop does not affect
an already-enabled hosted receiving connection.

### A Project editor creates a private Email Trigger

An Organization Admin has configured a healthy Resend receiving connection
with a verified subdomain, Full access API credential, and active
`email.received` webhook. A Project editor opens the Work-level Triggers
surface, chooses a Project, names the Trigger, accepts or edits the default
instruction, and uses an available model from the Project Environment.

Kestrel shows the editor as **Runs as** and generates a lowercase address with
at least 128 bits of randomness on the configured receiving subdomain. Only
authorized Project members can view or copy the address. Ordinary logs and
analytics redact it. The Trigger can enable immediately while inbound health
is current; sending a test email is available but not mandatory.

### A valid email starts useful Project work

Resend delivers a signed `email.received` webhook for exactly one enabled
Trigger address. Kestrel verifies the untouched request body, records a durable
receipt, returns promptly, and hydrates the full email asynchronously.

The worker parses the recipients and claimed sender, loads the body and
attachment metadata, rechecks the Trigger and Execution Owner, and creates one
new private primary-workspace Thread. The first turn contains the current
Project context as trusted system context and the normalized email as untrusted
user input. The normal durable queue routes the run to its hosted or
Desktop-backed Environment.

The agent may then use the Project's connected calendar, CRM, accounting,
support, or other business Apps. Those actions follow their existing App
access, approval, spending, and evidence rules; receipt of the email does not
pre-authorize them.

### The agent reads an emailed PDF invoice

The input envelope lists a PDF invoice with an opaque Delivery Attachment ID.
The agent calls `kestrel_one.email_get_attachment` with that ID. Kestrel binds
the call to the current execution, Organization, Project, Thread, Delivery
Receipt, Execution Owner, and attachment before contacting Resend.

Kestrel requests a fresh temporary URL, streams the bytes through the existing
Thread-file service, verifies the declared byte count, computes the hash,
detects the actual media type, applies existing quarantine and representation
processing, and persists the ready Kestrel file ID. The tool returns the same
bounded representation as `kestrel.files.open`, including extracted text when
available. The agent can read the invoice in the same call and can reopen the
imported file in later turns.

Calling the receipt-scoped read tool does not require a separate human
approval: it only reads input already delivered to this Triggered Thread and
cannot browse the Resend mailbox. Any subsequent external business-system
action remains governed by its existing policy.

### The agent requests the same attachment again

The tool finds the ready Kestrel file already bound to the Delivery Attachment
and opens it. It does not call Resend or create another file. Concurrent calls
converge on the same ready Thread-scoped file.

### Resend retries or manually replays delivery

Kestrel finds the existing receipt by Organization connection and Svix ID, or
the existing Triggered Turn by Organization connection and Resend email ID. It
returns the existing durable outcome and does not create another receipt,
Thread, message, or turn.

### The email is ambiguous or fails its filter

An email addresses zero or more than one configured Trigger address. Kestrel
records a rejected receipt and creates no turn. The first release does not
fan out one email to multiple Triggers.

If a Trigger has an exact claimed-From filter and the parsed mailbox does not
match, Kestrel also rejects the receipt. The product labels this as filtering,
not identity verification, and the sender never gains actor authority.

### Trigger or owner authority changes before materialization

The worker discovers that the Trigger is disabled, rotated, changed from its
reserved revision, or no longer has a currently available model. It rejects or
fails the receipt with a stable reason and starts no model work.

If the Execution Owner no longer belongs to the Organization or Project,
Kestrel rejects new materialization and disables the Trigger with **Execution
owner lost access**. Existing materialized Threads and evidence remain intact.

### Desktop is disconnected

Kestrel One still verifies, hydrates, admits, and materializes the email. The
ordinary Environment route places the turn in its existing durable wait until
the selected Desktop reconnects. No inbound responsibility moves to Desktop.

### Attachment retrieval fails

A transient Resend, network, or temporary storage failure returns the Delivery
Attachment to `available`, allowing a later call to request a fresh URL under
the existing durable execution behavior. It does not consume the attachment or
persist a temporary URL.

An explicit nonretryable provider result, failed file verification,
quarantine, unsupported representation, or size-limit failure produces a
concrete tool error and durable attachment evidence. The original turn remains
inspectable. No new keyword rule, retry threshold, or email-specific retry cap
is introduced.

### Inbound receiving or a Trigger is disabled

Disabling inbound receiving or the Trigger stops new admission. It does not
cancel a materialized turn or delete an existing Thread. A materialized Thread
may reopen an already imported attachment. It may retrieve an unimported
Delivery Attachment only while the Execution Owner retains Project access and
the Organization's receiving connection remains available.

## Business and Process Requirements

- Organization Admins must own inbound Resend setup, credential sufficiency,
  receiving-domain selection, webhook lifecycle, and health evidence.
- Kestrel One and Kestrel Desktop must expose equivalent management of the
  same Organization Receiving Connection and use the same server-enforced
  Admin authority, validation, status vocabulary, and redacted projection.
- Desktop must show an Organization selector sourced from the signed-in Kestrel
  One account, auto-select a sole Organization, require a choice when there are
  several, and bind every read and mutation to the selected Organization ID.
- Inbound readiness must remain separate from outbound send readiness. Either
  capability may be healthy while the other is unavailable.
- The UI must state that inbound setup requires a Resend Full access API key.
- The UI must make clear that Kestrel One hosts receiving and that Desktop does
  not need to remain open after setup.
- Project editors must own Trigger creation, instruction, model, optional
  claimed-From filter, rotation, disablement, and deletion.
- The Trigger creator must be visible as **Runs as** and must be the Execution
  Owner for the MVP.
- A Trigger address must be unguessable, rotatable, limited in disclosure to
  authorized Project members, and redacted from ordinary logs and analytics.
- Rotation must invalidate the old address atomically for new admission.
- An accepted email must resolve exactly one enabled private Trigger.
- Each accepted email must create one new private Thread and one durable turn;
  replies and repeated messages do not implicitly share a Thread.
- The email sender must remain provenance and untrusted input, never a Kestrel
  member, actor, approver, or source of Project authority.
- Claimed-From matching must be exact after mailbox parsing and must always be
  described as filtering rather than authentication.
- Project context must remain the trusted instruction source. Email headers,
  body, and attachment metadata must be clearly and consistently marked as
  untrusted external input.
- Triggers must not grant new App access or bypass approval, spending,
  concurrency, evidence, or interaction requirements.
- A noninteractive turn that reaches an unmet approval or interaction boundary
  must use the existing inspectable blocked behavior.
- Operators and Project members must be able to distinguish rejected ingress,
  failed hydration, failed admission, materialized execution, and attachment
  import outcomes.
- Raw signed webhook bodies must not be retained after verification. A
  materialized email body must follow the existing Thread-message lifecycle.
- A rejected or failed receipt that never materializes a Thread must
  immediately discard any hydrated body and content-derived attachment
  metadata.
- The remaining minimal diagnostic receipt metadata and stable terminal reason
  must be retained for 30 days and then purged. Retained diagnostic fields may
  include the owning connection, provider delivery identities used for
  correlation and deduplication, processing timestamps, resolved Trigger when
  known, terminal state, and stable reason code. They must exclude sender,
  recipients, reply-to, subject, body, filenames, content IDs, and attachment
  media metadata.
- Replay deduplication for a rejected or failed receipt is guaranteed while its
  30-day terminal record is retained. No Triggered Turn exists to duplicate
  after that record is purged.
- A materialized receipt relation and its Delivery Attachment records must
  follow the linked Thread lifecycle because they remain provenance and
  authorization state for attachment access.
- Existing Project-primary serialization is the MVP concurrency behavior. A
  separate inbox concurrency policy requires measured demand and a later
  design.

## Technology Requirements

### Organization receiving and Trigger contracts

- The Organization Email configuration must add an inbound receiving state
  without changing the existing outbound Email App contract.
- Kestrel One must expose one Organization-Admin receiving API used by both its
  web UI and authenticated Desktop management client. Its read projection must
  omit all provider and webhook secrets.
- Desktop must access that API through explicit typed
  renderer/preload/main/local-core contracts. The renderer must clear a
  submitted key and Desktop must not add receiving secrets or state to
  `DesktopSettings`, local preferences, logs, analytics, or support bundles.
- Server-side authorization must remain authoritative for Desktop reads and
  writes; hiding or disabling a Desktop control is not an authorization check.
- The Receiving Connection must store Organization ownership, receiving-domain
  identity and status, webhook ID, encrypted signing secret, an opaque route
  locator, credential-sufficiency evidence, and current health/test evidence.
- One active Resend receiving connection must own one `email.received` webhook
  for the Organization.
- The Email Trigger must store Project ownership, name, generated private
  address material, instruction, model, creator/Execution Owner, optional
  claimed-From filter, explicit access mode, enabled state, revision, and
  lifecycle evidence.
- Trigger address material, instruction, model, filter, or owner changes must
  increment the Trigger revision.
- The MVP API and UI must accept only `private` access mode. A future public
  design must add new admission and authority rules without reinterpreting
  existing private records.

### Signed ingress and durable dispatch

- Kestrel One must own the public Resend route; Desktop must not receive or
  proxy webhooks.
- The webhook route must identify the Receiving Connection from an opaque,
  unguessable path locator before interpreting unverified payload data.
- The handler must read the untouched request body and verify the
  `svix-id`, `svix-timestamp`, and `svix-signature` headers with the stored
  signing secret before JSON parsing or tenant data selection.
- The verified payload must be boundary-validated as the documented
  `email.received` event shape.
- Invalid signatures, stale signatures, malformed events, and unsupported
  event types must create no tenant-selected receipt.
- The route must insert durable queued state and return promptly; correctness
  must not depend on a single queue-send call succeeding.
- Queued and interrupted receipt work must be recoverable by existing-style
  maintenance reconciliation.
- `(receiving connection, Svix ID)` must identify at most one Delivery Receipt.
- `(receiving connection, Resend email ID)` must identify at most one Triggered
  Turn.
- Duplicate delivery and concurrent materialization must return or converge on
  the existing durable state.

### Hydration and admission

- A receipt worker must retrieve the full received email asynchronously with
  the owning Organization's encrypted Resend credential.
- The worker must parse recipient and sender fields with an email-address
  parser rather than string or substring matching.
- Exactly one enabled Trigger address must match the parsed recipients.
- The worker must apply any claimed-From filter only after exact mailbox
  parsing and must not convert the match into actor authority.
- A usable plain-text body must come from the retrieved text part or a
  deterministic HTML-to-text conversion. If neither produces a body,
  hydration must fail rather than start a context-poor run.
- Header values, body, and attachment metadata must be length-bounded and
  encoded as data in the model-visible envelope.
- The worker must store ordered Delivery Attachment descriptors containing an
  opaque Kestrel attachment ID, server-only provider attachment ID, provider
  order, filename, declared media type, provider size, disposition, and content
  ID. No provider download URL may be stored.
- Receipt state must support `queued`, `hydrating`, `admitted`, `materialized`,
  `rejected`, and `failed`, with stable transition and reason evidence.

### Triggered-turn materialization

- The receipt must reserve stable Thread, message, and turn identities before
  admission.
- A locked materialization transaction must recheck the enabled Trigger and
  revision, Execution Owner Organization and Project access, current Project
  context revision, Project Environment, and current model availability.
- Materialization must create a private Project Thread with
  `workspaceMode: "primary"` and one Build-mode durable turn with
  `noninteractive: true`.
- The Trigger creator must be persisted as `authorUserId`.
- The materializer must use the existing durable-turn transaction, queue
  intent, reconciliation, execution route, recovery, and evidence contracts.
- Hosted and Desktop-backed execution must continue to be selected by the
  existing Project Environment route.
- Version one must preserve the existing `web` Thread origin and message/turn
  source. Exact email provenance must come from the Delivery Receipt relation
  and presentation rather than widening shared source enums.
- After materialization, the Thread and turn records must remain the authority
  for execution state; the receipt must not duplicate running or terminal turn
  state.

### Agent input contract

- The Project context revision must remain trusted system context.
- The first user message must be generated by Kestrel from a versioned,
  deterministic envelope containing Trigger name and instruction, an explicit
  untrusted-input warning, received time, claimed From, To, Cc, Reply-To,
  subject, body, and ordered attachment descriptors.
- Email-controlled values must never select Organization, Project, secret,
  actor, model, Environment, Apps, policy, or system instructions.
- The model must see only opaque Delivery Attachment IDs. Resend email IDs,
  attachment IDs, API keys, signing secrets, and temporary URLs must remain
  server-only.

### Lazy attachment tool and file lifecycle

- A Triggered Thread linked to a Delivery Receipt must receive one additional
  read-only tool:
  `kestrel_one.email_get_attachment({ attachmentId })`.
- The tool must not appear as a general Email App resource and must not permit
  mailbox listing, message retrieval, arbitrary provider attachment access, or
  outbound email.
- The tool must accept only an opaque Delivery Attachment ID listed by the
  current Thread's linked receipt.
- Before any provider call, the execution-scoped route must bind the current
  execution ticket, Organization, Project, Thread, receipt, Execution Owner,
  and attachment and must recheck owner access.
- Calling the receipt-scoped read tool must not add a separate human approval.
  It reads only input already admitted to the current Thread. Existing policy
  remains authoritative for every external action the agent takes afterward.
- On first use, the tool must lock the Delivery Attachment, request a fresh
  provider URL, and stream the bytes through the existing
  `initializeThreadFile` and `uploadThreadFile` lifecycle as the Execution
  Owner.
- Existing byte-count verification, hashing, media detection, blob
  deduplication, quarantine, representation processing, Thread grant, immutable
  source, and 100 MiB per-file limit must remain authoritative.
- The model and durable turn state must never receive or retain the provider
  URL.
- Each Delivery Attachment must bind to at most one ready Thread-scoped Kestrel
  file. Repeated and concurrent calls must converge on and open that file.
- The same tool call must return the existing `kestrel.files.open` bounded
  representation: filename, detected media type, verified size and hash,
  representation kind, extracted text when available, and an authorized
  immutable source when required.
- Imported files must remain accessible to later turns in that Thread through
  the ordinary `kestrel.files.open` contract.
- Delivery Attachment state must support `available`, `importing`, `ready`, and
  an explicit nonretryable `failed` state.
- A transient retrieval failure must return the attachment to `available` so a
  later call can request fresh access. The implementation must use existing
  retry ownership and must not add an unapproved heuristic cap.
- Image-only and other non-text representations must use the existing
  file-open result. Adding OCR specifically for Email Triggers or a native
  image-capable tool result is outside the MVP.

### Security, privacy, and failure contracts

- A verified Resend signature must prove only that Resend sent the event; it
  must not be presented as proof of the original human sender.
- Trigger addresses, API keys, webhook secrets, execution credentials,
  provider IDs, temporary URLs, and raw signed bodies must be excluded from
  ordinary logs, analytics, user-visible errors, and model context.
- User-visible and operator-visible failures must use stable classifications
  for signature rejection, invalid payload, duplicate delivery, no Trigger,
  ambiguous Trigger, claimed-From mismatch, content hydration, owner access,
  Trigger revision, model availability, attachment retrieval, file integrity,
  quarantine, and representation failure.
- A failure at a secondary presentation or telemetry boundary must not replace
  the original durable failure.
- Disabling or rotating a Trigger must prevent future materialization without
  deleting historical receipts, Threads, turns, or evidence.
- Disabling inbound receiving must stop new receipts without cancelling
  materialized work.
- Maintenance must purge rejected and failed nonmaterialized receipt records at
  30 days without touching materialized Threads, turns, files, or their linked
  receipt and Delivery Attachment state.

### Observability, migration, and verification

- Durable events and metrics must distinguish webhook receipt, verification,
  duplicate detection, hydration, Trigger resolution, rejection, admission,
  materialization, execution routing, and attachment import outcomes.
- Operators must be able to correlate the Receiving Connection, Delivery
  Receipt, Trigger, Thread, turn, and Delivery Attachment with internal opaque
  IDs while protected provider and address values remain redacted.
- The existing outbound Email configuration and `email.send` App resource must
  continue to work unchanged.
- The change is additive; there is no legacy inbound email data or execution
  path to migrate.
- Schema and workers must support an ordered rollout in which new inbound
  functionality stays disabled until its persistence, webhook, and worker
  owners are available.
- Tests must cover raw-body verification, wrong or stale signatures, malformed
  events, opaque connection routing, tenant isolation, duplicate and concurrent
  delivery, queue reconciliation, exact recipient resolution, ambiguous
  recipients, claimed-From filtering, HTML-to-text fallback, empty-body
  failure, Trigger revision, owner access, model availability, and durable turn
  idempotency.
- Retention tests must prove immediate removal of hydrated content from
  nonmaterialized terminal receipts, preservation of the allowed minimal
  diagnostic fields before day 30, purge at day 30, bounded replay
  deduplication, and Thread-lifecycle preservation for materialized receipts.
- Attachment tests must cover cross-Thread and cross-receipt IDs, owner access,
  concurrent first use, byte mismatch, media detection, size limit, quarantine,
  transient retrieval, explicit provider failure, representation failure,
  repeat reuse, later `kestrel.files.open`, provider-ID redaction, and URL
  redaction.
- Execution tests must prove both hosted execution and durable waiting for a
  disconnected Desktop-backed Environment.
- Management-surface tests must prove Kestrel One/Desktop state parity,
  write-only credential handling, signed-out and non-Admin Desktop behavior,
  cross-Organization rejection, post-mutation refresh, and continued receiving
  after Desktop closes.
- The portable `pnpm validate`, PostgreSQL boundary, and Desktop process
  boundary gates must pass before publication.

## People and Operating Requirements

- Organization Admins own the Resend Full access credential, receiving domain,
  webhook lifecycle, inbound enablement, and connection-health response from
  either Kestrel One or Kestrel Desktop.
- Project editors own each Trigger's purpose, instruction, model, optional
  filter, address sharing, rotation, disablement, and deletion.
- The Trigger creator accepts ongoing Execution Owner responsibility. If that
  person loses access, Kestrel disables the Trigger for new work rather than
  silently choosing another actor.
- Project owners remain responsible for the Apps, approval rules, spending
  limits, and Environment that make the triggered run useful.
- Email senders need no Kestrel account and receive no Kestrel authority or
  delivery-status promise in the MVP.
- Thread users must be able to inspect the original normalized email, triggered
  run, tool calls, approvals, failures, imported files, and terminal evidence
  through existing Kestrel surfaces with email provenance added.
- Support must be able to distinguish provider ingress, configuration,
  filtering, Project authority, execution routing, and attachment failures
  without seeing secrets or temporary URLs.
- Operators own receipt-worker health, reconciliation, queue latency, webhook
  freshness, redaction audits, and storage/database health.
- Security review owns the private-address capability model, raw-body signature
  boundary, secret handling, tenant binding, sender-authentication language,
  attachment authorization, and retention decision.
- Release operators must verify persistence and workers before registering or
  enabling production webhooks.
- No operator should manually forward messages, download attachments, start
  turns, or reconnect Desktop as part of normal operation.

## Success and Readiness

Success is observable when:

- An Admin configures inbound receiving from Kestrel One or Kestrel Desktop
  without disturbing a working outbound Email setup; both surfaces show the
  same hosted state.
- No Resend or webhook secret survives in Desktop renderer state, local
  settings, logs, analytics, or support bundles, and receiving continues after
  Desktop closes.
- A Project editor creates a Trigger in a short form, copies its private
  address, and does not have to configure a second tool or autonomy policy.
- A real email to that address creates exactly one private Thread and one
  noninteractive durable turn with the current Project context and normalized
  email details.
- The same email replayed by Svix ID or Resend email ID creates no duplicate
  work.
- A text-extractable PDF invoice appears as an attachment descriptor, the agent
  calls `email_get_attachment`, and the same call returns readable verified
  content.
- A repeated attachment call performs no second Resend download and reuses the
  same Thread-scoped Kestrel file.
- The triggered agent can invoke an already-connected business App under the
  Project's existing approval and spending rules.
- A disconnected Desktop-backed Project waits durably and runs after Desktop
  reconnects without resending the email.
- An invalid signature, ambiguous recipient set, filter mismatch, disabled
  Trigger, stale Trigger revision, inaccessible Execution Owner, or unavailable
  model starts no model work and leaves a stable inspectable outcome.
- Cross-Organization, cross-Project, cross-Thread, cross-receipt, and arbitrary
  provider attachment access are rejected.
- Trigger addresses, credentials, provider IDs, temporary URLs, and raw signed
  bodies do not appear in model context, logs, analytics, durable events, or
  user-visible errors.
- Focused ingress, persistence, hydration, admission, materialization,
  attachment, hosted/Desktop routing, redaction, and end-to-end tests pass.
- `pnpm validate`, the PostgreSQL boundary gate, and the Desktop process
  boundary gate pass.

**Readiness: Ready for issue creation.**

The product behavior, UX, ownership, admission model, durable execution seam,
attachment contract, security boundaries, failure behavior, deployment shape,
retention policy, and acceptance evidence are settled. Rejected and failed
nonmaterialized receipts discard hydrated content immediately, retain only
minimal diagnostic metadata and a stable terminal reason for 30 days, and are
then purged. Materialized content and attachment authorization state follow the
linked Thread lifecycle.

Primary-workspace serialization is an explicit MVP default and does not block
delivery. Image-only model readability is also non-blocking because this brief
limits the MVP to the existing file-open representation and uses a
text-extractable PDF as the attachment acceptance case.

## Source Artifacts

- [Email-Triggered Agent Runs Change Design](../design/email-triggered-agent-runs-change-design.md)
- [Email-Triggered Agent Runs Design Notebook](../../.design/email-triggered-agent-runs/notebook.md)
- [Schedule Materialization](../../apps/web/lib/schedules/runtime.ts)
- [Durable Turn Store](../../apps/web/lib/turns/store.ts)
- [Environment Execution Route](../../apps/web/lib/environments/execution-route.ts)
- [Thread File Service](../../apps/web/lib/files/service.ts)
- [Current Organization Email Configuration](../../apps/web/lib/email/organization-config.ts)
- [Resend Received Email Webhook](https://resend.com/docs/webhooks/emails/received)
- [Resend Received Email Retrieval](https://resend.com/docs/api-reference/emails/retrieve-received-email)
- [Resend Webhook Verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
- [Resend Webhook Retries and Replays](https://resend.com/docs/webhooks/retries-and-replays)
- [Resend Receiving Attachments](https://resend.com/docs/dashboard/receiving/attachments)
- [Resend Received Attachment API](https://resend.com/docs/api-reference/emails/list-received-email-attachments)
