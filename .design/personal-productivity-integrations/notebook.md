# Personal Productivity Integrations Design Notebook

> Delivery scope update, 2026-08-27: Outlook Mail and Outlook Calendar are
> deferred. The current issue set must cover Teams, Gmail, Google Calendar, and
> shared governance while preserving existing Outlook behavior unchanged.

## Current Position

Extend the existing first-party Microsoft 365 and Google Workspace App owners.
Do not add a second connector framework or collapse provider-specific behavior
into a generic mail abstraction. Shared Kestrel responsibilities should stay
shared: capability policy, Project attachment, approvals, audit, health, tool
registration, and hosted/Desktop presentation. Provider contracts and adapters
should remain explicit.

The current build already proves personal delegated OAuth and narrow provider
calls. The proposed change completes useful Outlook Mail and Calendar behavior,
hardens the existing Teams chat loop, adds Gmail as a new Google Workspace pack,
and closes hosted/Desktop governance gaps. Google Calendar remains the existing
calendar pack and gains parity corrections only.

## Requested Change

A user connects a work or school Microsoft 365 account and selects Outlook or
Teams capabilities. The user can search and read Outlook mail, send or reply
with attachments after approval, manage the primary Outlook calendar, and read
or send messages in an existing Teams chat.

A user connects a Google account and selects Gmail or Calendar capabilities.
The user can search and read Gmail, send or reply with attachments after
approval, and use the existing primary Google Calendar operations.

Every capability is personal, Project-scoped, available in hosted Kestrel and
Desktop, health-visible, audited, and verified against a real provider account.

The change excludes shared identities, consumer Outlook.com accounts,
SharePoint, Google Drive, Google Chat, Teams channels, drafts, labels, archive,
delete, mailbox rules, and mailbox administration.

## Starting Sources

- Participant decisions in this thread: focus on Outlook, Teams, Gmail, and
  existing Google Calendar; deliver personal connections first.
- Current-state discovery completed on 2026-08-27 across hosted, Desktop,
  contracts, tests, documentation, and history.
- `AGENTS.md`: repair the surface that owns the contract, prefer existing
  model-visible contracts, validate boundary input, and do not add unapproved
  heuristics.
- `docs/plans/2026-07-17-provider-capability-delivery.md`: provider capability
  exit criteria and older Teams intent.
- `apps/web/lib/integrations/`, `src/localCore/`, `src/apps/`,
  `tools/kestrelOne/`, `tools/microsoft365/`, `tools/googleWorkspace/`, and
  `packages/protocol/src/apps.ts`: current first-party App implementation.
- `docs/design/email-triggered-agent-runs-change-design.md`: adjacent inbound
  email design. It owns email-triggered execution and does not own personal
  mailbox access.

## Relevant Current Behavior

Hosted Microsoft 365 uses selected Outlook, Teams, and SharePoint packs,
personal delegated OAuth, Project attachment, Environment capability grants,
runtime policy, payload-bound approval, and Microsoft Graph adapters. Outlook
only lists recent previews, sends new plain-text mail, and lists calendar
events. Teams lists chats or messages for one chat ID and sends a new plain-text
message to an existing chat.

Desktop Microsoft 365 uses the same pack names and tool concepts through native
Local Core OAuth and service ports. It does not use the hosted Project
attachment boundary. Enabled connections are currently global to Desktop runs.

Hosted Google Workspace is Calendar-only. It supports primary-calendar CRUD,
Project attachment, approval, and opt-in teammate free/busy. Desktop supports
primary-calendar CRUD but not the hosted free/busy path. Gmail has no pack,
scope, tool, policy, route, adapter, or test.

The provider routes force approval for Microsoft sends and Google Calendar
mutations. The App catalog does not declare the same minimum. A user can select
Automatic, after which the runtime omits the approval and the provider route
rejects the call. The configuration is safe but broken.

Focused mocked suites passed on 2026-08-27. No live Outlook, Teams, Gmail, or
Google Calendar canary or retained manual proof was found.

## Affected Surface

- Product protocol: Google Workspace gains a Gmail pack; Outlook, Teams, and
  Calendar descriptions must match actual operations.
- Canonical provider contracts: capability names, model inputs, normalized
  results, continuation tokens, write classification, scopes, and pack checks.
- Hosted Apps: install/connect UI, personal OAuth, Project attachment,
  capability grants, tool profile, provider routes, health, audit, and approval.
- Desktop: Apps UI, selected packs, OAuth, Local Core services, tool registry,
  Project selection, credential health, runtime evidence, and packaged source
  copies.
- Persisted App state: selected pack metadata, personal connection resources,
  Project capability materialization, and health evidence. Existing connection
  rows should remain valid when packs expand.
- External providers: Microsoft identity platform and Graph; Google OAuth,
  Gmail API, and Calendar API.
- Adjacent Email App: unchanged. Organization-owned Resend sending and inbound
  triggers remain separate from personal Outlook and Gmail authority.

## External Research

Microsoft Graph supports the requested Outlook behavior with delegated
`Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, and `Calendars.ReadWrite`. The
existing Teams scopes, `Chat.Read` and `ChatMessage.Send`, are sufficient and
should not be widened. `ChatMessage.Send` requires tenant-admin consent. Teams
chat APIs do not support consumer Microsoft accounts, so this change remains
work-or-school-account only. Outlook send and reply return provider acceptance,
not delivery proof. Outlook IDs must use the immutable-ID request preference
whenever they cross calls, approval, audit, or persistence. Graph continuation
links must remain opaque.

Gmail needs `gmail.readonly` and `gmail.send`. Search, full message and thread
read, attachment retrieval, send, and reply are supported. Reply uses normal
Gmail send with a provider thread ID and server-derived RFC message headers;
the model must not construct those headers. Google Calendar's existing scopes
remain sufficient for its current primary-calendar behavior.

Better Auth 1.6.23 already sends `include_granted_scopes=true` for Google and
the hosted link route can request additional scopes. Kestrel still needs to
persist selected Google packs and actual granted scopes, then expose each
operation only when its pack and every required scope are present.

`gmail.readonly` is a restricted scope. Public hosted release therefore needs
OAuth verification and likely an annual security assessment for the hosted and
model data flow. Google permits productivity and generative summaries, but
requires an in-context data-use disclosure, limited use, protected tokens,
deletion help, and no transfer for generalized model training. Gmail read tools
must fail closed when Kestrel cannot establish an eligible model processor and
documented data-use posture.

Provider attachment limits differ and can be account-configured. Kestrel will
not invent a shared size threshold. It will keep the existing Thread-file
bounds, apply the documented provider path and current provider/account limit,
and return a typed provider rejection when the final message is not accepted.

## Candidate Seams and Options

### Option A: extend each existing hosted and Desktop implementation separately

This has low initial movement but preserves duplicated contracts and allows
scope, validation, approval, and result behavior to drift. Current Google
Calendar hosted/Desktop differences show that risk.

### Option B: make shared provider contracts canonical and keep two execution adapters

The stable product manifest continues to own App IDs and user-facing pack
names. The existing `src/apps` provider modules become the authoritative native
operation contract. They own packs, scopes, operations, parsers, normalized
results, write classification, resource selection, tool names, and error
classes. A shared provider client owns endpoint construction and response
normalization. Hosted and Local Core remain separate authorization, approval,
audit, health, and storage adapters. This preserves security boundaries while
removing the duplicated semantics that caused current drift. This is the
chosen seam.

### Option C: route Desktop provider calls through hosted Kestrel

This would create one provider adapter but would move personal Desktop
credentials or calls across the hosted boundary, require hosted availability,
and change offline behavior. It conflicts with the current Local Core security
model and is not preferred.

## Proposed Delta

- Add Gmail as a selectable Google Workspace pack beside Calendar.
- Expand Outlook Mail to explicit search, message or conversation read, send,
  reply, attachment metadata/read, and approved attachment send.
- Add the corresponding Gmail operations with provider-specific semantics and
  one common Kestrel result vocabulary where the providers genuinely align.
- Expand Outlook Calendar to primary-calendar create, update, and delete.
- Keep Teams to existing personal and group chats. Separate list chats, read
  chat history, and send chat message operations. Add continuation support.
- Make continuation tokens opaque and provider-issued. Never infer or rank
  messages or chats with Kestrel heuristics. Do not expose provider continuation
  URLs as fetchable model input.
- Make `ask` the canonical minimum for every external write.
- Keep personal connection resources account-level. Bind approvals to the
  exact message, reply, attachment set, event mutation, or chat payload.
- Reuse existing hosted Project attachment and capability materialization.
  Add a real Project-level selection owner for Desktop instead of enabling all
  connected Apps in every run.
- Normalize provider output before it reaches the model. Preserve opaque
  provider IDs required for a later read, reply, attachment, or continuation.
- Return attachment metadata with a message. Import attachment bytes only on an
  explicit operation through the existing Thread-file boundary. Outbound send
  and reply accept ready Thread file IDs and revalidate their identity after
  approval before uploading exact bytes.
- Keep provider-specific tools. Share their operation vocabulary and result
  contracts internally instead of adding a provider-switching generic mail
  tool.
- Require both a selected pack and all operation scopes before a tool is
  eligible. Represent reconnect, consent upgrade, tenant approval, forbidden
  resource, throttling, and provider failure as different states.
- Treat Microsoft mail sends and replies as `accepted`, not delivered. Return
  the created Teams message identity. Bind Calendar approvals to attendee,
  invitation, update, and cancellation effects.
- Record successful and failed attempts with metadata-only audit evidence.
  Update connection health on successful probes and provider authorization
  failures.
- Admit Gmail read data to model execution only through an explicitly eligible
  model route with disclosed processor, purpose, retention, training-use, and
  deletion behavior. This is a typed policy decision, not provider-name or
  content-based classification.

## Domain Model

- **Personal App connection:** one user-owned delegated provider account. It is
  not an Organization sender, shared mailbox, service identity, or trigger.
- **Capability pack:** a user-selected service within a provider connection,
  such as Outlook, Teams, Gmail, or Calendar. A pack determines requested
  scopes and eligible capabilities.
- **Project attachment:** permission for one Project to use selected
  capabilities from one personal App connection.
- **Mail conversation:** the provider-supported grouping used to read context
  and target a reply. Microsoft and Gmail identifiers remain provider-specific.
- **Chat:** an existing Teams personal or group conversation. Sending into the
  chat counts as replying to the chat. Message-specific threaded reply and
  Teams channels are outside this change.
- **External write:** any operation that sends provider-visible content or
  mutates provider state. Every external write requires approval.
- **Continuation token:** an opaque provider-issued cursor. Kestrel validates
  its binding and intended operation but does not interpret or reconstruct it.
- **Restricted-data eligibility:** an explicit model-route policy stating that
  Gmail restricted-scope data may be processed under the disclosed purpose and
  data-use terms. Absence means Gmail read tools are unavailable.

Invariants:

- A personal connection may be used only by its owning user.
- A Project cannot widen the Organization or Environment grant.
- An unselected pack exposes no tools and requests no scopes.
- Every external write consumes one approval bound to its exact payload.
- Provider credentials never enter model-visible input, output, or audit data.
- Provider IDs are opaque and may be used only with the connection that issued
  them.
- Imported mail attachments become Thread files and follow the Thread's access,
  retention, quarantine, and deletion behavior.
- Mail and Calendar operations target the connected user's account and primary
  calendar unless the capability explicitly says otherwise.
- Existing Calendar-only Google connections remain valid without granting
  Gmail access.
- Existing Outlook read grants remain valid until the user opts into new write
  capabilities that require additional consent.

## Transition States

- Existing Google Calendar connection: connected with Calendar only; no Gmail
  tools or scopes appear.
- Google connection upgrade: user selects Gmail, completes incremental consent,
  and retains Calendar access. Failed Gmail consent leaves Calendar usable.
- Existing Outlook connection: operations covered by current granted scopes
  remain available. Calendar writes and structured attachment replies remain
  unavailable until incremental consent adds their required scopes.
- Capability removal: deselecting a pack removes its Project capabilities and
  tools without disconnecting the remaining packs.
- Hosted/Desktop parity transition: a capability is not release-complete until
  both execution adapters and package copies implement the canonical contract.
- Existing Desktop connection: account authorization remains global and
  reusable, but a run receives only the Apps selected by its owning Project. A
  Project without an explicit selection receives no personal App tools; it does
  not inherit the current globally enabled set.

## Decisions

- Personal user-owned connections are the only identity model in this change.
  Confidence: high. Reopen only if the participant expands scope.
- SharePoint, Drive, Google Chat, Teams channels, and shared identities are
  excluded. Confidence: high.
- Existing first-party App ownership remains the integration seam. Confidence:
  high.
- Hosted and Local Core keep separate credential and execution adapters.
  Confidence: high.
- Provider-issued paging remains opaque. Confidence: high.
- Sending into an existing Teams chat satisfies reply behavior for this scope.
  Confidence: medium. Reopen if message-specific reply provenance is required.
- Provider-specific tools remain model-visible; shared contracts remain an
  internal implementation seam. Confidence: high.
- Mail attachments cross the existing Thread-file boundary. Confidence: high.
- Gmail restricted-scope data requires explicit model-route eligibility and
  in-context disclosure. Confidence: high on the boundary; medium on which
  configured providers will qualify. The participant approved this policy on
  2026-08-27.
- The Google connection flow keeps Better Auth and adds pack/scope persistence;
  it does not need a second hosted OAuth manager. Confidence: high.

## Research and Prototypes

No application prototype was needed. Code inspection and primary provider
research resolved the contract seam. One disposable live Microsoft mailbox
probe remains to test whether bounded `conversationId` retrieval is reliable;
its result changes only the exact Outlook read operation.

## Active Change Frontier

- Which configured model routes can provide the evidence required for Gmail
  restricted-data eligibility?
- Does a live Microsoft mailbox support the intended bounded conversation read
  using `conversationId`, or must Outlook expose message-context reads without a
  thread operation?
- Which Google OAuth verification and security-assessment tier will the Cloud
  project receive for Kestrel's hosted/model data flow?
- Which tenant policies restrict user consent for Outlook and Teams read scopes
  in the qualification accounts? Teams send is already known to require
  tenant-admin consent.

## Decision Map

- Status: not needed
- Path: none
- Destination: none
- Return condition: the compact frontier can be resolved in this design session

## Best Next Move

Publish the change design with the chosen shared-contract seam. Keep the four
external admission questions as explicit release questions rather than letting
them reopen the application structure.
