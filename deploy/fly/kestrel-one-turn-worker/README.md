# Kestrel One durable turn worker

This private, non-HTTP Fly process owns durable Kestrel One turn execution. Web and mobile requests only commit work to Postgres and pg-boss; disconnecting either client does not cancel the worker-owned runner stream.

Deploy the web migration containing `0023_durable_thread_turns` before starting this process. Provide the same database, hosted Environment, gateway, MCP, and Kestrel One application environment variables used by `apps/web`. At minimum the worker requires `POSTGRES_URL` or `DATABASE_URL`, `KESTREL_ONE_APP_URL`, hosted Environment signing keys, and the configured model gateway credentials.

The process handles `SIGTERM` gracefully and gives active pg-boss work up to 30 seconds to settle. A production rollout must keep at least one worker machine running and alert on process restarts, queued-turn age, failed turns, and an active queue record whose Turn remains queued without a pg-boss job.
