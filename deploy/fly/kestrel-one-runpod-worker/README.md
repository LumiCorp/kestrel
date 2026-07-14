# Kestrel One managed RunPod worker

This private, non-HTTP Fly process is the sole owner of managed RunPod
qualification, provisioning, retry, reconciliation, deletion, and usage jobs.
Vercel functions only commit jobs to pg-boss and never register these workers.

Keep at least one machine running with auto-stop disabled. Configure the same
production Postgres URL and gateway credential encryption keys as Kestrel One,
plus `RUNPOD_API_KEY` and `RUNPOD_MANAGED_DEPLOYMENTS_ENABLED=true` as Fly
secrets. Deploy the schema reconciliation and inference expansion before
starting this process.
