# Run safe Browser App sessions in Kestrel One

## Useful outcome

A Kestrel One agent can test an owned published Kestrel Edge preview or operate an authorized public HTTPS/443 site. It uses the same tools and results as Desktop to navigate, inspect, interact, manage tabs, capture a Thread-authorized screenshot, and close without per-action approvals.

Each Browser Session runs in one dedicated no-volume Fly Machine. It is not a Workspace Runtime and receives no Workspace mount, model credential, broad storage credential, reusable profile, or direct internet route. This slice delivers hosted browsing from the [Kestrel Browser App Product Brief](../../kestrel-browser-app-product-brief.md).

## What changes

- Implement the hosted `BrowserServicePort` under `apps/web/lib/browser/` with the web control plane as the authority for session access, policy, exact effects, lifecycle, artifacts, and terminal state.
- Add hosted `BrowserSessionV1` persistence and a registered migration in `apps/web/drizzle/schema.ts` and `apps/web/lib/db/migrations/`. Persist only the fields allowed by the shared contract. Enforce one nonterminal Browser Session per Thread with a database constraint.
- Resolve the session's person, organization, Environment, and Project from the durable originating turn/run and Thread authorization on every operation. Do not duplicate those identities in `BrowserSessionV1`. Thread visibility alone does not let a different person use the originating person's grants or viewer.
- Provision one dedicated ephemeral Fly Machine for each active Browser Session. Reuse only low-level create, wait, inspect, and delete operations from `apps/web/lib/environments/providers/contracts.ts` and `fly-machines.ts`. Do not use `environment_workspaces`, Workspace volumes, backups/restores, `provisioner.ts`, or pooled turn-worker capacity.
- Build the worker from the shared runtime release manifest, deploy it by immutable OCI digest, and verify the running engine and Chrome revisions before marking the session ready. Fetch no browser asset at worker startup.
- Label the machine with the Browser Session ID and generation so restart reconciliation can find it through Fly. Persist terminal intent before cleanup. Retry deletion until the labeled machine is confirmed absent; do not add machine identity to the model-visible or Browser Session contract.
- Give the worker only short-lived authority scoped to organization, Environment, Project, Thread, Browser Session, generation, exact operation ID, effective allowlist revision, and deadline. Reject any mismatched or expired claim.
- Treat a requested preview ID as a selector, not authority. Resolve an active, unexpired `workspace_preview_leases` row matching the current organization, Environment, and Project through `apps/web/lib/apps/preview-lifecycle.ts`. Use its recorded hostname. Reject model-supplied hostnames, ports, tenant boundaries, unowned previews, and unpublished Workspace targets.
- Route every worker request through Kestrel's authenticated egress proxy. Apply the shared Browser policy and `packages/mcp-security` address checks to redirects, frames, scripts, styles, images, fetch, XHR, WebSockets, EventSource, workers, beacons, and DNS changes. Disable direct egress, QUIC, WebRTC bypass, and engine evaluation.
- Install a grant or revocation revision in the hosted proxy before issue 02's adoption call returns. Close no-longer-authorized long-lived connections and prove the next request uses the new revision.
- Implement open, snapshot, inspect, navigate, interact, tabs, capture, and close through the shared prepared contract. Use snapshot references without selector fallback and deterministic continuation for bounded page results.
- Present screenshots through `AgentToolArtifactPresentation` and existing Thread authorization. Keep screenshot contents, URL queries, page bodies, and fill/type values out of logs, traces, audit records, metrics, and support evidence.
- Use the ordinary App relay only for control requests below its current 2 MiB request limit and 30-second timeout. Large screenshot bytes must use authenticated Kestrel artifact routes. Raw worker addresses and credentials never reach clients.
- Define dispatch as acknowledged only when the worker accepts the exact operation ID and generation before invoking the engine. Failure before acknowledgement is `not_started`. Timeout or loss after acknowledgement without a committed effect result returns `BROWSER_ACTION_OUTCOME_UNKNOWN` and must never redispatch that effect.
- Provide the bounded upload stream hook required by issue 07. Until issue 07 lands, reject upload before issuing file authority. Route every download event through a host interception hook; until issue 08 lands, cancel it before bytes are written and return a stable unavailable result.
- On close, expiry, process exit, engine failure, or authenticated control-channel loss past the current operation deadline, record the session lost and destroy the worker, profile, proxy authority, and capabilities. Do not reconnect, restore authentication, or replay an uncertain effect.
- Emit metadata-only metrics for startup, capacity, revision adoption, crashes, expirations, blocked destinations, stale targets, unknown outcomes, artifact failures, egress health, cleanup, and worker cost.

## Requirements and delivery context

Issues 01 and 02 provide the shared contract and policy. Hosted App execution and bounded relay conventions live in `apps/web/lib/apps/runtime-route.ts`, `tools/kestrelOne/appTransport.ts`, and `apps/environment-router/src/app-relay.ts`. These routes do not own preview authorization or browser-worker lifecycle.

Live viewing belongs to issue 06. File transfers belong to issues 07 and 08. The host must pass the shared conformance suite before those issues start.

Add PostgreSQL, Fly-provider, worker, proxy-bypass, Chromium, artifact, image, cost, and reconciliation tests. Cover active and expired previews, identity/tenant mismatch, HTTPS/443, redirects, subresources, sockets, workers, beacons, DNS rebinding, direct egress denial, stale references, duplicate effects, pre/post-ack failure, expiry, crash, capability expiry, screenshot projection, restart cleanup, and immutable image proof. Add a real environment canary. Run focused suites, `pnpm validate`, `pnpm validate:process`, `pnpm validate:postgres`, and `pnpm validate:chromium`.

## Done when

- A hosted agent tests an authorized active Kestrel Edge preview and captures a screenshot without a browser approval prompt.
- An authorized public-site task completes through the shared Browser App contract without per-action approvals.
- One Browser Session maps to one dedicated no-volume machine with no Workspace state, broad credential, reusable profile, or direct egress.
- Unowned or expired previews, unpublished ports, cross-identity requests, expired capabilities, and proxy bypass fail closed.
- Grant and revocation success prove the hosted proxy installed the effective revision.
- Duplicate delivery, unknown outcome, stale target, expiry, crash, restart reconciliation, and loss follow the shared contract without restoring state.
- Terminal cleanup confirms the machine, profile, proxy authority, and capabilities are gone.
- The host conformance suite, real canary, focused coverage, and required validation gates pass.

## Depends on

- [Register the Browser App and stable tool contract](01-register-the-browser-app-and-tool-contract.md)
- [Allow and remember personal browser domains](02-allow-and-remember-personal-browser-domains.md)
