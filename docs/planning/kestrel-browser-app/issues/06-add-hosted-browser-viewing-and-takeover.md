# Add hosted browser viewing and human takeover

## Useful outcome

The person whose hosted turn opened the Browser Session can watch it in Kestrel One web, accept an agent takeover request, enter passwords, single-use codes, and page-rendered SSO or MFA input, and explicitly return control. Hosted v1 does not proxy the person's local platform authenticator into remote Chromium; real passkeys remain a Desktop v1 capability until a future privileged hosted client owns that ceremony. Thread access or Environment administration alone does not grant viewer access.

Kestrel One Mobile remains approval and authorized-artifact capable but gains no native browser takeover. This slice delivers hosted takeover from the [Kestrel Browser App Product Brief](../../kestrel-browser-app-product-brief.md).

## What changes

- Add one versioned Kestrel-owned WebSocket viewer route, registered in `apps/web/app/route-ownership.manifest.ts`, that multiplexes typed frame, lease-state, control, and input messages. Do not widen the ordinary App relay into a streaming transport.
- Authorize the viewer through the existing Thread access service and the actor bound to the Browser Session's originating turn/run. Only that actor can mint a ticket, view frames, accept takeover, send input, return control, or close the session.
- Mint a single-session viewer ticket containing audience, organization, Environment, Project, Thread, Browser Session ID, generation, actor ID, nonce, issued time, and expiry. The ticket expires after 60 seconds, establishes one connection, and cannot be replayed. Renewal requires a newly authorized ticket.
- Keep raw worker addresses, browser credentials, agent-browser commands, CDP, proxy endpoints, and debugging sockets out of client messages.
- `browser.request_takeover` creates a pending request while the session remains agent-controlled. Only the authorized viewer can accept it and enter `human_control`. The model cannot create an input lease or return control.
- Give the accepted viewer one exclusive renewable input lease. The lease governs input delivery, not the Browser Session control state. Disconnect, ticket expiry, or lease expiry ends the connection but leaves the session in `human_control`; agent operations remain blocked.
- Let the same authorized person reconnect with a new ticket and lease. Only an authenticated viewer “Return to agent” action moves the session back to ready.
- Route typed pointer and keyboard input through the authenticated WebSocket to the active worker. Keep takeover input out of tools, prepared effects, model IO, transcripts, events, traces, logs, audits, analytics, metrics, crash reports, and returned errors. Do not allow request-body logging on the input route.
- If the actor loses Thread/Project/Environment access, the Browser App is disabled, the actor changes, the session generation changes, or the worker is lost, revoke viewer authority and close the Browser Session. Do not silently resume agent control.
- Keep frames transient. Revoke tickets, connections, leases, and frames on return, close, expiry, authorization loss, or worker loss. Emit metadata-only lifecycle evidence.
- Keep server projection compatible with `apps/web/lib/mobile/message-parts.ts`. Verify the separate mobile client does not expose a viewer or takeover action.

## Requirements and delivery context

Issue 05 provides the worker, originating actor authority, session, and control plane. Existing execution/App routes do not authorize viewer access. Use the current Thread authorization service under `apps/web/lib/threads/`.

Add route, ticket, WebSocket, authorization, worker, PostgreSQL, web viewer, and Chromium tests. Send unique sentinel password, one-time-code, and page-rendered MFA values through the viewer. Assert that the browser receives them and that every persistent or diagnostic surface excludes them. Cover ticket replay/expiry, wrong actor/Thread/tenant, exclusive control, renewal, disconnect, reconnect, explicit return, close, authorization loss, and worker loss. Prove the hosted UI makes no local-platform-passkey promise. Run focused suites, `pnpm validate`, `pnpm validate:process`, `pnpm validate:postgres`, and `pnpm validate:chromium`.

## Done when

- Only the originating authenticated actor can view or control the hosted Browser Session.
- One-use 60-second tickets reveal no worker address or engine credential.
- The agent can request takeover, but only the viewer can accept it or return control.
- Disconnect or lease expiry leaves the session in human control and keeps agent actions blocked.
- Password, one-time-code, and page-rendered SSO/MFA login complete in the existing session, and sentinel secrets appear in no model-visible, persistent, or diagnostic surface.
- Hosted v1 exposes no virtual, synthesized, or local-platform-passkey proxy path.
- Authorization loss, App disablement, close, expiry, and worker loss terminate viewer authority without silently resuming the agent.
- Kestrel One Mobile exposes no browser viewer or takeover control.
- Focused coverage and required validation gates pass.

## Integration basis

- Build against the reviewed implementation contract from [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md). Final completion still requires the combined live hosted evidence.
