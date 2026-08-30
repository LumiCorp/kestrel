# Kestrel Browser App Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

None.

## In progress

- [Allow and remember personal browser domains](02-allow-and-remember-personal-browser-domains.md)

## Blocked

- [Run safe Browser App sessions on Desktop](03-run-safe-browser-sessions-on-desktop.md) — blocked by [the shared contract](01-register-the-browser-app-and-tool-contract.md) and [domain authority](02-allow-and-remember-personal-browser-domains.md)
- [Add Desktop browser viewing and human takeover](04-add-desktop-browser-viewing-and-takeover.md) — blocked by [the Desktop browser host](03-run-safe-browser-sessions-on-desktop.md)
- [Run safe Browser App sessions in Kestrel One](05-run-safe-browser-sessions-in-kestrel-one.md) — blocked by [the shared contract](01-register-the-browser-app-and-tool-contract.md) and [domain authority](02-allow-and-remember-personal-browser-domains.md)
- [Add hosted browser viewing and human takeover](06-add-hosted-browser-viewing-and-takeover.md) — blocked by [the hosted browser host](05-run-safe-browser-sessions-in-kestrel-one.md)
- [Upload an approved Thread attachment](07-upload-an-approved-thread-attachment.md) — blocked by the [Desktop](03-run-safe-browser-sessions-on-desktop.md) and [hosted](05-run-safe-browser-sessions-in-kestrel-one.md) transfer hooks
- [Promote a quarantined browser download](08-promote-a-quarantined-browser-download.md) — blocked by the [Desktop](03-run-safe-browser-sessions-on-desktop.md) and [hosted](05-run-safe-browser-sessions-in-kestrel-one.md) interception hooks

## Implemented

None.

## Done

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
