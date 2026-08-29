# Run safe Browser App sessions on Desktop

## Useful outcome

A Desktop agent can test an exact Project-owned localhost application or operate an authorized public HTTPS/443 site. It can navigate, inspect, interact, manage tabs, read page and console errors, capture a Thread-authorized screenshot, and close without per-action approvals.

Desktop runs one isolated agent-browser process with pinned Chrome for each Thread Browser Session. Local Core and its per-session proxy own authority. This slice delivers Desktop QA and public browsing from the [Kestrel Browser App Product Brief](../../kestrel-browser-app-product-brief.md).

## What changes

- Implement and inject the Desktop `BrowserServicePort` through `src/localCore/executionRuntime.ts` and `cli/runtime/KestrelChatRuntime.ts`. Implement open, snapshot, inspect, navigate, interact, tabs, capture, and close from the shared prepared contract.
- Store only the minimal `BrowserSessionV1` fields in a Local Core-owned durable record, not Desktop settings or the browser profile. Enforce one nonterminal session per Thread.
- On Local Core startup, mark every prior-generation nonterminal Browser Session lost. Remove its owned orphan process and profile before another session opens. Never restore cookies, local storage, credentials, or authentication state.
- Support `darwin-arm64` only for v1. Add exact source URL and SHA-256 entries for agent-browser and Chrome to the shared release manifest. Verify digests before packaging and verify that every bundled executable is covered by the signed/notarized application.
- Launch one explicit engine executable and ephemeral profile from a Kestrel-owned empty runtime/configuration directory. Use a sanitized environment, disabled extensions, disabled QUIC/WebRTC bypass, and no Workspace, home-directory, or ambient engine configuration. Never install or upgrade at runtime.
- Resolve Desktop QA targets through `DesktopProjectRunRegistry.resolvePreviewUrl` in `src/localCore/desktopProjectRuns.ts`, exposed by `src/localCore/api.ts`. Require the managed Project run to belong to the active Thread's Project. Grant only its recorded loopback URL. Reject every unrecorded model-supplied localhost URL or port.
- Add a Local Core-owned authenticated egress proxy per Browser Session. Bind its credential to Thread, session, generation, and effective revision. Resolve DNS in the proxy and apply the shared `src/browser/` policy plus `packages/mcp-security` public-address checks to every request and connection.
- Launch Chrome with the proxy and no bypass route. Cover navigation, redirects, frames, scripts, styles, images, fetch, XHR, WebSockets, EventSource, workers, beacons, and DNS changes. Engine allowlists are defense in depth only.
- Install a new grant or revocation revision in the proxy before issue 02's session-adoption call returns. The next browser-generated request must demonstrate the new decision.
- Use snapshot-scoped references and deterministic continuation. Mark page-derived text and screenshots untrusted with origin, capture time, generation, and boundary metadata.
- Present screenshots through `AgentToolArtifactPresentation` with Thread authorization and retention. Keep screenshot contents, URL queries, page bodies, and fill/type values out of logs, events, traces, metrics, and support evidence.
- Define dispatch as acknowledged only when the adapter accepts the exact operation ID and session generation before calling the engine. If an effectful operation times out after acknowledgement without a committed result, return `BROWSER_ACTION_OUTCOME_UNKNOWN` and never dispatch it again automatically.
- Provide a bounded upload stream hook for issue 07. Until issue 07 lands, reject upload before reading bytes. Route every engine download event through a host interception hook; until issue 08 lands, cancel it before bytes reach a default download directory and return a stable unavailable result.
- On close, expiry, startup failure, engine exit, or lost control channel, record terminal state, terminate the process tree, revoke proxy authority, and destroy the profile. Do not reconnect or reconstruct the session.
- Emit metadata-only metrics for startup, revision adoption, blocked destinations, stale targets, expirations, crashes, unknown outcomes, screenshots, and cleanup.

## Requirements and delivery context

Issues 01 and 02 provide the shared contract and effective policy. Local Core owns the host implementation. Desktop resources are configured in `apps/desktop/src/builderConfig.ts`; package proof is owned by `scripts/check-desktop-package.ts` and `scripts/check-desktop-release.ts`.

Human viewing and takeover belong to issue 04. File transfers belong to issues 07 and 08. The host must pass the shared conformance suite before those issues start.

Add process, Local Core restart, proxy-bypass, Chromium, packaging, artifact, and cleanup tests. Cover recorded and unrecorded loopback targets, HTTPS/443, redirects, subresources, sockets, workers, beacons, DNS rebinding, direct egress denial, stale references, tabs/popups, duplicate effects, pre/post-dispatch failure, expiry, crash, screenshots, sanitized launch, asset proof, and profile destruction. Run package checks, focused suites, `pnpm validate`, `pnpm validate:process`, and `pnpm validate:chromium`.

## Done when

- A packaged Desktop build tests a recorded Project-run localhost target and captures a screenshot without a browser approval prompt.
- An authorized public-site task completes without navigation, interaction, typing, tab, inspection, or screenshot approvals.
- Chrome has no route around the proxy, and no request escapes the effective allowlist through redirects, subresources, sockets, workers, beacons, or DNS changes.
- Grant and revocation success prove the proxy installed the effective revision.
- Reopen, conflict, continuation, stale target, duplicate delivery, unknown outcome, expiry, crash, restart recovery, and loss follow the shared contract.
- Close, expiry, and failure terminate the process tree and remove the profile and proxy authority.
- The `darwin-arm64` package contains only manifest-verified, signed runtime assets and performs no runtime installation or configuration discovery.
- The Desktop host passes the shared conformance suite and required validation gates.

## Depends on

- [Register the Browser App and stable tool contract](01-register-the-browser-app-and-tool-contract.md)
- [Allow and remember personal browser domains](02-allow-and-remember-personal-browser-domains.md)
