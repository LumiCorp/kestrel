# Kestrel One control worker

This private, non-HTTP Fly process owns hosted Environment lifecycle operations,
resource reconciliation, deletion, and Workspace backups. It never processes
durable user turns.

The worker treats queues as wake-up mechanisms. Scheduled reconciliation can
reconstruct platform work from desired generation, Environment targets,
verified resource images, operation evidence, and authoritative Fly state.
Retrying or restarting the worker therefore does not restart a global release
or repeat completed resource mutations.

During the migration proof window it also consumes the version-fenced legacy
release queue and writes the legacy heartbeat. Those compatibility surfaces are
removed only after two desired-state production rollouts and a rollback drill.

Set `KESTREL_PLATFORM_RUNTIME_RECONCILIATION_MODE=observe` for migration and
shadow comparison. Set it to `active` only after migration 0061 is verified.
In active mode the persistent canary is automatic, fanout is per Environment,
and failures are resource-local.

The main-branch runtime workflow builds this worker only when its declared
catalog inputs change, smokes the immutable image, deploys that exact digest,
and checks its readiness file.
