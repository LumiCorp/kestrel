# Kestrel Browser App Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Add hosted browser viewing and human takeover](06-add-hosted-browser-viewing-and-takeover.md)
- [Upload an approved Thread attachment](07-upload-an-approved-thread-attachment.md)
- [Promote a quarantined browser download](08-promote-a-quarantined-browser-download.md)

## In progress

## Blocked

- [Add Desktop browser viewing and human takeover](04-add-desktop-browser-viewing-and-takeover.md) — implementation is review-clean; blocked only on issue 04c's signed platform-authenticator canary
- [Complete native authentication takeover](04c-complete-native-authentication-takeover.md) — code path is review-clean; blocked on signed platform-authenticator canary
- [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md) — blocked on issues 05a-05g and the remaining live Fly canaries
- [Enforce Gateway-only Browser worker egress](05a-enforce-gateway-only-worker-egress.md) — input/output policy and routed image smoke are review-clean; blocked on live Fly proof

## Implemented

- [Block Browser worker reverse channels](05e-block-worker-reverse-channels.md) — independent review and local routed image smoke are green; live Fly 6PN proof remains
- [Run safe Browser App sessions on Desktop](03-run-safe-browser-sessions-on-desktop.md) — implementation and unsigned package proof are green; signed/notarized package proof and packaged live Browser canaries remain before `Done`

## Done

- [Close an unfinished upload after an early response](05m-close-unfinished-upload-after-early-response.md)
- [Separate upload progress from the response-header timeout](05l-separate-upload-progress-from-response-header-timeout.md)
- [Enforce Gateway connection timeouts](05g-enforce-gateway-connection-timeouts.md)
- [Close the in-flight Gateway revocation race](05b-close-inflight-gateway-revocation-race.md)
- [Proxy authorized QA WebSockets](05d-proxy-authorized-qa-websockets.md)
- [Terminalize rejected upgrade sockets](05k-terminalize-rejected-upgrade-sockets.md)
- [Accept the real QA WebSocket proxy form](05j-accept-real-qa-websocket-proxy-form.md)
- [Revalidate native handoff presentation](04g-revalidate-native-handoff-presentation.md)
- [Close Desktop viewer journal crash windows](04f-close-viewer-journal-crash-windows.md)
- [Persist Desktop viewer authority loss across restart](04e-persist-viewer-authority-loss-across-restart.md)
- [Retry Desktop viewer authority loss](04b-retry-desktop-viewer-authority-loss.md)
- [Reserve Gateway work before DNS](05c-reserve-gateway-work-before-dns.md)
- [Serialize Gateway retirement and shutdown](05i-serialize-gateway-retirement-and-shutdown.md)
- [Complete exact Browser egress close cleanup](05h-complete-exact-egress-close-cleanup.md)
- [Revoke egress after uncertain Browser close](05f-revoke-egress-after-uncertain-close.md)
- [Prove packaged viewer evidence wiring](04d-prove-packaged-viewer-evidence-wiring.md)
- [Wire Desktop viewer lifecycle evidence](04a-wire-desktop-viewer-lifecycle-evidence.md)
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
