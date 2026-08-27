# Email-Triggered Agent Runs Design Notebook

## Current Position

The MVP adds one Project-scoped private Email Trigger. Each accepted Resend
email becomes one new private Thread and one ordinary durable background turn.
The turn runs as the member who created the Trigger, binds the Project's current
context and Environment at materialization time, and receives a normalized
plain-text email envelope as untrusted user input.

The most recent change is the private-admission model. Resend proves that a
webhook came from Resend, but does not document authentication of the original
sender. The private Trigger therefore uses an unguessable, rotatable recipient
address as a bearer capability. An optional exact `From` filter is only a
convenience filter, not an identity guarantee.

The receiving setup is one hosted Organization resource with two management
surfaces. An Organization Admin can configure and inspect it from Kestrel One
or authenticated Kestrel Desktop. Both surfaces use the same Kestrel One API
and server-authoritative state. Desktop never stores the Resend credential,
signing secret, or route locator locally and remains neither the webhook host
nor a requirement for continued receiving.

Attachment access is lazy. The turn starts with body and attachment descriptors.
It receives a trigger-scoped `kestrel_one.email_get_attachment` read tool. On
first use, that tool retrieves the selected Resend attachment, imports it into
the existing Thread-file service, and returns the same readable representation
as `kestrel.files.open`. Later calls reuse the imported file.

## Requested Change

When a configured Resend address receives an email, start an agent run with:

- the selected Project and its current Project context;
- the Project's ordinary Environment, model, Apps, approval policy, evidence,
  recovery, spend, and concurrency behavior;
- the email's claimed sender, recipients, reply-to, subject, received time,
  plain-text body, and readable attachments.

This is deliberately smaller than customer-service or invoice-processing
workflow design. It establishes useful email ingress without adding recipes,
outbound replies, public execution, or a generic workflow builder.

## Starting Sources

- Participant direction on 2026-08-26: begin with a private Trigger but retain
  a future path to public admission.
- Participant scope correction on 2026-08-26: the MVP is one email-triggered
  run with Project context and email details, not business-workflow recipes.
- `AGENTS.md`: preserve durable execution and replay, validate boundary input,
  and attach changes to the existing contract owner.
- `apps/web/lib/schedules/runtime.ts`: current autonomous Project work creates
  a private Thread and a noninteractive durable turn.
- `apps/web/lib/turns/store.ts` and `apps/web/lib/turns/queue.ts`: current
  durable turn, idempotency, ordering, dispatch, and recovery contracts.
- `apps/web/lib/environments/execution-route.ts`: current hosted/Desktop
  execution routing.
- `apps/web/lib/email/organization-config.ts`: current Resend configuration is
  outbound-only.
- `apps/desktop/renderer/src/SettingsWorkspace.tsx`,
  `apps/desktop/src/preload.ts`, and `apps/desktop/src/main.ts`: current Desktop
  Settings and signed-in Kestrel One account bridge through which an Admin can
  manage the same hosted receiving resource.
- `apps/web/lib/files/service.ts`: current file ingestion requires an existing
  accessible Thread and a user-backed upload.
- Current Resend receiving, webhook, domain, and attachment documentation.

## Relevant Current Behavior

Project Prompt Schedules are the closest proven entry path. A schedule run
reserves stable run, Thread, and message IDs; the materializer rechecks the
creator's Project access, loads the current Project context revision and
Environment, creates a private Project Thread, and calls
`createDurableThreadTurnInTransaction`. Dispatch then enters the ordinary
`thread.turn.execute` queue.

The durable-turn store requires a real `authorUserId`, a Project Environment,
an idempotency key, and a matching Project context revision. It atomically
persists the input message, turn, queue state, and queue event. The worker
reloads the exact context revision and routes through the Thread's Environment.
A Desktop-backed Environment may wait durably for Desktop connectivity; it
does not require a Desktop webhook.

Organization Resend configuration currently proves only outbound send
readiness. Its synced Email App connection exposes `email.send` and is a tool
used by running agents. Inbound receipt is different: it creates a run before
an agent exists and needs separate readiness, secret, receipt, and audit state.

The existing Thread attachment path creates Thread-scoped draft state, streams
and verifies bytes, prepares representations, and then marks the file ready. A
Triggered Turn already has the accessible Thread and Execution Owner that this
service requires. The existing `kestrel.files.open` route already returns
bounded extracted text or an authorized immutable source. A lazy email tool can
compose these existing seams without a pre-run staging lifecycle.

## Affected Surface

- Kestrel One Organization Email settings and Kestrel Desktop Settings:
  equivalent management of the same separate inbound Resend readiness.
- Project work surfaces: Trigger create, rotate, disable, and inspect.
- Public HTTP boundary: raw-body Resend verification and route ownership.
- PostgreSQL: receiving connection, Trigger, and durable delivery receipt.
- Turn worker: receipt reconciliation, body hydration, materialization, and
  dispatch.
- Thread and turn store: reuse without weakening actor, context, or replay
  invariants.
- Environment routing: unchanged; hosted and Desktop remain destinations.
- Trigger-scoped runtime tool: resolve one opaque Delivery Attachment ID and
  lazily import it through the existing Thread-file service.
- Security and privacy: bearer-address handling, redaction, raw-body handling,
  retention, spoofable sender fields, and full-access Resend credentials.

## External Research

- `email.received` includes metadata and attachment descriptors, not body,
  headers, or attachment bytes. Kestrel must retrieve full content after it has
  durably recorded the event.
- Webhook verification requires the untouched request body plus Svix ID,
  timestamp, and signature. The opaque connection locator in the route selects
  the secret before the payload is interpreted.
- Delivery is at least once, unordered, retried, and replayable. The receipt
  must be unique by connection plus Svix ID, and materialization must also be
  unique by connection plus Resend email ID.
- Received attachment download URLs expire after one hour but can be refreshed.
  Lazy access must request a new URL at tool-call time rather than persisting a
  provider URL in the turn.
- Resend documents arbitrary retrieved headers but no trusted inbound SPF,
  DKIM, or DMARC verdict. Claimed sender equality is not secure admission.
- Inbound domain and webhook management requires a Full access Resend API key;
  a Sending access key is insufficient. Inbound readiness must be separate
  from outbound send readiness.

## Candidate Seams and Options

### Selected: receipt adapter into the durable Project turn pipeline

Persist a verified receipt, hydrate it asynchronously, then materialize a
private Project Thread and durable turn using the schedule pattern. This keeps
Project context, execution policy, Desktop routing, replay, waits, and evidence
inside their existing owners.

### Rejected: generic SDK webhook runner

`createWebhookRunRouteHandler` maps JSON directly to an agent input. It does
not own raw-body verification, tenant routing, durable receipt, Project Thread
creation, Project context, attachments, or Kestrel queue recovery.

### Rejected: Desktop-owned receiving

Desktop is an execution provider, not a stable internet ingress. A Desktop
webhook or tunnel would duplicate admission and fail while the machine is
offline.

Desktop may still configure the hosted Receiving Connection. Its renderer uses
an explicit typed preload/main/local-core boundary to the signed-in Kestrel One
account; it does not copy the connection into local Desktop settings. A secret
entered in Desktop is write-only, leaves the renderer in one mutation, is
cleared immediately, and is never returned by the hosted API.

### Selected: lazy trigger-scoped attachment tool

The first turn contains an opaque Delivery Attachment ID, filename, provider
media type, size, and disposition for each file. The read-only
`kestrel_one.email_get_attachment` tool accepts only that opaque ID. The runtime
route binds the current execution ticket, Thread, receipt, and attachment before
using the Organization's Resend credential.

On first use, the tool asks Resend for a fresh download URL, streams the file
through `initializeThreadFile` and `uploadThreadFile` as the Execution Owner,
persists the resulting Kestrel file ID, and returns the same bounded text or
immutable source shape as `kestrel.files.open`. Repeated calls reuse the ready
file. This preserves Kestrel's file checks and later Thread visibility without
delaying the run or creating a second attachment system.

### Deferred: service execution principal

Current turns and Project context grants require a member actor. A service
principal would change authorization across the runtime. The MVP instead runs
as the Trigger creator and disables admission when that member loses access.

## Proposed Delta

1. An Organization Admin uses Kestrel One or signed-in Kestrel Desktop to
   prepare inbound readiness on the existing Resend connection by supplying a
   Full access credential and selecting a receiving subdomain. Both surfaces
   show the same server state and keep outbound and inbound health separate.
   Desktop sends changes to Kestrel One and persists no provider secret or
   connection copy locally.
2. A Project editor creates a Trigger with a name, run instruction, model, and
   optional exact claimed-From filter. Kestrel records the creator as Execution
   Owner and generates an unguessable recipient address.
3. The webhook route resolves an opaque connection locator, reads the untouched
   body, verifies it with the encrypted signing secret, validates the event,
   and inserts an idempotent queued receipt. Invalid events never select a
   tenant from their payload.
4. A reconciled worker retrieves the email, resolves exactly one private
   Trigger by exact generated recipient address, applies the optional claimed
   sender filter, and stores body plus attachment descriptors.
5. The materializer rechecks the Execution Owner's Project access, current
   Project context, Environment, and model availability. It creates one private
   Thread and one noninteractive durable turn in a locked transaction.
6. The ordinary queue and Environment route execute the turn. Hosted Projects
   run hosted; Desktop-backed Projects wait for and run on Desktop.
7. When the agent needs a file, `email_get_attachment` validates the current
   Thread/receipt binding, retrieves and imports that file, and returns its
   readable representation. Existing `kestrel.files.open` can reopen it later.
8. Existing Thread and turn status remains the execution truth. The receipt
   owns ingress, body hydration, attachment identity, and materialization
   evidence.

The user message is a deterministic plain-text envelope. Server-authored labels
and the Trigger instruction precede a clearly delimited untrusted email body.
Project context remains system context through the existing context-revision
grant; it is not copied into the email message.

## Domain Model

- **Receiving Connection:** Organization-owned Resend inbound capability,
  domain, webhook identity, encrypted signing secret, opaque route locator, and
  health evidence. It is distinct from outbound readiness.
- **Email Trigger:** Project-scoped configuration with private address, run
  instruction, model, Execution Owner, claimed-sender filter, access mode, and
  enabled state.
- **Execution Owner:** the Project member whose existing authority is used to
  materialize and execute a Triggered Turn.
- **Delivery Receipt:** the durable, verified record of one Resend event and its
  hydration/materialization outcome.
- **Delivery Attachment:** one provider attachment's opaque Kestrel identity,
  stable metadata, order, lazy-import state, and eventual Thread-scoped Kestrel
  file identity.
- **Triggered Turn:** the ordinary durable Project turn created from one
  accepted receipt.

Invariants:

- Unverified content never chooses Organization, Project, Trigger, or secret.
- One connection plus Svix ID creates at most one receipt.
- One connection plus Resend email ID creates at most one Triggered Turn.
- An accepted MVP email must resolve exactly one enabled Trigger recipient.
- Email content cannot choose actor, model, Environment, Apps, policy, or
  Project context.
- The Execution Owner must retain Project access when materialization begins.
- The model can request only Delivery Attachment IDs listed in its own email
  message.
- An attachment tool call must bind Organization, Project, Thread, receipt,
  Execution Owner, and attachment before Resend retrieval.
- One Delivery Attachment maps to at most one ready Thread-scoped Kestrel file.
- Every accepted email creates a new private Thread.
- The private address is a bearer capability; rotating it invalidates the old
  address without changing existing Threads.
- `From` and other email fields remain untrusted even when they pass a filter.
- Existing Project policy is the only execution-policy system.

Receipt state is `queued -> hydrating -> admitted -> materialized`, with
terminal `rejected` and `failed` outcomes. Delivery Attachment state is
`available -> importing -> ready`, with `failed` for an explicit nonretryable
provider or file result. A transient failure remains available for a later tool
call with a fresh Resend URL.

## Decisions

- Use a narrow Resend receipt adapter and the ordinary durable Project turn
  seam. Confidence: high. Reopen only if the durable-turn contract is replaced.
- Keep Kestrel One as ingress owner and the Project Environment as execution
  owner. Confidence: high.
- Expose equivalent Receiving Connection management in Kestrel One and
  authenticated Kestrel Desktop, backed by one Kestrel One API and no local
  Desktop secret persistence. Confidence: high.
- Run as the Trigger creator and disable/reject new delivery after access loss.
  Confidence: high for MVP. Reopen when Kestrel has a real service-principal
  authorization model.
- Define private admission as possession of an unguessable, rotatable address.
  Confidence: high. Reopen if Resend publishes a trustworthy sender-auth result
  or Kestrel adds a stronger challenge protocol.
- Treat claimed-From matching as optional filtering only. Confidence: high.
- Use a new private `primary` Project Thread and noninteractive turn for each
  email. Confidence: medium. Reopen if inbox throughput requires independent
  isolated workspaces or separate Trigger concurrency.
- Give Triggered Turns a read-only, receipt-scoped
  `kestrel_one.email_get_attachment` tool. Confidence: high. The tool accepts
  only an opaque Delivery Attachment ID from the current email.
- Import a requested attachment lazily through the existing Thread-file
  service, then return the `kestrel.files.open` representation. Confidence:
  high. This removes pre-run staging while keeping verified storage, extraction,
  immutable sources, and subsequent Thread access.
- Use `web` origin/source plus the receipt relation in v1 instead of expanding
  shared enums. Confidence: medium. Reopen if consumers need email provenance
  without joining receipt state.
- Keep an explicit `private` access-mode value but expose no public controls in
  the MVP. Confidence: high.

## Research and Prototypes

No prototype was needed. The code trace proved the schedule-to-durable-turn
path, current Environment routing, execution-scoped App relay, reusable
Thread-file upload seam, and `kestrel.files.open` representation contract.
Current Resend docs and installed SDK types proved the raw-body, retrieval,
retry, attachment-list/download, refreshable-URL, API-key-scope, and
sender-authentication constraints.

## Active Change Frontier

- Whether Project-primary serialization is sufficient for initial volume.
- Whether image-only attachments use the existing OCR service in the MVP or
  wait for a native image-capable tool-result contract.

Receipt retention is settled. Raw signed bodies are never retained. A rejected
or failed receipt that never materializes immediately discards hydrated body
and content-derived attachment metadata, retains only minimal diagnostic
metadata and its stable terminal reason for 30 days, then is purged. A
materialized receipt and its Delivery Attachments follow the linked Thread
lifecycle because they remain provenance and attachment-authorization state.

## Decision Map

- Status: not needed
- Path: none
- Destination: a coherent private email-to-Project-turn MVP
- Return condition: ordinary change design is complete

## Best Next Move

The Product Brief is ready for issue creation. Its end-to-end acceptance case
shows the agent receiving a text-extractable PDF invoice descriptor, calling
`email_get_attachment`, reading the extracted invoice, and reusing the same
Kestrel file on a repeated call.
