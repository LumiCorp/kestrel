# Kestrel Browser App Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Add hosted browser viewing and human takeover](06-add-hosted-browser-viewing-and-takeover.md)
- [Upload an approved Thread attachment](07-upload-an-approved-thread-attachment.md)
- [Promote a quarantined browser download](08-promote-a-quarantined-browser-download.md)

## In progress

None.

## Blocked

None.

## Implemented

- [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md) — implementation, focused contracts, portable validation, and a real local worker-image smoke are green; the exact published image, live Fly session canary, and direct-egress namespace proof remain before `Done`
- [Add Desktop browser viewing and human takeover](04-add-desktop-browser-viewing-and-takeover.md) — implementation, focused contracts, typechecks, and portable validation are green; signed packaged viewer evidence and the native passkey-chooser canary remain before `Done`
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
