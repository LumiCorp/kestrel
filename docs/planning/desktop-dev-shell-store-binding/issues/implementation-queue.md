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
- [Cancel shutdown-blocking requests before replacement times out](19-cancel-shutdown-blocking-requests.md)
- [Align the supervisor environment regression with private control stripping](20-align-supervisor-environment-regression.md)
- [Await child settlement before service cleanup completes](21-await-child-settlement-before-cleanup.md)
- [Terminate a starting child when shutdown interrupts initial persistence](22-terminate-starting-child-on-shutdown.md)
- [Clean up children after initial process persistence failure](23-cleanup-child-after-initial-persistence-failure.md)
- [Serialize startup evidence and own settlement failure](24-serialize-startup-evidence-and-own-settlement-failure.md)
- [Retain every child through failed supervisor close](25-retain-every-child-through-failed-close.md)
- [Preserve initial persistence failure priority](26-preserve-initial-persistence-failure-priority.md)
- [Do not re-signal dead retained children](27-do-not-resignal-dead-retained-children.md)
- [Guard delayed lifecycle signals with child liveness](28-guard-delayed-lifecycle-signals.md)
- [Own developer-shell maintenance failures](29-own-maintenance-failures.md)

## Done

None.
