# Kestrel Browser App Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Prove packaged viewer evidence wiring](04d-prove-packaged-viewer-evidence-wiring.md)
- [Retry Desktop viewer authority loss](04b-retry-desktop-viewer-authority-loss.md)
- [Complete native authentication takeover](04c-complete-native-authentication-takeover.md)
- [Reserve Gateway work before DNS](05c-reserve-gateway-work-before-dns.md)
- [Proxy authorized QA WebSockets](05d-proxy-authorized-qa-websockets.md)
- [Block Browser worker reverse channels](05e-block-worker-reverse-channels.md)
- [Revoke egress after uncertain Browser close](05f-revoke-egress-after-uncertain-close.md)
- [Enforce Gateway connection timeouts](05g-enforce-gateway-connection-timeouts.md)
- [Add hosted browser viewing and human takeover](06-add-hosted-browser-viewing-and-takeover.md)
- [Upload an approved Thread attachment](07-upload-an-approved-thread-attachment.md)
- [Promote a quarantined browser download](08-promote-a-quarantined-browser-download.md)

## In progress

None.

## Blocked

- [Add Desktop browser viewing and human takeover](04-add-desktop-browser-viewing-and-takeover.md) — review found missing packaged lifecycle-evidence proof, lost authority cleanup after transient Local Core failure, and no native authentication handoff; blocked on issues 04a-04d
- [Wire Desktop viewer lifecycle evidence](04a-wire-desktop-viewer-lifecycle-evidence.md) — review found that the direct sink test does not prove packaged service wiring; blocked on issue 04d
- [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md) — blocked on issues 05a-05g and the remaining live Fly canaries
- [Enforce Gateway-only Browser worker egress](05a-enforce-gateway-only-worker-egress.md) — review found an inbound reverse-channel bypass; blocked on issue 05e and live Fly proof
- [Close the in-flight Gateway revocation race](05b-close-inflight-gateway-revocation-race.md) — review found pre-DNS lifecycle, plain QA WebSocket, and inert timeout gaps; blocked on issues 05c, 05d, and 05g

## Implemented

- [Run safe Browser App sessions on Desktop](03-run-safe-browser-sessions-on-desktop.md) — implementation and unsigned package proof are green; signed/notarized package proof and packaged live Browser canaries remain before `Done`

## Done

- [Allow and remember personal browser domains](02-allow-and-remember-personal-browser-domains.md)
- [Register the Browser App and stable tool contract](01-register-the-browser-app-and-tool-contract.md)
- [Resolve Browser policy before approval](01a-resolve-browser-policy-before-approval.md)
- [Preserve Browser dispatch and exact results](01b-preserve-browser-dispatch-and-exact-results.md)
- [Enforce secret-safe Browser results](01c-enforce-secret-safe-browser-results.md)
- [Make Browser dispatch evidence durable without weakening other tools](01d-make-browser-dispatch-evidence-durable-without-weakening-other-tools.md)
- [Bind Browser results to prepared authority](01e-bind-browser-results-to-prepared-authority.md)
- [Bind Browser policy through every approval path](01f-bind-browser-policy-through-every-approval-path.md)
- [Redact Browser run events before persistence](01g-redact-browser-run-events-before-persistence.md)
- [Authorize durable dispatch by tool contract](01h-authorize-durable-dispatch-by-tool-contract.md)
- [Ground Browser result authority in execution context](01i-ground-browser-result-authority-in-execution-context.md)
- [Resume the exact Browser call after approval](01j-resume-the-exact-browser-call-after-approval.md)
- [Canonicalize Browser artifact presentation](01k-canonicalize-browser-artifact-presentation.md)
- [Prepare every Browser approval exactly](01l-prepare-every-browser-approval-exactly.md)
- [Revalidate current policy before pending Browser allow](01m-revalidate-current-policy-before-pending-browser-allow.md)
- [Adopt current Browser authority after pending allow](01n-adopt-current-browser-authority-after-pending-allow.md)
- [Complete current allow authority adoption](01o-complete-current-allow-authority-adoption.md)
