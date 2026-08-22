# Kestrel One control worker

This private Fly process owns durable Knowledge ingestion and Environment
lifecycle work: provisioning, explicit runtime updates, reconciliation,
organization deletion, Workspace backups, and cost jobs. It does not coordinate
production delivery and carries no candidate, release, approval, lease, or
database-heartbeat contract.

Publish this role locally with `pnpm production:image:publish`, then update one
exact Machine with `pnpm production:fly:machine`. Fly platform authority stays
on the owning Fly application. `CRON_SECRET` remains Web-only. Follow the
[control-worker rollout](./ROLLOUT.md) for Web and migration ordering,
started-before-stopped Machine updates, Knowledge verification, and rollback.

Readiness is provider-native. The process binds its private health port, returns
503 until configuration and database access are ready, both Environment and
Knowledge consumers are registered, and initial reconciliation succeeds. It
becomes unhealthy again during graceful shutdown. The image smoke checks the
missing-configuration boundary only; production readiness and work delivery
must be verified after each exact Machine update.
