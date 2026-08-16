# Kestrel One Environment lifecycle worker

This private Fly process owns durable Environment lifecycle work: provisioning,
explicit runtime updates, reconciliation, organization deletion, Workspace
backups, and cost jobs. It does not coordinate production delivery and carries
no candidate, release, approval, lease, or database-heartbeat contract.

Publish this role locally with `pnpm production:image:publish`, then update one
exact Machine with `pnpm production:fly:machine`. Fly platform authority stays
on the owning Fly application. `CRON_SECRET` remains Web-only.

Readiness is provider-native. The process binds its private health port, returns
503 until configuration, database access, and lifecycle queue registration are
ready, and becomes unhealthy again during graceful shutdown. Rollback is an
explicit update of the same Machine to its previous operator tag.
