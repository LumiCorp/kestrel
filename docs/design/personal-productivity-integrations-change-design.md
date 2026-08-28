# Personal Productivity Integrations Change Design

> Delivery scope update, 2026-08-27: the participant deferred Outlook Mail and
> Outlook Calendar. The current Product Brief covers Teams, Gmail, Google
> Calendar, and shared governance. This design retains the Outlook analysis for
> a future delivery.

## Executive Summary

Complete the existing first-party Microsoft 365 and Google Workspace Apps. Do
not add another connector framework and do not route Desktop credentials through
hosted Kestrel.

The stable App manifest remains the product boundary. The existing
`src/apps/microsoft365.ts` and `src/apps/googleWorkspace.ts` modules become the
single native operation contracts used by hosted Kestrel and Local Core. Each
contract owns the provider's packs, scopes, operations, parsers, normalized
results, write classification, minimum approval, resource identity, and host
tool names. One shared provider client per App owns provider request and response
behavior. Hosted and Desktop keep separate authorization, Project policy,
approval, audit, health, credential, and file adapters.

This seam fits the application because most of it already exists. Desktop tools
already call service ports defined in `src/apps`; hosted and Desktop currently
duplicate the semantics around those ports. Making that existing boundary
authoritative fixes the drift without moving credentials or persistence across
security boundaries.

The completed personal-first surface is:

- Outlook Mail: search, full message read, conversation context when Graph can
  support it reliably, attachment metadata and explicit retrieval, approved new
  mail, and approved reply with Thread files.
- Outlook Calendar: primary-calendar range read and approved create, partial
  update, and delete.
- Teams: list chats, read one chat's history, and send an approved message to an
  existing chat.
- Gmail: search, full message and thread read, attachment metadata and explicit
  retrieval, approved new mail, and approved reply with Thread files.
- Google Calendar: the existing primary-calendar read and approved CRUD surface,
  with hosted/Desktop contract and paging parity.

“Personal” means a user-owned delegated connection. For this change, Microsoft
accounts remain work or school accounts because the selected Teams chat APIs do
not support consumer Microsoft accounts. Shared mailboxes, service identities,
Teams channels, SharePoint, Google Drive, and Google Chat remain outside the
change.

## Requested Outcome

A user connects their own Microsoft 365 account and selects Outlook, Teams, or
both. They attach the connection to a Project. The Project receives only the
selected capabilities whose OAuth scopes were actually granted. Reads happen
without per-call approval. Every send, reply, calendar mutation, invitation,
update, or cancellation requires approval bound to the exact provider target
and content.

A user connects their Google account and selects Gmail, Calendar, or both.
Adding Gmail to an existing Calendar connection uses incremental authorization.
Declining Gmail access does not break Calendar. The same Project, approval,
health, and audit rules apply.

The behavior must exist in hosted Kestrel and Desktop. A connection may be
configured once and reused, but a run receives its tools from its Project. A
connected App must not silently become available in every Desktop Project.

The user must be able to tell the difference between:

- connected and healthy;
- connected but missing new scopes;
- blocked by tenant approval;
- revoked or expired authorization;
- authenticated but forbidden from a resource;
- throttled by the provider; and
- a provider or network failure.

Release evidence must include live personal-account proof for each supported
provider and host. Mocked tests remain necessary, but they do not prove OAuth,
tenant policy, provider response shape, refresh behavior, or packaged Desktop
behavior.

## Relevant Current Behavior

The shared protocol manifest already owns stable App IDs and capability-pack
names. Microsoft 365 exposes Outlook, Teams, and SharePoint. Google Workspace
exposes Calendar only
([`packages/protocol/src/apps.ts`](../../packages/protocol/src/apps.ts#L1)).

Hosted Kestrel follows this path:

`manifest -> tool registry -> persisted App catalog -> Project attachment and policy -> runtime tool profile -> provider route -> approval, token, provider API, health, audit`

The registry materializes capability defaults and runtime names
([`apps/web/lib/tools/registry.ts`](../../apps/web/lib/tools/registry.ts#L467)).
The App service persists them and updates existing catalog rows
([`apps/web/lib/apps/service.ts`](../../apps/web/lib/apps/service.ts#L105)).
Project access chooses a personal connection, intersects Environment and Project
policy, and filters Microsoft tools by selected pack
([`apps/web/lib/apps/project-service.ts`](../../apps/web/lib/apps/project-service.ts#L939)).
The runtime profile then repeats manual tool-to-capability maps
([`apps/web/lib/agent/kestrel-tool-profile.ts`](../../apps/web/lib/agent/kestrel-tool-profile.ts#L162)).
Provider routes own execution-ticket validation, effective Project access,
approval consumption, token access, health degradation, and audit
([Microsoft route](../../apps/web/app/api/runtime/microsoft-365/action/route.ts#L36),
[Google Calendar route](../../apps/web/app/api/runtime/google-calendar/action/route.ts#L35)).

Desktop follows a parallel path:

`manifest -> standard connection metadata -> Desktop settings -> execution selection -> Desktop tool -> Local Core service -> provider API`

The existing `src/apps` modules already define pack scopes, operation unions,
tool sets, and service ports
([Microsoft](../../src/apps/microsoft365.ts#L1),
[Google](../../src/apps/googleWorkspace.ts#L1)). Desktop tools depend on those
ports
([Microsoft tool](../../tools/microsoft365/desktop.ts#L1),
[Google tool](../../tools/googleWorkspace/desktop.ts#L1)), and Local Core
provides the concrete services
([Microsoft service](../../src/localCore/microsoft365Service.ts#L26),
[Google service](../../src/localCore/googleWorkspaceService.ts#L9)).

The contract is still duplicated across host-specific schemas, tools, provider
request code, scope tables, approval lists, and runtime maps. The parity test
compares a selected subset after the fact; it does not make one source
authoritative
([`tests/unit/app-connection-parity.test.ts`](../../tests/unit/app-connection-parity.test.ts#L33)).

Current provider behavior is incomplete:

- Outlook lists recent message previews, sends new plain-text mail, and lists a
  calendar range. It cannot search, return a full message, read attachments,
  reply, send attachments, or mutate Calendar.
- Teams lists chats or switches to chat-message history when the same operation
  receives a chat ID. It sends a plain-text message to an existing chat. The
  overloaded list operation has two resource shapes and no usable continuation
  input.
- Hosted Google Calendar supports primary-calendar CRUD and a separate
  teammate free/busy path. Desktop supports primary-calendar CRUD. The list
  result can return a continuation token, but the model operation cannot supply
  one.
- Gmail has no pack, scopes, tools, routes, Local Core service, health contract,
  or tests.

There are also two governance gaps.

First, provider routes force approval for Microsoft sends and Google Calendar
mutations, while the App catalog defaults a missing minimum approval to
`auto`
([`apps/web/lib/apps/catalog.ts`](../../apps/web/lib/apps/catalog.ts#L118)).
The UI can therefore save Automatic, the runtime omits approval, and the route
rejects the write. The system is safe but unusable.

Second, Desktop receives an App selection in the run request, then the main
process replaces it with every globally enabled App
([`apps/desktop/src/main.ts`](../../apps/desktop/src/main.ts#L391),
[`apps/desktop/src/main.ts`](../../apps/desktop/src/main.ts#L2153)). Connection
authorization is personal, but tool exposure is not Project-scoped.

The existing Thread-file boundaries are suitable for mail attachments. Hosted
resolves only files owned by the current user, organization, and Thread and
requires a ready, non-quarantined file
([`apps/web/lib/files/service.ts`](../../apps/web/lib/files/service.ts#L523)).
Desktop resolves Thread-bound local attachments and verifies their hashes
([`src/localCore/desktopAttachments.ts`](../../src/localCore/desktopAttachments.ts#L204)).
There is no need for a second attachment store.

Focused mocked integration tests passed during discovery on 2026-08-27. No
retained live proof was found for Outlook, Teams, Gmail, or Google Calendar.

## Affected Surface

The affected slice is bounded to the first-party personal App path:

- The protocol manifest gains the Gmail pack and accurate Outlook and Google
  Workspace descriptions. App IDs remain stable.
- `src/apps` becomes the native contract owner for both providers.
- Shared provider clients own API paths, request headers, MIME handling,
  pagination, normalization, retry classification, and provider error mapping.
- Hosted adapters retain execution-ticket checks, Project access, approval
  persistence, Better Auth or Microsoft OAuth tokens, connection persistence,
  admin audit, and hosted Thread files.
- Local Core adapters retain the local credential store, Desktop approval and
  run evidence, Project-selected Apps, and local Thread files.
- Persisted connection metadata records selected packs, actual granted scopes,
  and health by pack. Existing flexible metadata can carry this state; the
  design does not require a new connection identity model.
- Project attachment and Environment capability materialization remain generic.
  Gmail does not get a parallel Project-policy system.
- The Organization Email App remains unchanged. Its Resend sender and inbound
  trigger authority are different from a user's mailbox.
- SharePoint and Drive-backed files remain excluded. A Teams chat message may
  report link or card metadata, but the integration does not download the
  linked file.

One new policy boundary is unavoidable: Gmail read content is restricted-scope
data and enters the selected language-model route. Environment model admission
must be able to state explicitly whether a route is eligible to process that
data under the disclosed purpose, processor, retention, training-use, and
deletion terms. This is an explicit policy contract, not a content classifier,
provider-name heuristic, or fallback ranking rule. It requires participant
approval because it changes Kestrel's data-use policy. The participant approved
the policy on 2026-08-27.

## External Findings That Shaped the Design

### Microsoft identity and permissions

Microsoft's `organizations` authority accepts work and school accounts. Teams
chat endpoints in this design do not support delegated consumer Microsoft
accounts. Keeping the current authority is therefore coherent; changing only
the authority to `common` would let a consumer connect and then fail every Teams
operation. Consumer Outlook.com support should be a separate identity expansion
with pack-level compatibility rules
([Microsoft identity authorities](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc),
[supported account types](https://learn.microsoft.com/en-us/entra/identity-platform/supported-accounts-validation)).

Outlook search, full read, and attachment retrieval need `Mail.Read`; send and
direct reply need `Mail.Send`; Calendar CRUD needs `Calendars.ReadWrite`.
Structured attachment staging and large uploads use message drafts and therefore
also need `Mail.ReadWrite`. The completed Outlook pack should request
`Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, and `Calendars.ReadWrite`. The Teams
pack should keep the narrower `Chat.Read` and `ChatMessage.Send` scopes
([Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)).
The Outlook scopes and `Chat.Read` do not require admin consent by default,
although tenant policy can still restrict user consent. `ChatMessage.Send`
explicitly requires tenant-admin consent. A Teams connection can therefore be
healthy for chat reads while send remains unavailable pending admin approval.
Kestrel must not report that state as a revoked connection
([Microsoft user and admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/user-admin-consent-overview)).

Graph collection responses use `@odata.nextLink`. Microsoft requires clients to
reuse the entire link and not reconstruct `$skip` or `$skiptoken`. Outlook item
IDs can also change when an item moves unless every relevant call asks for
immutable IDs. These facts require a Kestrel cursor envelope and consistent
`Prefer: IdType="ImmutableId"` headers
([Graph paging](https://learn.microsoft.com/en-us/graph/paging),
[immutable Outlook IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)).

Outlook send and reply return `202 Accepted`, not a delivered message or even a
stable provider message ID. Kestrel's result must say `accepted`; it must not say
`sent` or `delivered`
([send mail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0),
[reply](https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0)).
Teams send instead returns the created chat message, so Kestrel can preserve its
provider ID and timestamp
([send a chat message](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0)).

Calendar mutations have communication side effects. Creating an event with
attendees sends invitations, attendee changes send updates, and deleting an
organized meeting sends cancellations. An online meeting's body also contains a
provider-managed meeting block that must be preserved during body updates.
Approval must describe those effects, and the adapter must use partial updates
without destroying provider-managed content
([create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0),
[update event](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0),
[delete event](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0)).

### Google scopes and restricted-data policy

Gmail needs two scopes for the agreed behavior: `gmail.readonly` for search,
message and thread read, and attachments; and `gmail.send` for send and reply.
`gmail.readonly` is restricted while `gmail.send` is sensitive. Broader modify,
compose, or full-mail scopes are unnecessary
([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)).

Gmail has a real thread resource. Reply is not a special method: Kestrel sends
an RFC 2822 MIME message with the provider thread ID and correct
`References`/`In-Reply-To` headers. The provider adapter must derive those
headers and recipients from the target message. They are not model-authored
fields
([Gmail threads](https://developers.google.com/workspace/gmail/api/guides/threads),
[sending email](https://developers.google.com/workspace/gmail/api/guides/sending)).
Attachment bytes are fetched only through the explicit attachment endpoint,
which supports the decision to return metadata first and import bytes lazily
([Gmail attachment API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get)).

Google recommends incremental authorization and requires the application to
handle partial grants. Better Auth 1.6.23 already places
`include_granted_scopes=true` on Google authorization requests, and Kestrel's
link route can request additional scopes. The missing application behavior is
pack and granted-scope persistence, operation gating, and partial health—not a
second OAuth implementation
([Google incremental authorization](https://developers.google.com/identity/protocols/oauth2/web-server),
[granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)).

Public use of `gmail.readonly` requires restricted-scope verification and may
require recurring security assessment for the hosted and model data path.
Google's policy permits productivity features and generative summaries, but
requires clear in-context disclosure, limited use, security controls, and no
transfer for training a generalized model. This changes both release admission
and runtime model eligibility
([Workspace user-data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy),
[restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification),
[security assessment](https://support.google.com/cloud/answer/13465431)).

### Provider-specific attachment limits

Microsoft supports a direct attachment path and a larger upload-session path;
the mailbox's configured message limit can still be lower. Gmail applies its
own raw-message upload and account rules. A new common Kestrel size threshold
would either reject supported provider behavior or promise behavior an account
will reject. The operation should use the existing Thread-file limits, choose
the documented provider path, preflight what the provider exposes, and preserve
a typed provider rejection
([Microsoft large attachments](https://learn.microsoft.com/en-us/graph/outlook-large-attachments),
[Gmail uploads](https://developers.google.com/workspace/gmail/api/guides/uploads)).

## Options and Candidate Seams

### Extend hosted and Desktop independently

This is the smallest local diff. It also preserves the reason the current
behavior drifted: scopes, operation names, Zod schemas, approval requirements,
provider calls, paging, and result shapes would be restated in several places.
Every Gmail or Outlook addition would double that cost. More parity assertions
would detect some differences after the fact but would not establish ownership.

### Move all behavior into the public protocol manifest

Both hosts already consume the manifest, so it is a tempting central point. The
manifest deliberately owns stable product identity and metadata while runtime
drivers remain internal. Putting provider clients, OAuth requirements, host
resource selection, and runtime result contracts there would turn a small
public protocol into an execution framework. That broadens the wrong boundary.

### Keep the manifest stable and make `src/apps` authoritative

This is the chosen seam. `src/apps` already owns the operation unions, pack
scopes, tool sets, and service ports used by Desktop. It can become the one
native operation catalog without adding a new architectural layer. Shared
provider clients can sit beside it. Hosted and Local Core then supply their
existing host-owned services.

Routing Desktop through hosted Kestrel was also considered and rejected. It
would move local personal authorization across a new boundary, require hosted
availability, and change Local Core's security and offline behavior solely to
avoid a provider client module.

## Proposed Delta

### Contract ownership

The protocol manifest continues to own stable App IDs, product names, and
user-visible pack names. Google Workspace gains an additive `gmail` pack. The
Microsoft packs stay `outlook`, `teams`, and the currently excluded
`sharepoint`; no new generic Mail App is introduced.

Each provider module in `src/apps` owns a declarative operation catalog. Every
operation carries:

- a provider-specific operation ID;
- its capability and pack;
- exact required OAuth scopes;
- one input parser and normalized result contract;
- read or external-write classification;
- minimum approval mode;
- hosted and Desktop tool names;
- the logical approval operation and resource selector;
- safe audit fields and result identity; and
- the service-port method that executes it.

All consumers derive from this catalog. The hosted App registry no longer
defaults a write's minimum approval independently. The runtime profile no longer
maintains a second manual tool map. Desktop's standard connection table no
longer restates scopes, tools, and approval-required tools.

The tools remain provider-specific—for example, Microsoft and Google mail tools
have separate names and descriptions. The internal catalogs share stable terms
and result structures where the providers genuinely align. There is no generic
tool with a provider switch and no hidden provider routing.

### Mail operations and results

Outlook and Gmail expose parallel model-facing behaviors:

- search or list messages with a provider-native query and Kestrel cursor;
- read one full message;
- read conversation context where the provider reliably supports it;
- list attachment metadata as part of the full message result;
- import one attachment explicitly into the current Thread;
- send a new message after approval; and
- reply to a provider message after approval.

The normalized message result preserves the fields needed for later calls:
provider, connected account, message ID, conversation or thread ID, subject,
addresses, sent and received times, unread state, body content type and text,
attachment metadata, source link when available, and a continuation cursor.
Provider IDs remain opaque and are accepted only by the connection and operation
family that issued them.

Search inputs remain provider-native. Kestrel does not translate Gmail search
syntax into Outlook KQL, infer folders from keywords, rank results, or add a
fallback query. Provider-specific tool descriptions explain the supported
syntax. This avoids a hidden heuristic layer and preserves provider truth.

Gmail thread read is a direct provider operation. Outlook has no equivalent
mailbox-thread resource. The client may assemble a bounded conversation from
messages with the same immutable `conversationId` only after a live Graph probe
confirms that the intended server-side filter is reliable. Until then, the full
message result preserves the conversation ID but the product must not promise a
complete Outlook thread.

Gmail replies bind a target message or thread. The provider adapter reads the
target and derives recipients, subject continuity, thread ID, and RFC reply
headers. Outlook replies rely on Graph's target-message behavior. The model
supplies the new body and optional Thread file IDs, not protocol headers or
provider MIME structure.

### Attachment boundary

Mail search and message read return attachment metadata, never large base64
payloads. An explicit attachment-read operation streams provider bytes through
the existing Thread-file service. Hosted applies ownership, quarantine, and
ready-state checks. Desktop applies Thread identity and hash checks. The
resulting file follows normal Thread access, retention, deletion, and model-file
rules.

Reference attachments that actually live in OneDrive or SharePoint remain
metadata-only because those providers are outside this change. Teams cards,
hosted content, and Drive-backed files follow the same rule.

Send and reply accept only ready Thread file IDs. Before approval, Kestrel binds
the ordered file IDs, names, media types, sizes, and content hashes with the
recipients, subject, body, and reply target. Immediately before upload, the host
resolves those files again and rejects changed, missing, quarantined, or
unauthorized bytes.

The shared provider client chooses the provider-documented send path. Microsoft
may need an internal temporary draft and upload session for a message that
cannot use the direct request. That draft is an execution detail, not a
user-facing Drafts feature. No provider mutation occurs before approval. If a
staged operation fails, the adapter makes a bounded cleanup attempt and returns
a partial-effect result if a draft may remain. It must not silently retry an
ambiguous accepted send.

### Calendar and Teams contracts

Outlook keeps `calendarView` for a required start and end range because it
expands recurring events into occurrences and exceptions. It gains approved
primary-calendar create, partial update, and delete. Google Calendar keeps its
existing primary-calendar CRUD operations.

Calendar approval binds the event target, subject, times, timezone, attendees,
recurrence, body delta, and the provider-visible invitation, update, or
cancellation effect. Microsoft create uses the provider's transaction ID tied
to the Kestrel execution attempt. Updates stay partial and preserve any
provider-managed online-meeting block.

Teams separates its current overloaded operation into:

- list chats;
- list messages for one chat; and
- send a message to one existing chat.

The first two have distinct inputs and results. Both support continuation.
Sending remains an approved external write and returns the created Graph message
identity. Creating chats, message-specific threaded replies, channels, meetings,
and downloading SharePoint-backed files remain excluded.

### Opaque cursors and retry truth

Every collection operation accepts and returns a Kestrel cursor. The cursor is
an authenticated opaque envelope bound to the connection, provider, operation,
and original query. Its internal provider value may be a Gmail page token or
the full Graph next link. The model cannot turn it into an arbitrary URL or use
it with another account or operation. Hosted and Local Core own cursor sealing;
the shared provider client consumes only the decoded, validated provider value.

Provider outcomes remain truthful:

- Outlook send and reply return `accepted`, never `delivered`.
- Gmail send and reply return the provider message and thread identities.
- Teams send returns the created chat message identity.
- A timeout after an external write is an `outcome_unknown` state. Kestrel does
  not automatically repeat it and risk duplicates.
- Provider-supported idempotency, such as Outlook Calendar's transaction ID, is
  bound to the execution attempt.

### Authorization, pack eligibility, and health

An operation is eligible only when all of these are true:

1. The personal connection belongs to the current user.
2. The pack is selected on the connection.
3. The Project attaches that connection and enables the capability.
4. Environment and Project policy permit it.
5. Every operation-required OAuth scope is present in the actual grant.
6. Any data-specific execution admission, such as Gmail restricted-data model
   eligibility, is satisfied.

Microsoft Outlook expands from `Mail.Read Mail.Send Calendars.Read` to
`Mail.Read Mail.Send Mail.ReadWrite Calendars.ReadWrite`. Teams stays unchanged.
Google adds `gmail.readonly gmail.send` beside the existing Calendar scopes.
Google authorization stays on Better Auth's incremental flow. Both providers
persist selected packs and actual granted scopes.

Health is pack-aware. A connection can keep Calendar healthy while Gmail needs
consent, or keep existing Outlook reads while new write operations wait for a
scope upgrade. The connection's top-level status is an aggregate presentation,
not the only fact. Pack health records the last checked identity, granted-scope
set, check time, and normalized outcome without storing message content.

The normalized error contract distinguishes authorization expired or revoked,
incremental consent required, tenant approval required, authenticated but
forbidden, unavailable license or resource, throttled, provider unavailable,
invalid input, and outcome unknown. A Microsoft 403 is not automatically a
reconnect instruction.

### Approval and audit

Every external-write operation declares `ask` as its minimum in the shared
catalog. The hosted catalog and UI clamp to that minimum. The hosted provider
route still verifies and consumes the payload-bound approval as defense in
depth. Desktop derives the same write list for its local approval path.

Approval identity includes the connected account, Project, operation, provider
resource, exact content fields, provider target IDs, and attachment revisions.
One approval authorizes one attempt. A changed payload requires new approval.

Both hosts record attempted, succeeded, failed, partial-effect, or
outcome-unknown evidence. Audit records include operation, App, pack, connection
and Project identity, provider correlation or result IDs, approval identity,
timing, and normalized error class. They exclude message bodies, chat text,
calendar bodies, credentials, MIME, and attachment bytes.

### Desktop Project scoping

Desktop keeps one reusable personal account connection in Settings. Each
registered Project owns an explicit selection of installed App IDs. The main
process validates a run's requested selection against both the Project's saved
selection and the currently installed, enabled connection. It no longer
replaces the request with all globally enabled Apps.

A Project with no App selection receives no personal App tools. A thread with no
registered Project also receives none. Connection verification remains
available in Settings. This matches hosted Kestrel's explicit attachment model
without importing hosted tables or credentials into Local Core.

### Gmail restricted-data admission

Before Gmail consent, hosted Kestrel presents an in-context disclosure that
names the Gmail data used, the productivity purpose, the model processor or
processor class, retention and deletion behavior, and the prohibition on
generalized model training. The user can select Calendar without Gmail.

Gmail read tools are visible and executable only when the selected Environment
model route has explicit restricted-data eligibility. Unknown processor,
purpose, retention, training use, or deletion behavior fails closed. A fallback
model route must independently qualify; Gmail data cannot trigger a silent
fallback to an ineligible provider. The approval and policy owner is the
Environment model-admission boundary, while the Gmail operation contract
declares that the requirement exists.

The participant approved this policy boundary on 2026-08-27. Which configured
model routes qualify remains an evidence-based release decision.

This change does not infer sensitivity from message contents. All data obtained
through the restricted Gmail scope receives the same explicit treatment.

### Release evidence

Provider qualification is a retained, redacted evidence record, not a new
runtime control plane. For Outlook, Teams, Gmail, and Google Calendar it records
the provider account class, host, App registration, consent result, token
refresh, read operation, approved write operation, disconnect or revocation
behavior, normalized error evidence, package or deployment revision, and time.
No mailbox content or attachment bytes enter the record.

A capability is presented as complete only after its shared contract, hosted
adapter, Local Core adapter, packaged Desktop copy, mocked contract tests, and
live provider proof agree. This closes the current gap where focused mocked
tests are green but no live provider behavior is retained.

## Transition and Coexistence

Existing Google Calendar connections remain valid. Until their next successful
sync, a legacy Google connection with the known Calendar scopes is interpreted
as Calendar-only. Gmail is absent until the user selects the pack, sees the
restricted-data disclosure, and grants both Gmail scopes. Declining or failing
Gmail consent leaves Calendar usable.

Existing Microsoft connections keep operations authorized by their actual
granted scopes. The selected `outlook` pack alone does not expose Calendar
writes or staged attachment replies. Those operations appear after incremental
consent adds `Calendars.ReadWrite` and `Mail.ReadWrite`. A tenant-policy block is
shown as tenant approval required; it does not degrade existing reads into a
generic reconnect state. Teams chat reads remain available with `Chat.Read`, but
sending remains unavailable until a tenant administrator grants
`ChatMessage.Send`.

Persisted Project capabilities are added through the current generic App catalog
materialization. No provider-specific Gmail Project rows or special policy
tables are introduced. Existing saved `auto` policies for a newly classified
external write are projected to the operation's minimum `ask`; the route's
existing hard check remains until every caller derives correctly from the
catalog.

Desktop authorization remains reusable, but existing Projects do not inherit
all personal Apps. On the new Project-scoping contract, a Project without an
explicit App selection exposes none and asks the user to choose. This is a
deliberate fail-closed transition for mail and chat access.

The old host-specific operation definitions can coexist only while consumers
move to the `src/apps` catalogs. They are compatibility adapters, not new
authorities. The transition ends when hosted registry/profile generation,
hosted tools, Desktop standard connection metadata, Desktop tools, and both
provider services derive from the shared catalogs and the parity test asserts
the generated surfaces instead of comparing handwritten values.

## Decisions

### Keep the first-party Apps and separate hosts

The Microsoft 365 and Google Workspace Apps remain the product owners. Hosted
and Local Core keep separate credential and persistence adapters. Confidence is
high because this follows current security boundaries and executing paths.
Reopen only if Desktop is intentionally changed to require hosted execution.

### Use `src/apps` as the native operation contract

The protocol manifest remains product metadata; `src/apps` becomes the one
runtime semantic contract. Confidence is high because the modules already own
operations and service ports. Reopen if a future package boundary prevents the
web build from consuming these modules without pulling Local Core-only code.

### Keep provider-specific model tools

Outlook and Gmail share internal vocabulary and result contracts but remain
separate tools. Confidence is high. A generic provider-switching mail tool would
hide provider query syntax, reply semantics, outcome truth, and account
eligibility.

### Reuse Thread files for attachments

Inbound mail attachments are imported lazily; outbound attachments are resolved
from the current Thread and rebound after approval. Confidence is high because
both hosts already enforce Thread ownership and file integrity. Reopen only if
mail attachments must exist independently of a Thread.

### Make Project selection authoritative in Desktop

Connection configuration stays global, while tool exposure is explicit per
Project. Missing selection means no personal Apps. Confidence is high because
it matches the stated Project-scoping requirement and hosted policy model.

### Treat Gmail restricted data as an explicit model-admission policy

All Gmail restricted-scope data requires an eligible model route and in-context
disclosure. Confidence is high that the boundary is required and medium on which
configured model routes can qualify. The participant approved this policy on
2026-08-27.

### Keep consumer Outlook.com outside this change

The current `organizations` authority and Teams scope make work or school
accounts the coherent combined Microsoft identity. Confidence is high. Reopen
when consumer Outlook is a distinct product requirement with tested pack-level
account compatibility.

### Do not invent common limits or heuristics

Provider paging stays opaque, provider search syntax stays provider-native, and
attachment limits follow the existing Thread bound plus provider/account rules.
Confidence is high. Any future ranking, query translation, common size cap, or
fallback policy must be surfaced and approved separately.

## Research and Prototype Findings

No application prototype was needed. Code tracing showed an existing shared
operation/service-port seam, and current provider documentation settled the
scope, authorization, attachment, pagination, and outcome contracts.

One dependency check materially increased confidence: the installed Better Auth
Google provider already adds `include_granted_scopes=true`, while Kestrel's link
route already accepts additional scopes. The hosted Google change can therefore
extend the existing flow instead of replacing it.

The one provider behavior that documentation did not settle is bounded Outlook
conversation assembly using `conversationId`. A disposable live-account probe
should decide whether the Outlook surface includes a complete conversation read
or only full-message read with preserved conversation identity. This does not
change the chosen application seam.

## Remaining Design Questions

- Which configured model routes can supply the processor, purpose, retention,
  training-use, and deletion evidence required for Gmail restricted-data
  eligibility? This determines where Gmail read tools can run, not how the App
  is structured.
- Which OAuth verification and recurring security-assessment tier will Google
  assign to Kestrel's actual Cloud project and data flow? Google's review, not
  repository analysis, resolves this production-admission question.
- Does a live Microsoft mailbox support the intended bounded
  `conversationId` retrieval reliably? One redacted live probe resolves the
  exact Outlook read operation.
- Which qualification tenants restrict user consent for the Outlook and Teams
  read scopes? `ChatMessage.Send` always requires tenant-admin consent; live
  tenant policy determines the remaining observed paths.

These questions block claims of production availability in the affected
configuration. They do not require a different contract seam, identity model,
attachment system, or Project policy design.
