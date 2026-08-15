# Kestrel One Environment lifecycle worker

This private Fly process owns durable Environment lifecycle work: provisioning,
explicit runtime updates, reconciliation, organization deletion, Workspace
backups, and cost jobs. It does not coordinate production delivery and carries
no candidate, release, approval, lease, or database-heartbeat contract.

The `production-fly.yml` workflow builds and smokes this role only when one of
its catalog-declared inputs changes. Configuration is selected from Vercel
Production by the `control-worker` role contract; Fly platform authority stays
on the owning Fly application. `CRON_SECRET` remains Web-only.

Readiness is provider-native. The process binds its private health port, returns
503 until configuration, database access, and lifecycle queue registration are
ready, and becomes unhealthy again during graceful shutdown. Production deploys
use immutable image digests and restore the prior digest if Machine identity or
the private health check fails.
