# Kestrel One durable turn worker

This private, non-HTTP Fly process owns durable Kestrel One turn execution only.
Hosted Environment lifecycle work, releases, reconciliation, deletion, and
Workspace backups belong to `kestrel-one-control-worker` on revision-fenced
queues. Web and mobile requests only commit turns to Postgres and pg-boss;
disconnecting either client does not cancel worker-owned work.

Deploy the web migrations before starting this process. Provide the database,
gateway, MCP, and Kestrel One application environment variables used by durable
turn execution. Hosted Environment, backup-encryption, object-storage, and Fly
lifecycle credentials belong on the control worker instead.

The process handles `SIGTERM` gracefully and gives active pg-boss work up to 30
seconds to settle. A production rollout must keep at least one worker machine
running and alert on process restarts, queued-turn age, failed turns, and active
database work without a pg-boss job.

## Production release gate

The coordinated release owns this worker's image. Before approving a candidate,
stage the exact role configuration from `apps/web`:

```bash
pnpm stage:turn-worker-config -- --release <release-id>
```

It selects only the declared turn-worker contract, stages exact sets and known
removals without restarting Machines, verifies the secret-name inventory, and
binds the operation to the candidate configuration fingerprint. A release
Machine update activates the staged configuration. The target completes only
after the expected revision and fingerprint report a fresh database heartbeat.
Do not run this command from pull-request CI.
