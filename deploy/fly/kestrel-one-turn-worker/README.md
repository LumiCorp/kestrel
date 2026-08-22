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

Publish this worker locally with `pnpm production:image:publish`, then update
one exact Machine with `pnpm production:fly:machine`. The image command does not
stage configuration, and another Machine requires another explicit command and
confirmation. Follow the [turn-worker rollout](./ROLLOUT.md) for Web and
migration ordering, capacity preservation, started-before-stopped Machine
updates, durable turn proof, and rollback.

Readiness is provider-native. The process returns 503 until database and gateway
credential checks pass, workers are registered, and initial maintenance
succeeds. The image smoke checks missing configuration only; production
readiness and a completed durable turn must be verified after each rollout.
