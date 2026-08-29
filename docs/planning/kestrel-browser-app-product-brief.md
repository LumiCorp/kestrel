# Kestrel Browser App Product Brief

## Product Narrative

Kestrel agents need to use a browser for two kinds of work. They need to test
applications created through Kestrel, and they need to operate public websites
for a person. Desktop must support local application testing. Kestrel One must
support published Kestrel Edge previews and public websites.

Kestrel does not currently own a first-party browser boundary. Exposing a
browser engine through raw MCP would give the model engine-specific controls
that bypass Kestrel's normal policy, Thread isolation, human interaction, and
artifact behavior. It would also make the model contract change when the engine
changes.

Kestrel must provide a first-party `built_in.browser` App. Agents receive a
small, stable `browser.*` tool surface. A replaceable browser engine performs
the work behind a Kestrel-owned service. Desktop and Kestrel One use the same
tools, policy rules, results, and failures even though they host the browser
differently.

The defining experience is direct. A person allows a new public domain once.
Kestrel remembers that domain for the person across the Environment and adds it
to the active session immediately. Future browser sessions can operate on that
domain without asking again. Projects may narrow the Environment-level access.
Navigation, clicks, typing, and screenshots inside the effective allowlist do
not create approval prompts.

Passwords, single-use codes, passkeys, SSO, and MFA remain human actions. The
person can take exclusive control of the live browser, authenticate directly,
and return control to the agent without placing authentication input in a tool
call, transcript, trace, or durable log.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- Kestrel Desktop and hosted Kestrel One expose the same first-party Browser
  App and stable browser tool contract.
- Desktop agents can test an exact localhost application and port associated
  with their Project.
- Kestrel One agents can test owned published Kestrel Edge previews.
- Agents can operate public HTTPS websites within the effective Browser App
  allowlist.
- A person can approve and remember a new tenant-bounded domain once through
  `browser.request_grant`.
- An approved remembered domain applies immediately and appears automatically
  in the person's future Browser App sessions in that Environment.
- A domain already on the effective allowlist never creates another approval
  prompt, including when it is new to the current Thread or session.
- Project policy can narrow Environment and personal browser access but cannot
  expand it.
- A person can view the live browser, take exclusive control for
  authentication, and return control to the agent.
- Screenshots and approved downloads become ordinary Thread-authorized
  artifacts. Uploads can use only an explicitly selected Thread attachment.
- Browser engine loss ends the session without restoring authentication or
  retrying an action with an uncertain outcome.
- The browser engine and Chrome version remain pinned, verified, and
  replaceable implementation details.

The delivery boundary includes the shared App manifest and tools, Browser App
policy, personal remembered domains, minimal browser session persistence,
Desktop browser hosting, hosted browser workers, live viewers, network
containment, takeover, Thread file transfer, artifacts, result shaping,
observability, packaging, and validation.

This initiative does not:

- Expose raw agent-browser MCP, Chrome DevTools Protocol, JavaScript evaluation,
  arbitrary selectors, cookies, storage, clipboard, browser flags, extensions,
  or host filesystem paths to the model.
- Add a browser-specific action ledger, approval engine, evidence system, or
  replay system when existing Kestrel tool contracts own that responsibility.
- Persist or restore cookies, local storage, credentials, human takeover input,
  live viewer frames, or reusable browser profiles.
- Support unpublished Workspace-local ports from hosted Kestrel One.
- Add native Browser App takeover to Kestrel One Mobile in v1.
- Let a remembered domain override an Environment or Project restriction.
- Infer new permissions from a redirect, DNS result, subresource, page content,
  or prior successful visit.
- Install or upgrade browser binaries at runtime.

## Defining Scenarios

### Test a Desktop localhost application

An agent opens the Browser App in QA mode for a Project-owned localhost target.
Kestrel resolves the exact loopback host and port from trusted Project runtime
state. It starts one isolated browser process for the Thread and allows that
exact target automatically.

The agent navigates, inspects the accessibility snapshot, interacts with the
application, reads console or page errors, and captures a screenshot. These
actions do not ask for approval. Kestrel records normal tool results and Thread
artifacts. Closing or expiring the session destroys the temporary profile.

### Test a published Kestrel Edge preview

An agent opens an owned published preview in Kestrel One QA mode. Kestrel
resolves the preview and its tenant boundary from trusted preview records. The
owned preview is available without a personal domain prompt.

The hosted browser worker can operate the preview within the effective
allowlist. If the preview requests another destination that is not allowed,
Kestrel blocks the request and reports the destination without expanding
authority.

### Operate a remembered public domain

An agent opens an operator session for a public destination that already
matches the person's effective Browser App allowlist. Kestrel starts or returns
the Thread's browser session. The agent can navigate, inspect, click, type,
submit forms, switch tabs, and capture screenshots without an approval card.

The allowlist is the operating authority. Kestrel does not ask again because
the destination is new to the Thread, because the agent performs another
interaction, or because the site opens another allowed destination.

### Allow and remember a new domain

The agent needs a public destination outside the person's current allowlist. It
calls `browser.request_grant` with the destination. Kestrel normalizes the URL
and derives one tenant-bounded wildcard using the Public Suffix List, including
private suffixes.

If the derived domain is already effective, the tool returns `already_allowed`
without an approval interaction. If policy permits a personal grant, Kestrel
shows one allow-and-remember decision. Approval persists the domain for the
person in that Environment and updates the active session before the agent
continues. A later Thread or Project in the same Environment uses the remembered
domain automatically unless Project policy narrows it.

If Environment or Project policy forbids the destination, Kestrel blocks the
request. Personal approval cannot expand that policy ceiling. A denied request
does not create or change a remembered domain.

### Revoke a remembered domain

A person opens Browser App settings and removes a remembered domain. Kestrel
records a new allowlist revision. New browser actions must use the current
effective policy. A session must not retain access after it observes the newer
revision.

Revocation does not delete past Thread results or authorized artifacts. It
prevents new network requests to the removed destination.

### Authenticate through human takeover

The agent reaches a password, SSO, passkey, or MFA step and requests takeover.
The signed-in person receives exclusive input control in the live viewer.
Kestrel rejects agent actions while human control is active.

Authentication input travels directly from the viewer to the browser. Kestrel
does not place it in model context, a tool call, a transcript field, an audit
value, or a durable trace. The person explicitly returns control. The agent
continues in the same browser session and effective allowlist.

Viewer disconnection releases the live input connection but does not silently
return control to the agent. The session remains in human-control state until
the person returns control, closes it, or it expires.

### Upload and download a file

An agent can upload only an explicitly named attachment already authorized for
the Thread. The upload requires approval and one-time file access. The browser
never receives a Workspace or host filesystem mount.

A browser download is intercepted and held in bounded quarantine. The agent can
request promotion into a Thread artifact. Promotion requires approval. A denied
or expired download is destroyed and never appears as a Thread artifact.

### The engine crashes or an action times out

If the browser process or hosted worker exits, Kestrel marks the Browser Session
lost and destroys the remaining execution environment. It does not restore the
profile or reconstruct authentication.

If navigation or interaction times out after dispatch, Kestrel records an
unknown action outcome and does not retry automatically. A duplicate delivery
returns the existing exact result when Kestrel has a completed result.

## Business and Process Requirements

### App availability and policy

- The Browser App must ship installed but disabled.
- An Environment administrator must explicitly enable the Browser App.
- Environment policy must set the maximum Browser App capability.
- Project policy may narrow Browser App access and remembered domains but must
  not expand Environment policy.
- Owned Desktop localhost targets and Kestrel Edge previews must be available in
  QA mode through trusted Project or preview identity.
- Public operator browsing must be limited to the person's effective allowlist.
- Browser App settings must list remembered domains and allow the person to
  revoke them.

### Remembered domains

- A remembered domain must be personal across one Environment.
- It must not grant the domain to another person or another Environment.
- An eligible Project in the same Environment may use the remembered domain
  without another prompt.
- `browser.request_grant` must prompt only when the canonical domain is not
  already effective.
- Approval must add the canonical domain to the active session and future
  sessions.
- Denial must leave the allowlist unchanged.
- Revocation must stop future access without deleting prior evidence.
- The product must show the canonical wildcard, scope, and effect before the
  person approves it.
- A remembered domain must not authorize private, local, link-local, metadata,
  or otherwise forbidden public destinations.

### Browser operation

- Navigation, interactions, tab operations, inspection, and screenshots inside
  the effective allowlist must run without per-action approval.
- The Browser App must not classify clicks or form submissions through keyword,
  selector, URL, or page-content heuristics.
- The person must be able to take control, return control, close the session,
  and revoke remembered domains.
- Only one Browser Session may be active for a Thread.
- Reopening with the same mode and effective configuration must return the
  existing session idempotently.
- A conflicting open request must require closing the active session first.
- Sessions must expire after 30 minutes idle or eight hours total.

### Files and evidence

- Upload and download promotion must require explicit approval.
- Upload approval must name the exact Thread attachment.
- Download approval must name the quarantined download and resulting artifact.
- Screenshots inside the effective allowlist must not require separate approval.
- Page text and screenshots must remain untrusted content with origin and
  capture provenance.
- Logs and audit records must exclude URL queries, form values, page bodies,
  credentials, and screenshot contents.

## Technology Requirements

### Shared App and tool contract

- `built_in.browser` must be registered in the shared App identity and catalog
  surfaces used by Desktop and Kestrel One.
- `SharedToolContext` must expose one `BrowserServicePort` implemented by each
  host.
- Desktop and Kestrel One must use identical tool names, schemas, result shapes,
  failures, allowlist behavior, and takeover semantics.
- The stable surface must include open, request grant, snapshot, inspection,
  navigation, interaction, tabs, screenshot capture, upload, download
  promotion, takeover, and close operations.
- Interaction must use snapshot-scoped references. Stale references must return
  `BROWSER_TARGET_STALE` without selector guessing or fallback ranking.
- Snapshot and page results must use existing output budgets and deterministic
  continuation.
- Browser operations must use existing prepared invocation, exact-effect,
  result-normalization, event, and artifact contracts.
- The implementation must not introduce durable `BrowserAction` or
  `BrowserEvidence` systems that duplicate those contracts.

### Session and remembered-domain state

- Browser-specific session persistence must contain only session identity,
  Thread identity, mode, lifecycle state, engine revision, generation,
  effective allowlist revision, timestamps, expiry, and terminal reason.
- Hosted remembered-domain persistence must bind the canonical domain to the
  authenticated person and Environment, with approval provenance, timestamps,
  and revocation state.
- Desktop must keep the equivalent remembered domain in the signed-in local
  Browser App profile. Project policy may narrow it.
- Approval of a new domain and creation of its remembered-domain record must be
  one durable decision. A retry must return the existing record rather than
  create another.
- The active Browser Session must adopt the new allowlist revision before the
  requesting tool reports success.
- Every browser operation must resolve or validate the current effective
  allowlist revision before dispatch.
- Current Environment and Project policy must take precedence over remembered
  domains on every operation.

### Domain and network containment

- Kestrel's authenticated egress proxy must be the authoritative network
  enforcement point.
- The same effective allowlist must cover navigation, redirects, frames,
  scripts, styles, images, fetch, XHR, WebSockets, EventSource, workers,
  beacons, and browser-generated requests.
- Public browsing must use HTTPS on allowed ports. Desktop QA may additionally
  use an exact trusted loopback host and port.
- Domain normalization must cover Internationalized Domain Names, trailing
  dots, schemes, ports, redirects, and DNS results.
- Tenant-bounded wildcards must use the Public Suffix List, including private
  suffixes. A grant for `tenant.vercel.app` must never authorize other tenants
  under `vercel.app`.
- Kestrel must reject public suffix grants, IP-literal wildcards, non-HTTP
  schemes, private and LAN addresses, link-local addresses, metadata endpoints,
  and DNS changes into reserved address space.
- QUIC, WebRTC bypass, raw browser evaluation, and direct worker egress must be
  disabled.
- Browser-engine allowlists and security controls may provide defense in depth
  but must not replace Kestrel's dynamic policy.

### Desktop hosting

- Desktop must launch one isolated browser process and ephemeral profile per
  Thread Browser Session.
- Local Core must own the browser service, policy, lifecycle, and evidence.
- Desktop must bundle signed and checksum-verified browser-engine and Chrome
  assets through its existing resource pipeline.
- Runtime launch must use a Kestrel-owned empty configuration directory, a
  sanitized environment, an explicit executable, and the mandatory local
  egress proxy.
- Runtime launch must not discover Workspace configuration or download, install,
  or upgrade browser assets.
- The live viewer must use typed Desktop IPC and Local Core authorization. It
  must not expose a raw streaming or debugging socket to the renderer.
- Closing, expiry, or engine failure must destroy the temporary profile and
  process tree.

### Hosted browser execution

- Kestrel One must run one isolated ephemeral browser worker for each Browser
  Session.
- The worker must receive no Workspace mount, model credential, tenant-wide
  storage credential, or direct internet route.
- The control plane must remain authoritative for session access, policy,
  remembered domains, lifecycle, takeover, and artifacts.
- Worker authority must be short-lived and scoped to the tenant, Thread,
  Browser Session, operation, allowlist revision, and deadline.
- The ordinary hosted App relay may carry bounded control requests but must not
  carry live frames or large artifacts.
- Live frames must use authenticated Kestrel routes and short-lived viewer
  tickets. Raw worker addresses and credentials must never reach clients.
- Worker loss must mark the session lost and destroy the execution environment.
  Kestrel must not restore authentication or repeat uncertain actions.
- Hosted QA must support published Kestrel Edge previews and public websites,
  not unpublished Workspace ports.

### Human control, files, and evidence

- Human takeover must create one exclusive renewable input lease for the
  signed-in person.
- Agent browser actions must fail with `BROWSER_HUMAN_CONTROL_ACTIVE` while the
  person has control.
- Password, passkey, MFA, SSO, and other takeover input must travel directly
  between the viewer and browser.
- Takeover input must not enter a tool call, transcript, trace annotation,
  audit value, or durable log.
- Ordinary agent fill and type operations must use existing prepared tool input
  handling. Durable presentation and logs must redact their values.
- Uploads must use one-time access to the approved Thread attachment and must
  never receive a filesystem mount or path.
- Downloads must remain quarantined until approved promotion. Denial, expiry,
  close, and session loss must destroy unpromoted downloads.
- Screenshots and promoted downloads must inherit Thread authorization and
  retention. Live frames must remain transient.
- Failure traces must exclude request and response bodies, page contents,
  takeover input, and credentials.

### Reliability, release, and observability

- The browser engine and Chrome must be pinned in a checked-in release manifest
  with source URLs and SHA-256 digests for each supported platform.
- Build and release must fail closed when an asset is missing, unsigned, or has
  the wrong digest.
- Duplicate delivery of a completed browser operation must return the recorded
  exact result.
- A timeout after dispatch must produce `BROWSER_ACTION_OUTCOME_UNKNOWN` and
  must not trigger automatic retry.
- Typed failures must distinguish expired, lost, blocked, denied, human-control,
  stale-target, unknown-outcome, oversized-artifact, and engine-failure states.
- Operational metrics must cover startup latency, crashes, expirations,
  remembered-domain decisions and revocations, blocked destinations, unknown
  outcomes, artifact failures, and hosted worker cost.
- Contract tests must cover App registration, schemas, policy ceilings,
  remembered-domain persistence, idempotency, revocation, redaction, errors, and
  result shapes.
- Network tests must cover wildcard boundaries, private suffixes, IDNs, ports,
  redirects, subresources, sockets, workers, beacons, DNS rebinding, loopback
  QA, and reserved-address denial.
- Runtime tests must cover duplicate effects, timeout after dispatch, stale
  references, tabs and popups, crash and loss, takeover exclusion, lease
  disconnect, idle expiry, and hard expiry.
- Transfer tests must prove Thread attachment authorization, quarantine,
  promotion approval, size limits, isolation, and cleanup.
- Packaging tests must prove signatures, checksums, clean configuration,
  sanitized environment, no runtime installer, and profile destruction.
- Delivery must pass focused contract, process, PostgreSQL, and Chromium suites,
  `pnpm validate`, `validate:process`, `validate:postgres`, and
  `validate:chromium`.

## People and Operating Requirements

### Browser App user

- Can allow and remember a new domain once.
- Can see and revoke personal remembered domains in Browser App settings.
- Can operate any remembered domain across eligible Projects in the same
  Environment without repeated approval prompts.
- Reviews and approves only Thread file uploads and download promotion.
- Takes control for passwords, SSO, passkeys, MFA, and other authentication
  input, then explicitly returns control to the agent.
- Can close a browser session at any time.

### Environment and Project administrators

- The Environment administrator decides whether Browser App capability is
  available and sets its maximum policy.
- The Project administrator may narrow browser access for the Project.
- Neither administrator gains access to browser credentials, takeover input,
  page contents, screenshots, or another person's remembered domains through
  ordinary policy or health views.

### Kestrel agent

- Uses the stable Browser App tools instead of raw browser-engine commands.
- Calls `browser.request_grant` only when a required destination is not already
  effective.
- Continues automatically when a destination is already allowlisted.
- Requests human takeover instead of asking for or typing authentication
  secrets.
- Uses snapshot references without guessing stale targets.
- Does not retry an action with an unknown outcome.

### Support, security, and operations

- Support must be able to distinguish blocked policy, denied grant, revoked
  domain, expired or lost session, stale target, takeover state, engine failure,
  artifact failure, and unknown action outcome from metadata-only evidence.
- Security owners maintain the network ceiling, release-manifest verification,
  secret exclusion, and Browser App audit policy.
- Desktop release owners maintain signed browser assets and packaging evidence.
- Hosted operators maintain worker capacity, egress proxy health, viewer routes,
  quarantine cleanup, and cost visibility.
- Kestrel One Mobile may show approval interactions and authorized artifacts.
  It does not provide native browser takeover in v1.

## Success and Readiness

Success is observable when:

- A Desktop agent opens an exact localhost application, performs QA, captures a
  screenshot, and closes without a browser approval prompt.
- A Kestrel One agent tests an owned published preview through an isolated
  hosted worker.
- A person approves a new public domain once, the active session continues, and
  a future eligible session uses the domain without asking again.
- A destination already on the effective allowlist never generates a duplicate
  grant approval.
- Revoking a remembered domain prevents later network requests while preserving
  past Thread evidence.
- An operator completes a multi-step website task without per-navigation,
  per-click, per-keystroke, or per-screenshot approvals.
- A person completes login or MFA through takeover and returns control without
  exposing authentication input to the model or durable Kestrel records.
- An upload can read only the approved Thread attachment.
- An unapproved download never becomes a Thread artifact.
- A page cannot reach a destination outside the effective allowlist through a
  redirect, subresource, worker, socket, beacon, or DNS change.
- Worker or process loss destroys browser state without repeating an uncertain
  action.
- Desktop and hosted tools produce the same schemas, results, and failures.
- Required contract, process, PostgreSQL, Chromium, packaging, and full
  validation gates pass.

**Readiness: Ready for issue creation.**

The product behavior, approval model, remembered-domain scope, Browser App
boundary, Desktop and hosted ownership, network rules, takeover behavior, file
controls, failure behavior, and success evidence are settled. Exact engine and
Chrome versions may change through the verified release manifest without
changing this Product Brief.

## Source Artifacts

- [Kestrel Browser App Design Notebook](../../.design/kestrel-browser-app/notebook.md)
