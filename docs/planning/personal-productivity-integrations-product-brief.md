# Personal Productivity Integrations Product Brief

## Product Narrative

Kestrel One users need to use their own Gmail, Google Calendar, Outlook Mail and Calendar, and Microsoft Teams accounts from an authorized Project. A Platform Admin must first register Kestrel One's Google and Microsoft applications, choose the supported capability packs, and maintain those registrations without provider-specific environment variables.

Kestrel One uses Better Auth for Kestrel sign-in, identity, and sessions. Its provider registrations, personal grants, token refresh, and provider calls are owned by the hosted integration broker and Platform settings. Desktop has separate local provider OAuth paths. This brief completes the Kestrel One product only.

The defining loop is simple: a Platform Admin enables a narrow provider capability; a person consents to their own external account; the person attaches that connection to a Project; Kestrel One reads or performs an approved external action within the resulting limits. The product must show a useful recovery state when consent, tenant approval, scope, policy, or provider access prevents an operation.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- A Platform Admin can configure, test, rotate, enable, and disable Kestrel One's Google Workspace and Microsoft 365 OAuth registrations under Platform.
- Platform settings are the authority for provider client IDs, hosted secrets, enabled packs, derived scopes, redirect URIs, and registration revision. No provider-specific environment variable is an authority after cutover.
- A user can connect their own Google account for Gmail, Google Calendar, or both, and their work or school Microsoft account for Outlook, Teams, or both.
- An authorized Project can use Gmail search, message and thread reads, attachment import, approved send and reply; Google Calendar CRUD with paging; Outlook mail and calendar reads with approved mail sends; and Teams chat reads and approved sends.
- Kestrel One evaluates Platform, Organization, Project, individual authorization, model-admission, and per-action approval rules in that order. Later layers can narrow earlier layers but cannot expand them.
- Kestrel One stores provider tokens and uses them for refresh and provider calls. The user sees redacted connection and health state. Audit evidence contains no communication content or credentials.

This initiative excludes:

- SharePoint, OneDrive, Google Drive, Google Chat, consumer Microsoft accounts, shared mailboxes, service accounts, and organization-owned senders;
- Teams channels, chat creation, channel replies, and message-specific chat replies;
- Gmail labels, archive, delete, mailbox rules, mailbox administration, and user-facing drafts;
- generic provider-neutral mail tools, query rewriting, automatic result ranking, guessed provider limits, and silent model fallback;
- inbound email triggers, which remain owned by the Organization Email App; and
- Desktop code, Desktop provider OAuth, and Desktop-to-Kestrel One connection. That is a follow-on initiative after this Kestrel One work.

## Defining Scenarios

### Configure a Platform registration

A Platform Admin opens Platform Integrations and configures Google Workspace or Microsoft 365. The page derives the callback URI and exact scopes from the selected capability packs. The admin saves the hosted client ID and secret, tenant setting when required, and enabled state.

Kestrel One stores the secret encrypted, returns only redacted readiness, and records the administrative action. A disabled registration cannot start or refresh a personal connection. A rotation or scope reduction invalidates an affected broker authorization. Adding a pack never expands an existing user's grant.

### Connect a personal account

A signed-in Kestrel One user selects Gmail, Calendar, both, Outlook, Teams, or both Microsoft packs. Kestrel One uses the user's Better Auth Kestrel session as the caller identity. Its integration service checks the active Platform registration and Organization App policy, derives the selected pack scopes, and completes provider consent.

Kestrel One verifies the provider account, records actual granted scopes, and stores the encrypted token set on the person's Organization-scoped personal connection. The connection can be attached to an eligible Project. Connecting the same provider account in a second Organization requires an explicit second connection; Kestrel One does not silently share a person's provider token across Organizations.

### Read personal work context

From a Project with an eligible connection, Kestrel One lists Teams chats, reads chat history, searches Gmail, reads a Gmail message or thread, imports one selected attachment into the current Thread, lists Google Calendar resources and events, and reads Outlook mail and calendar context. Reads require the active registration, selected pack, Project access, actual granted scopes, and any required Gmail restricted-data model admission. They do not require per-call approval.

Gmail queries pass to Gmail without Kestrel rewriting or ranking them. Ordinary mail results contain provider-grounded metadata and content allowed by the operation contract. Attachment bytes enter Kestrel only through explicit Thread-file import. A provider continuation remains an authenticated Kestrel cursor, not a URL that a model can fetch.

### Perform an external write

A user asks Kestrel One to send or reply to Gmail, send Outlook mail, send a Teams chat message, or create, update, or delete a Google Calendar event. Kestrel One creates an approval request for the exact account, Project, provider target, content, recipients or attendees, time and recurrence when relevant, and ordered attachment revisions.

No provider write occurs before approval. A changed target, content field, or attachment requires a new approval. Immediately before upload, Kestrel One resolves every Thread file again and verifies its identity and content hash. Gmail replies derive thread identity, headers, recipients, and subject continuity from the provider target rather than model-provided values.

Kestrel One reports the provider outcome. It records a created identity, partial effect, or unknown outcome without automatically retrying an ambiguous write.

### Recover from an incomplete connection

When a connection or operation cannot proceed, Kestrel One distinguishes missing incremental consent, Microsoft tenant approval, revoked authorization, missing scope, forbidden or unavailable resource, throttling, provider failure, invalid input, partial effect, and unknown write outcome. A failed Gmail upgrade must not break Calendar. Missing Microsoft send consent must not make existing Outlook mail or Teams reads appear disconnected.

The user sees a specific recovery action. Support sees metadata-only evidence: App, pack, connection, Project, operation, approval identity, provider correlation identity, time, and normalized result. Support does not see tokens, message bodies, chat text, Calendar bodies, MIME, or attachment bytes.

## Business and Process Requirements

### Ownership and policy

- A Platform Admin owns Kestrel One provider registration configuration and may view redacted readiness, change enabled packs, rotate secrets, or disable a registration.
- An Organization decides whether an App is offered and which Platform-approved packs it permits.
- A Project decides which eligible personal connection and capabilities it may use.
- An individual owns the provider account consent and must explicitly connect it for the Organization.
- A Kestrel user ID identifies the person in Kestrel One. It is not a provider account ID, OAuth client ID, client secret, or provider grant.
- The person's Kestrel sign-in credential is never sent to Google or Microsoft.

### Capability and consent process

- Gmail and Calendar must be independently selectable. An unselected pack requests no pack scopes and exposes no pack operations.
- Microsoft work exposes Outlook Mail and Calendar using `Mail.Read`, `Mail.Send`, and `Calendars.Read`, plus Teams using `Chat.Read` and `ChatMessage.Send`; it must not widen to `Mail.ReadWrite` or `Chat.ReadWrite`.
- Gmail uses `gmail.readonly` and `gmail.send`; it must not request modify, compose, or full-mail scopes.
- Kestrel One records actual granted scopes. A selected pack does not prove every operation is eligible.
- The Platform UI derives provider scopes from source-controlled capability descriptors. It accepts no free-form provider scopes.
- Removing a pack or Project attachment removes its effective operations without disconnecting unrelated packs.
- Disconnecting a personal connection removes effective Project access and stops new provider calls.

### Read, write, and recovery controls

- Reads require all relevant eligibility checks but no per-call approval.
- Every external write requires an exact, payload-bound approval and authorizes one attempt only.
- Calendar approval states whether attendees will receive communication.
- Kestrel One must not retry a write whose provider outcome is unknown.
- Kestrel One reports provider truth rather than claiming a message or event was created without evidence.
- Connection health is recorded by pack or operation class, not only as one connection status.

## Technology Requirements

### Kestrel One identity and integration responsibilities

- Better Auth remains Kestrel One's identity and session authority.
- The Kestrel One integration service reads Platform registration data at provider connection, callback, and refresh time. Static Better Auth provider environment configuration cannot remain the source of authority.
- Platform registration records are global and keyed by provider. They contain client ID, encrypted hosted secret, enabled packs, tenant or issuer setting when needed, enabled state, revision, timestamps, and redacted readiness.
- Kestrel One creates short-lived, single-use authorization sessions bound to the Kestrel user, Organization, personal connection target, registration revision, chosen packs, PKCE verifier, and fixed return target.
- A registration secret, authorization code, PKCE verifier, access token, or refresh token must never appear in a response, browser state, approval record, audit event, model input, or model output.

### Personal authorization and Project access

- `app_connections` remains the Organization-scoped, personal connection and Project-use boundary.
- A one-to-one personal OAuth authorization record stores provider account identity, granted scopes, encrypted token payload, expiry, registration revision, and reconnect status for that connection.
- Environment-scoped `app_credentials` must not store Platform registration secrets or personal provider tokens.
- One service resolves hosted provider access tokens. It checks registration enabled state and revision, selected pack, granted scope, user ownership, Organization and Project policy, and required model admission before refresh or use.
- Rotation, client-identity change, tenant change, or scope reduction invalidates affected hosted authorizations and requires reconnection.

### Canonical operation and data contracts

- Stable App manifests retain App identity and user-visible pack metadata.
- `src/apps/googleWorkspace.ts` and `src/apps/microsoft365.ts` remain the source of truth for in-scope operation identity, packs, scopes, parsers, result contracts, side effects, minimum approval, safe audit identity, and provider-client methods.
- Gmail supports search, full message read, native thread read, attachment metadata, explicit attachment import, approved send, and approved reply.
- Google Calendar retains primary-calendar CRUD and uses authenticated continuation cursors for collection paging.
- Outlook supports mail and calendar reads plus approved mail sends. Teams supports list chats, list chat messages, and approved send into an existing chat. It does not create chats.
- Provider clients own request shaping, pagination, response normalization, provider error mapping, and ambiguous-write classification.
- A provider continuation never becomes an arbitrary model-fetchable URL.
- Outbound files come from ready Thread files and are resolved and hash-checked after approval. Imported files follow existing Thread-file access, quarantine, retention, deletion, and model-file behavior.

### Security, reliability, and operations

- Gmail reads require an explicit restricted-data eligibility decision for the selected model route. Every possible fallback route must qualify independently; Kestrel One fails closed otherwise.
- Hosted Gmail consent presents the approved data-use disclosure, including purpose, processor or processor class, retention, deletion, and the prohibition on generalized model training.
- A public hosted Gmail release satisfies Google's applicable OAuth verification and security-assessment requirements for the actual data path.
- Audit records attempted, succeeded, failed, partial-effect, and outcome-unknown provider operations, while excluding communication content and credentials.
- Live qualification covers connection, consent, token refresh, read, approved write, disconnect or revocation, and normalized error behavior. Evidence identifies account class, Kestrel One deployment revision, Platform registration revision, and time without communication content.
- The cutover uses a newly initialized database. Kestrel One does not import provider tokens from Better Auth account rows into the encrypted authorization store and carries no legacy connection migration path.

## People and Operating Requirements

### Personal account owner

- Selects packs, reviews consent, connects the provider account, attaches the connection to Projects, and approves external writes.
- Can see connected provider identity, pack health, missing consent, tenant approval, and the recovery action.
- Can remove a pack or disconnect without removing unrelated provider access.

### Platform, Organization, and Project administrators

- The Platform Admin configures and maintains provider registrations and has no access to a user's provider tokens or content.
- The Organization administrator manages the App policy within the Platform ceiling.
- The Project administrator manages eligible connection and capability access for that Project.
- Administrators do not gain provider communication content through health or audit views.

### Tenant, security, support, and release owners

- A Microsoft tenant administrator grants any required consent for Teams send and may restrict delegated user consent. Kestrel One reports that state without treating the account as revoked.
- The security owner maintains Gmail restricted-data posture, disclosure, privacy and deletion information, processor evidence, and provider-verification obligations.
- Support uses normalized, metadata-only evidence to diagnose consent, policy, authorization, resource, throttling, provider, partial-effect, and unknown-outcome failures.
- The release owner retains redacted live qualification evidence for every in-scope Kestrel One capability. Mocked or one-path evidence is insufficient.

## Success and Readiness

### Observable success

- A Platform Admin can configure and rotate Google and Microsoft Kestrel One registrations without provider-specific environment variables becoming authoritative.
- A user can independently connect Gmail, Calendar, Outlook, and Teams within Platform, Organization, and Project limits.
- Gmail, Calendar, Outlook, and Teams reads and approved writes obey the same eligibility, approval, audit, and recovery rules across Kestrel One.
- Rotating, disabling, or narrowing a Platform registration stops affected hosted connections until the user reconnects.
- Live provider evidence proves every in-scope Kestrel One connection, refresh, read, approved write, revocation or disconnect, and failure path.
- SharePoint and Desktop remain outside this release claim.

### Readiness

**Ready for issue creation.** The Kestrel One requirements, ownership, operating responsibilities, and delivery boundary are settled. Desktop-to-Kestrel One connection is explicitly outside this brief and requires its own design and Product Brief after Kestrel One integration completion.

## Source Artifacts

- [Platform OAuth registrations change design](../design/platform-oauth-registrations-change-design.md)
- [Platform OAuth registrations design notebook](../../.design/platform-oauth-registrations/notebook.md)
