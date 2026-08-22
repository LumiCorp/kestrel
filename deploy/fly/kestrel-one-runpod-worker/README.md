# Kestrel One managed RunPod worker

This private, non-HTTP Fly process is the sole owner of managed RunPod
qualification, provisioning, retry, reconciliation, deletion, and usage jobs.
Vercel functions only commit jobs to pg-boss and never register these workers.

Keep at least one machine running with auto-stop disabled. Configure the same
production Postgres URL and gateway credential encryption keys as Kestrel One,
plus `RUNPOD_API_KEY` and `RUNPOD_MANAGED_DEPLOYMENTS_ENABLED=true` as Fly
secrets. Deploy the schema reconciliation and inference expansion before
starting this process.

Publish this worker locally with `pnpm production:image:publish`, then update
one exact Fly Machine with `pnpm production:fly:machine`. No production push
deploys this worker or changes a managed RunPod profile. Follow the
[managed RunPod-worker rollout](./ROLLOUT.md) for Web and migration ordering,
provider-spend boundaries, started-before-stopped Machine updates, live work
proof, and rollback.

Readiness is provider-native. The process returns 503 until database access,
worker registration, schedules, and initial queued-run recovery succeed. The
image smoke checks missing configuration only; production readiness, provider
provenance, and an authorized managed RunPod work path require separate proof.
