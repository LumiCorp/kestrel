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

Vercel production is the canonical source for the gateway credential keyring.
Before deploying any change to this worker—or any change that rotates or
depends on gateway credential keys—run this command from `apps/web`:

```bash
pnpm release:turn-worker
```

It copies only the configured keyring values from Vercel production to
`kestrel-one-turn-worker`, restarts the worker through Fly secret deployment,
compares the active key ID, sorted configured key IDs, and a non-secret
fingerprint, then deploys the worker image. If synchronization or parity
verification fails, it stops before the image deployment.

Use `pnpm sync:turn-worker-keyring -- --verify` for the read-only production
parity check. Do not run either command from pull-request CI: the release owner
runs the release command after review and approval.
