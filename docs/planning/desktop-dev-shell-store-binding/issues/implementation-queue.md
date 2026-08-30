# Desktop Developer Shell Store Binding Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

None.

## In progress

None.

## Blocked

None.

## Implemented

- [Bind the developer shell to Local Core storage authority](01-bind-developer-shell-storage-authority.md)
- [Preserve standalone developer-shell store resolution](02-preserve-standalone-store-resolution.md)
- [Make incompatible developer-shell replacement exclusive](03-make-incompatible-service-replacement-exclusive.md)
- [Serialize developer-shell service bootstrap](04-serialize-service-bootstrap.md)
- [Refuse unproven legacy service termination](05-refuse-unproven-legacy-service-termination.md)
- [Assert store binding at command dispatch](06-assert-binding-at-command-dispatch.md)
- [Make bootstrap authority crash-safe and child-owned](07-make-bootstrap-authority-crash-safe.md)
- [Use cooperative service shutdown instead of numeric PID signaling](08-use-cooperative-service-shutdown.md)
- [Parse bootstrap authority evidence strictly](09-parse-authority-evidence-strictly.md)
- [Serialize same-client bootstrap attempts](10-serialize-same-client-bootstrap-attempts.md)
- [Recover failed authority transfer](11-recover-failed-authority-transfer.md)
- [Tolerate transient authority snapshots](12-tolerate-transient-authority-snapshots.md)
- [Bind shutdown completion to the proven endpoint](13-bind-shutdown-completion-to-endpoint.md)
- [Strip developer-shell control environment from commands](14-strip-dev-shell-control-environment.md)
- [Stabilize standalone binding revisions](15-stabilize-standalone-binding-revisions.md)
- [Make endpoint removal prove cleanup completion](16-make-endpoint-removal-prove-cleanup.md)
- [Drain in-flight requests before service cleanup](17-drain-inflight-requests-before-cleanup.md)
- [Keep malformed request targets inside the service error boundary](18-keep-malformed-targets-inside-error-boundary.md)

## Done

None.
