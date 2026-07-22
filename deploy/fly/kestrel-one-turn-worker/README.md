# Kestrel One durable turn worker

This private, non-HTTP Fly process owns durable Kestrel One turn execution and hosted Environment lifecycle work, including Workspace backups. Web and mobile requests only commit work to Postgres and pg-boss; disconnecting either client does not cancel worker-owned work.

Deploy the web migrations before starting this process. Provide the same database, hosted Environment, gateway, MCP, backup-encryption, and Kestrel One application environment variables used by `apps/web`. At minimum the worker requires `POSTGRES_URL` or `DATABASE_URL`, `KESTREL_ONE_APP_URL`, `FLY_API_TOKEN`, `KESTREL_FLY_ORGANIZATION_SLUG`, immutable Workspace and router image digests, hosted Environment signing keys, `KESTREL_WORKSPACE_BACKUP_KEY`, `KESTREL_WORKSPACE_BACKUP_KEY_ID`, the configured object-storage credentials, and model gateway credentials.

The process handles `SIGTERM` gracefully and gives active pg-boss work up to 30 seconds to settle. A production rollout must keep at least one worker machine running and alert on process restarts, queued-turn age, failed turns or backups, and active database work without a pg-boss job.
