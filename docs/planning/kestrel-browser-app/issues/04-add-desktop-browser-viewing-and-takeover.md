# Add Desktop browser viewing and human takeover

## Useful outcome

The authorized Desktop user can watch the current Browser Session, accept an agent takeover request, enter password, passkey, single-use-code, SSO, or MFA input, and explicitly return control. The agent cannot take control back, and authentication input never enters model context or a durable record.

This slice delivers Desktop human takeover from the [Kestrel Browser App Product Brief](../../kestrel-browser-app-product-brief.md).

## What changes

- Add versioned viewer messages to `src/desktopShell/contracts.ts`, expose them through `apps/desktop/src/preload.ts`, authorize and route them in `apps/desktop/src/main.ts`, and render them in the active Thread UI under `apps/desktop/renderer/src/`.
- Treat the current authorized main-frame renderer, bound to the active Thread and Project, as the Desktop viewer principal. If the session uses an account-backed Environment, the active Kestrel account must also match. Reuse `requireCurrentMainWindowIpcSender`; no secondary renderer or Environment administrator gains viewer access.
- Keep `apps/desktop/renderer/src/browserPreview.ts` as a development bridge only. It is not viewer authority.
- `browser.request_takeover` creates a pending request while the Browser Session remains agent-controlled. Only the authorized viewer can accept it and move the session to `human_control`. The agent cannot create an input lease or return control.
- Give one accepted viewer connection an exclusive renewable input lease. The lease authorizes input delivery only. Lease expiry or viewer disconnection removes the connection but leaves the Browser Session in `human_control`; agent operations continue to return `BROWSER_HUMAN_CONTROL_ACTIVE`.
- Let the same authorized viewer reconnect and obtain a replacement lease. Only an explicit viewer “Return to agent” action changes `human_control` back to ready.
- Route typed pointer and keyboard input through the authorized Desktop IPC path to the active adapter. Never expose engine, CDP, proxy, debugging, or streaming endpoints to the renderer.
- Keep passwords, passkeys, codes, SSO, MFA, and all takeover input out of tool preparation, model IO, transcripts, runtime events, audit records, logs, analytics, metrics, crash metadata, and returned failures. Live frames remain transient.
- Close the Browser Session instead of resuming the agent when the main renderer principal changes, the account changes, Thread access is lost, the Browser App is disabled, the session generation changes, or the engine is lost. Close and expiry also revoke all viewer state.
- Emit metadata-only events for request, acceptance, lease issue/renewal, disconnect, return, rejection, expiry, authorization loss, and cleanup.

## Requirements and delivery context

Issue 03 provides the process, proxy, session, and adapter. Local Core remains the authority. The renderer receives typed frames and sends typed input only through the Desktop bridge.

Ordinary agent fill/type still uses prepared input and issue 03's redaction rules. Upload and download remain separately approved operations.

Add IPC, main-frame authorization, renderer, process, and Chromium tests. Send unique sentinel password and MFA values through takeover. Assert that the browser receives them and that they are absent from prepared calls, events, transcripts, audit storage, logs, analytics, metrics, crash metadata, and errors. Also prove wrong renderer/account/Thread rejection, exclusive control, renewal, explicit return, disconnect, reconnect, close, expiry, and engine loss. Run focused suites, `pnpm validate`, `pnpm validate:process`, and `pnpm validate:chromium`.

## Done when

- The authorized Desktop main renderer can view the live session without receiving a raw engine or debugging endpoint.
- The agent can request takeover but only the viewer can accept it or return control.
- Human control blocks all agent browser actions, including after viewer disconnect or lease expiry.
- Login and MFA complete in the existing session, and explicit viewer return resumes the agent.
- Sentinel secrets reach the browser input path and appear in no model-visible or durable surface.
- Principal change, App disablement, close, expiry, and engine loss terminate viewer authority without silently resuming the agent.
- Focused coverage and required validation gates pass.

## Integration basis

- Build against the reviewed implementation contract from [Run safe Browser App sessions on Desktop](03-run-safe-browser-sessions-on-desktop.md). Final completion still requires the combined packaged Desktop evidence.
