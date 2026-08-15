# Kestrel One durable turn worker

This private, non-HTTP Fly process owns durable Kestrel One turn execution only.
Hosted Environment lifecycle work, reconciliation, deletion, and Workspace
backups belong to `kestrel-one-control-worker`. Web and mobile requests only
commit turns to Postgres and pg-boss;
disconnecting either client does not cancel worker-owned work.

Deploy the web migrations before starting this process. Provide the database,
gateway, MCP, and Kestrel One application environment variables used by durable
turn execution. Hosted Environment, backup-encryption, object-storage, and Fly
lifecycle credentials belong on the control worker instead.

The process handles `SIGTERM` gracefully and gives active pg-boss work up to 30
seconds to settle. A production rollout must keep at least one worker machine
running and alert on process restarts, queued-turn age, failed turns, and active
database work without a pg-boss job.

## Production deployment

`production-fly.yml` selects this worker only when a catalog-declared input
changes. It stages the exact role configuration from Vercel Production with:

```bash
pnpm --dir apps/web sync:worker-config -- --role turn-worker
```

It selects only the declared turn-worker contract, stages exact sets and known
removals without restarting Machines, verifies the secret-name inventory, and
never prints values. Deploying the corresponding exact image digest activates
the staged configuration. The deployment completes only after every Machine
reports that digest and its private Fly health check is ready.
